// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Account visibility enforced by the database alone (docs/design/accounts-and-visibility.md §3):
 * every member × every kind of account, with forged contexts and no application code.
 */

type Actor = 'A' | 'B' | 'C' | 'V';
type Level = 'owner' | 'full' | 'view_only' | 'balance_only';
const VISIBILITIES = ['full', 'view_only', 'balance_only', 'private'] as const;
const OWNER_SETS: Record<string, Actor[]> = {
  personalA: ['A'],
  jointAB: ['A', 'B'],
  jointABC: ['A', 'B', 'C'],
};

const H = randomUUID(); // the household under test
const X = randomUUID(); // another household
const people = Object.fromEntries(
  (['A', 'B', 'C', 'V', 'Z'] as const).map((k) => [
    k,
    { user: randomUUID(), member: randomUUID() },
  ]),
) as Record<Actor | 'Z', { user: string; member: string }>;
const ROLES: Record<Actor, string> = { A: 'owner', B: 'member', C: 'member', V: 'viewer' };

interface Fixture {
  id: string;
  owners: Actor[];
  visibility: (typeof VISIBILITIES)[number];
}
const fixtures: Fixture[] = Object.values(OWNER_SETS).flatMap((owners) =>
  VISIBILITIES.map((visibility) => ({ id: randomUUID(), owners, visibility })),
);

/** The permissions matrix §3, written independently of the SQL under test. */
function expectedLevel(actor: Actor, f: Fixture): Level | undefined {
  if (f.owners.includes(actor)) return 'owner';
  return f.visibility === 'private' ? undefined : f.visibility;
}

describe('account visibility (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;

  /** As fiscus_app; or as fiscus_worker, the only role system context works for (#376). */
  async function as<T>(
    ctx: { household?: string; member?: string; user?: string; system?: boolean },
    fn: (q: pg.Client) => Promise<T>,
    client: 'app' | 'worker' = ctx.system ? 'worker' : 'app',
  ): Promise<T> {
    const c = client === 'worker' ? worker : app;
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [ctx.household ?? '', ctx.member ?? '', ctx.user ?? '', ctx.system ? 'on' : 'off'],
      );
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  }
  const asMember = <T>(
    a: Actor | 'Z',
    fn: (q: pg.Client) => Promise<T>,
    household = a === 'Z' ? X : H,
  ) => as({ household, member: people[a].member, user: people[a].user }, fn);

  /** Runs statements as `a` and commits, so deferred checks run. Returns the error, if any. */
  async function commitAs(a: Actor, sqlText: string, params: unknown[] = []) {
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true)`,
        [H, people[a].member, people[a].user],
      );
      await app.query(sqlText, params);
      await app.query('COMMIT');
      return undefined;
    } catch (err) {
      await app.query('ROLLBACK');
      return err as pg.DatabaseError;
    }
  }

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    worker = new pg.Client({ connectionString: tdb.workerUrl });
    await Promise.all([owner.connect(), app.connect(), worker.connect()]);

    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC'), ($2, 'X', 'USD', 'UTC')`,
      [H, X],
    );
    for (const [k, p] of Object.entries(people)) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k.toLowerCase()}-${p.user}@accounts.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, $5, '#000')`,
        [p.member, k === 'Z' ? X : H, p.user, k === 'Z' ? 'owner' : ROLES[k as Actor], k],
      );
    }
    for (const f of fixtures) {
      const shares = f.owners.map((_, i) =>
        i === 0
          ? 10000 - Math.floor(10000 / f.owners.length) * (f.owners.length - 1)
          : Math.floor(10000 / f.owners.length),
      );
      await owner.query('BEGIN');
      await owner.query(
        `INSERT INTO accounts (id, household_id, name, type, currency, visibility, balance_mode)
         VALUES ($1, $2, $3, 'depository', 'USD', $4, 'transactions')`,
        [f.id, H, `${f.owners.join('')}-${f.visibility}`, f.visibility],
      );
      for (const [i, o] of f.owners.entries()) {
        await owner.query(
          `INSERT INTO account_owners (account_id, member_id, household_id, share_bps) VALUES ($1, $2, $3, $4)`,
          [f.id, people[o].member, H, shares[i]],
        );
      }
      await owner.query(
        `INSERT INTO balance_snapshots (account_id, as_of, household_id, balance_minor, source)
         SELECT $1, d::date, $2, 100, 'manual' FROM generate_series('2026-01-01'::date, '2026-03-31', '1 day') d`,
        [f.id, H],
      );
      await owner.query(
        `INSERT INTO account_liabilities (account_id, household_id, apr_bps) VALUES ($1, $2, 2149)`,
        [f.id, H],
      );
      await owner.query(
        `INSERT INTO audit_events (actor_kind, household_id, action, account_id) VALUES ('system', $1, 'account.created', $2)`,
        [H, f.id],
      );
      await owner.query('COMMIT');
    }
    await owner.query(
      `INSERT INTO audit_events (actor_kind, household_id, action) VALUES ('system', $1, 'household.updated')`,
      [H],
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
    await tdb?.stop();
  });

  describe.each(['A', 'B', 'C', 'V'] as const)('member %s', (actor) => {
    const expected = new Map(
      fixtures.flatMap((f) => {
        const level = expectedLevel(actor, f);
        return level ? [[f.id, level] as const] : [];
      }),
    );

    it('gets exactly the expected level for every account', async () => {
      const rows = await asMember(
        actor,
        async (q) => (await q.query('SELECT account_id, level FROM fiscus_account_access()')).rows,
      );
      expect(new Map(rows.map((r) => [r.account_id, r.level]))).toEqual(expected);
    });

    it('sees only visible accounts, their owners, balances, and events', async () => {
      await asMember(actor, async (q) => {
        const ids = async (sqlText: string) =>
          new Set((await q.query(sqlText)).rows.map((r) => r.id as string));
        const visible = new Set(expected.keys());
        expect(await ids('SELECT id FROM accounts')).toEqual(visible);
        expect(await ids('SELECT DISTINCT account_id AS id FROM account_owners')).toEqual(visible);
        expect(await ids('SELECT DISTINCT account_id AS id FROM balance_snapshots')).toEqual(
          visible,
        );
        expect(
          await ids('SELECT account_id AS id FROM audit_events WHERE account_id IS NOT NULL'),
        ).toEqual(visible);
        // Events about no account are visible to everyone.
        expect(
          (await q.query(`SELECT 1 FROM audit_events WHERE action = 'household.updated'`)).rowCount,
        ).toBe(1);
      });
    });

    it('changes only accounts it owns', async () => {
      await asMember(actor, async (q) => {
        const updated = await q.query(
          `UPDATE accounts SET sort_order = sort_order + 1 RETURNING id`,
        );
        const owned = fixtures.filter((f) => f.owners.includes(actor)).map((f) => f.id);
        expect(new Set(updated.rows.map((r) => r.id))).toEqual(new Set(owned));
        const deleted = await q.query(
          `DELETE FROM balance_snapshots WHERE as_of = '2026-01-01' RETURNING account_id`,
        );
        expect(new Set(deleted.rows.map((r) => r.account_id))).toEqual(new Set(owned));
      });
    });

    it('sees card details only at owner or full access, and changes only its own (#86)', async () => {
      await asMember(actor, async (q) => {
        const seen = (await q.query('SELECT account_id FROM account_liabilities')).rows;
        const detailed = [...expected].filter(([, l]) => l === 'owner' || l === 'full');
        expect(new Set(seen.map((r) => r.account_id))).toEqual(new Set(detailed.map(([id]) => id)));
        const updated = await q.query(
          `UPDATE account_liabilities SET apr_bps = 1999 RETURNING account_id`,
        );
        const owned = fixtures.filter((f) => f.owners.includes(actor)).map((f) => f.id);
        expect(new Set(updated.rows.map((r) => r.account_id))).toEqual(new Set(owned));
        const deleted = await q.query(`DELETE FROM account_liabilities RETURNING account_id`);
        expect(new Set(deleted.rows.map((r) => r.account_id))).toEqual(new Set(owned));
        // Row-level security is checked before the primary key: writing one is refused outright.
        const other = fixtures.find((f) => !f.owners.includes(actor));
        if (!other) return; // A owns every account here
        await expect(
          q.query(
            `INSERT INTO account_liabilities (account_id, household_id, apr_bps) VALUES ($1, $2, 1)`,
            [other.id, H],
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });
  });

  it('shows nothing to another household, to forged contexts, or without context', async () => {
    const counts = async (fn: (q: pg.Client) => Promise<number>) => fn(app);
    await asMember('Z', async (q) => {
      expect((await q.query('SELECT 1 FROM accounts')).rowCount).toBe(0);
    });
    // Z claims household H: not a member, so the context is invalid.
    await asMember(
      'Z',
      async (q) => {
        expect((await q.query('SELECT 1 FROM accounts')).rowCount).toBe(0);
        expect((await q.query('SELECT 1 FROM fiscus_account_access()')).rowCount).toBe(0);
      },
      H,
    );
    // A's member id with B's user id.
    await as({ household: H, member: people.A.member, user: people.B.user }, async (q) => {
      expect((await q.query('SELECT 1 FROM accounts')).rowCount).toBe(0);
    });
    await as({}, async (q) => {
      expect((await q.query('SELECT 1 FROM accounts')).rowCount).toBe(0);
      expect((await q.query('SELECT 1 FROM balance_snapshots')).rowCount).toBe(0);
      expect((await q.query('SELECT 1 FROM account_liabilities')).rowCount).toBe(0);
    });
    void counts;
  });

  it('shows everything to the household system context', async () => {
    await as({ household: H, system: true }, async (q) => {
      expect((await q.query('SELECT 1 FROM accounts')).rowCount).toBe(fixtures.length);
      const levels = (await q.query('SELECT DISTINCT level FROM fiscus_account_access()')).rows;
      expect(levels).toEqual([{ level: 'owner' }]);
    });
  });

  it('ignores system context from the app role (#376)', async () => {
    await as(
      { household: H, system: true },
      async (q) => {
        expect((await q.query('SELECT 1 FROM accounts')).rowCount).toBe(0);
        expect((await q.query('SELECT 1 FROM fiscus_account_access()')).rowCount).toBe(0);
      },
      'app',
    );
  });

  it('evaluates access once per statement, not once per row', async () => {
    await asMember('A', async (q) => {
      const [{ 'QUERY PLAN': plan }] = (
        await q.query('EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM balance_snapshots')
      ).rows;
      const calls: number[] = [];
      const walk = (node: Record<string, unknown>) => {
        if (node['Function Name'] === 'fiscus_account_access')
          calls.push(node['Actual Loops'] as number);
        for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
          walk(child);
      };
      walk(plan[0].Plan);
      // Each use is a hashed subplan: computed at most once, then probed per row.
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((loops) => loops <= 1)).toBe(true);
    });
  });

  describe('ownership rules', () => {
    const newAccount = (id: string) =>
      `INSERT INTO accounts (id, household_id, name, type, currency, visibility, balance_mode)
       VALUES ('${id}', '${H}', 'New', 'depository', 'USD', 'private', 'transactions');`;
    const owner = (account: string, who: Actor | 'Z', bps: number, household = H) =>
      `INSERT INTO account_owners (account_id, member_id, household_id, share_bps)
       VALUES ('${account}', '${people[who].member}', '${household}', ${bps});`;

    it('lets a member create an account and become its owner', async () => {
      const id = randomUUID();
      expect(await commitAs('B', newAccount(id) + owner(id, 'B', 10000))).toBeUndefined();
      await asMember('B', async (q) => {
        expect(
          (await q.query(`SELECT level FROM fiscus_account_access() WHERE account_id = $1`, [id]))
            .rows,
        ).toEqual([{ level: 'owner' }]);
      });
      await asMember('A', async (q) => {
        expect((await q.query(`SELECT 1 FROM accounts WHERE id = $1`, [id])).rowCount).toBe(0); // private
      });
    });

    it('rejects an account without owners, or with shares that do not sum to 100%', async () => {
      const a = randomUUID();
      expect((await commitAs('A', newAccount(a)))?.constraint).toBe('account_owners_required');
      const b = randomUUID();
      expect(
        (await commitAs('A', newAccount(b) + owner(b, 'A', 6000) + owner(b, 'B', 3000)))
          ?.constraint,
      ).toBe('account_owners_total');
    });

    it('lets owners replace shares across statements, checked at commit', async () => {
      const id = fixtures.find((f) => f.owners.join('') === 'AB' && f.visibility === 'full')!.id;
      const err = await commitAs(
        'A',
        `UPDATE account_owners SET share_bps = 7000 WHERE account_id = '${id}' AND member_id = '${people.A.member}';
         UPDATE account_owners SET share_bps = 3000 WHERE account_id = '${id}' AND member_id = '${people.B.member}';`,
      );
      expect(err).toBeUndefined();
    });

    it('rejects viewers and other households as owners', async () => {
      const a = randomUUID();
      expect((await commitAs('A', newAccount(a) + owner(a, 'V', 10000)))?.constraint).toBe(
        'account_owners_member',
      );
      const b = randomUUID();
      const err = await commitAs('A', newAccount(b) + owner(b, 'Z', 10000));
      expect(err?.code).toBe('23503'); // composite foreign key: Z is not a member of H
    });

    it("doesn't let a non-owner take over an existing account", async () => {
      const id = fixtures.find((f) => f.owners.join('') === 'A' && f.visibility === 'full')!.id;
      const err = await commitAs('B', owner(id, 'B', 1));
      expect(err?.message).toMatch(/row-level security/);
      const removed = await asMember(
        'B',
        async (q) =>
          (await q.query(`DELETE FROM account_owners WHERE account_id = $1`, [id])).rowCount,
      );
      expect(removed).toBe(0);
    });

    it('keeps an account owner from becoming a viewer or leaving', async () => {
      const toViewer = await commitAs(
        'A',
        `UPDATE household_members SET role = 'viewer' WHERE id = '${people.B.member}'`,
      );
      expect(toViewer?.constraint).toBe('household_members_owns_accounts');
      const leave = await commitAs(
        'C',
        `UPDATE household_members SET left_at = now() WHERE id = '${people.C.member}'`,
      );
      expect(leave?.constraint).toBe('household_members_owns_accounts');
    });
  });
});
