// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Transaction visibility enforced by the database alone (docs/design/transactions.md): account
 * levels, the attribution path (F1), private notes, and the split and attribution invariants.
 * Forged contexts, no application code.
 */

type Actor = 'A' | 'B' | 'C' | 'V';
const VISIBILITIES = ['full', 'view_only', 'balance_only', 'private'] as const;
const H = randomUUID();
const X = randomUUID();
const people = Object.fromEntries(
  (['A', 'B', 'C', 'V', 'Z'] as const).map((k) => [
    k,
    { user: randomUUID(), member: randomUUID() },
  ]),
) as Record<Actor | 'Z', { user: string; member: string }>;
const ROLES: Record<Actor, string> = { A: 'owner', B: 'member', C: 'member', V: 'viewer' };
/** C joined in June; an account shared with C still shows its whole history (ADR 0012). */
const JOINED: Record<Actor, string> = {
  A: '2025-01-01',
  B: '2025-01-01',
  C: '2026-06-01',
  V: '2025-01-01',
};

interface Account {
  id: string;
  owners: Actor[];
  visibility: (typeof VISIBILITIES)[number];
}
interface Txn {
  id: string;
  account: Account;
  date: string;
  attributedTo?: Actor;
}
const accounts: Account[] = [
  ...VISIBILITIES.map((visibility) => ({ id: randomUUID(), owners: ['A'] as Actor[], visibility })),
  { id: randomUUID(), owners: ['A', 'C'], visibility: 'view_only' },
];
const txns: Txn[] = accounts.flatMap((account) =>
  ['2026-01-15', '2026-07-01'].map((date) => ({ id: randomUUID(), account, date })),
);
// A purchase on A's private card, attributed to B ("for Bea"): shared with B, account hidden.
const forB: Txn = {
  id: randomUUID(),
  account: accounts[3]!,
  date: '2026-01-15',
  attributedTo: 'B',
};
txns.push(forB);

function visibleTo(actor: Actor, t: Txn): boolean {
  if (t.account.owners.includes(actor)) return true;
  if (t.attributedTo === actor) return true;
  const v = t.account.visibility;
  return v === 'full' || v === 'view_only';
}

describe('transaction visibility (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;

  async function as<T>(
    ctx: { household?: string; member?: string; user?: string; system?: boolean },
    fn: (q: pg.Client) => Promise<T>,
    commit = false,
  ): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [ctx.household ?? '', ctx.member ?? '', ctx.user ?? '', ctx.system ? 'on' : 'off'],
      );
      const result = await fn(app);
      await app.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (err) {
      await app.query('ROLLBACK');
      throw err;
    }
  }
  const asMember = <T>(a: Actor, fn: (q: pg.Client) => Promise<T>, commit = false) =>
    as({ household: H, member: people[a].member, user: people[a].user }, fn, commit);
  const errorOf = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return err as pg.DatabaseError;
    }
  };

  let uncategorized = '';

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    await Promise.all([owner.connect(), app.connect()]);
    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC'), ($2, 'X', 'USD', 'UTC')`,
      [H, X],
    );
    for (const [k, p] of Object.entries(people)) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k}-${p.user}@ledger.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color, joined_at)
         VALUES ($1, $2, $3, $4, $5, '#000', $6)`,
        [
          p.member,
          k === 'Z' ? X : H,
          p.user,
          k === 'Z' ? 'owner' : ROLES[k as Actor],
          k,
          k === 'Z' ? '2025-01-01' : JOINED[k as Actor],
        ],
      );
    }
    await owner.query(
      `SELECT fiscus_seed_default_categories($1), fiscus_seed_default_categories($2)`,
      [H, X],
    );
    uncategorized = (
      await owner.query(
        `SELECT id FROM categories WHERE household_id = $1 AND system_key = 'uncategorized'`,
        [H],
      )
    ).rows[0].id;

    for (const a of accounts) {
      await owner.query('BEGIN');
      await owner.query(
        `INSERT INTO accounts (id, household_id, name, type, currency, visibility, balance_mode)
         VALUES ($1, $2, 'acct', 'depository', 'USD', $3, 'transactions')`,
        [a.id, H, a.visibility],
      );
      for (const [i, o] of a.owners.entries()) {
        await owner.query(
          `INSERT INTO account_owners (account_id, member_id, household_id, share_bps) VALUES ($1, $2, $3, $4)`,
          [a.id, people[o].member, H, i === 0 ? 10000 - 5000 * (a.owners.length - 1) : 5000],
        );
      }
      await owner.query('COMMIT');
    }
    for (const t of txns) {
      await owner.query(
        `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, authorized_date,
           original_description, display_name, source, category_id)
         VALUES ($1, $2, $3, -1000, 'USD', $4, 'desc', 'name', 'manual', $5)`,
        [t.id, H, t.account.id, t.date, uncategorized],
      );
      if (t.attributedTo) {
        await owner.query(
          `INSERT INTO transaction_attributions (transaction_id, member_id, household_id, share_bps) VALUES ($1, $2, $3, 10000)`,
          [t.id, people[t.attributedTo].member, H],
        );
      }
      // A shared note and A's private note on every transaction.
      await owner.query(
        `INSERT INTO transaction_notes (id, household_id, transaction_id, author_member_id, body_enc, updated_by_member_id)
         VALUES (gen_random_uuid(), $1, $2, NULL, '\\x00', $3), (gen_random_uuid(), $1, $2, $3, '\\x00', $3)`,
        [H, t.id, people.A.member],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
    await tdb?.stop();
  });

  it('seeds the default categories once per household', async () => {
    const { rows } = await owner.query(
      `SELECT count(DISTINCT g.id)::int AS groups, count(c.id)::int AS cats,
              array_agg(c.system_key ORDER BY c.system_key) FILTER (WHERE c.system_key IS NOT NULL) AS keys
       FROM category_groups g JOIN categories c ON c.group_id = g.id WHERE g.household_id = $1`,
      [H],
    );
    expect(rows[0]).toEqual({
      groups: 14,
      cats: 42,
      keys: ['settlement', 'transfer', 'uncategorized'],
    });
    await owner.query(`SELECT fiscus_seed_default_categories($1)`, [H]); // idempotent
    expect(
      (await owner.query(`SELECT 1 FROM categories WHERE household_id = $1`, [H])).rowCount,
    ).toBe(42);
  });

  describe.each(['A', 'B', 'C', 'V'] as const)('member %s', (actor) => {
    const expected = new Set(txns.filter((t) => visibleTo(actor, t)).map((t) => t.id));

    it('sees exactly the transactions its account access and attributions allow', async () => {
      await asMember(actor, async (q) => {
        const ids = async (sqlText: string) =>
          new Set((await q.query(sqlText)).rows.map((r) => r.id));
        expect(await ids('SELECT id FROM transactions')).toEqual(expected);
        expect(
          await ids(
            'SELECT DISTINCT transaction_id AS id FROM transaction_notes WHERE author_member_id IS NULL',
          ),
        ).toEqual(expected);
      });
    });

    it("never sees another member's private notes", async () => {
      await asMember(actor, async (q) => {
        const { rows } = await q.query(
          'SELECT author_member_id FROM transaction_notes WHERE author_member_id IS NOT NULL',
        );
        expect(rows.every((r) => r.author_member_id === people[actor].member)).toBe(true);
        if (actor !== 'A') expect(rows).toEqual([]);
      });
    });

    it('can categorize only on accounts it owns or has full access to', async () => {
      await asMember(actor, async (q) => {
        const { rows } = await q.query(
          `UPDATE transactions SET review_status = 'reviewed' RETURNING id`,
        );
        const allowed = txns.filter(
          (t) => t.account.owners.includes(actor) || t.account.visibility === 'full',
        );
        expect(new Set(rows.map((r) => r.id))).toEqual(new Set(allowed.map((t) => t.id)));
      });
    });
  });

  it('shares an attributed purchase without revealing its account', async () => {
    await asMember('B', async (q) => {
      expect(
        (await q.query('SELECT account_id FROM transactions WHERE id = $1', [forB.id])).rows,
      ).toEqual([{ account_id: forB.account.id }]);
      // The account row itself stays invisible; the API must not serialize account_id (F1).
      expect(
        (await q.query('SELECT 1 FROM accounts WHERE id = $1', [forB.account.id])).rowCount,
      ).toBe(0);
      expect(
        (
          await q.query(
            'SELECT member_id FROM transaction_attributions WHERE transaction_id = $1',
            [forB.id],
          )
        ).rows,
      ).toEqual([{ member_id: people.B.member }]);
      // "Paid by A": payers of attributed purchases, as people, never as an account.
      const payers = await q.query(
        'SELECT transaction_id, member_id FROM fiscus_attributed_payers()',
      );
      expect(payers.rows).toEqual([{ transaction_id: forB.id, member_id: people.A.member }]);
    });
  });

  it('keeps member preferences private to their member', async () => {
    await owner.query(
      `INSERT INTO member_preferences (household_id, member_id, key, value) VALUES ($1, $2, 'range:reports', '"last_6m"')`,
      [H, people.A.member],
    );
    await asMember('A', async (q) => {
      expect((await q.query('SELECT value FROM member_preferences')).rows).toEqual([
        { value: 'last_6m' },
      ]);
    });
    await asMember('B', async (q) => {
      expect((await q.query('SELECT 1 FROM member_preferences')).rowCount).toBe(0);
      const err = await errorOf(() =>
        q.query(
          `INSERT INTO member_preferences (household_id, member_id, key, value) VALUES ($1, $2, 'x', '1')`,
          [H, people.A.member],
        ),
      );
      expect(err?.message).toMatch(/row-level security/);
    });
  });

  it('keeps a member’s account layout private to them, and cleans it up (#48)', async () => {
    const acct = accounts[0]!.id;
    const group = randomUUID();
    await owner.query(
      `INSERT INTO account_groups (id, household_id, member_id, name, sort_order) VALUES ($1, $2, $3, 'Everyday', 0)`,
      [group, H, people.A.member],
    );
    await owner.query(
      `INSERT INTO account_placements (household_id, member_id, account_id, group_id, sort_order) VALUES ($1, $2, $3, $4, 0)`,
      [H, people.A.member, acct, group],
    );
    await asMember('A', async (q) => {
      expect((await q.query('SELECT name FROM account_groups')).rows).toEqual([
        { name: 'Everyday' },
      ]);
      expect((await q.query('SELECT 1 FROM account_placements')).rowCount).toBe(1);
    });
    await asMember('B', async (q) => {
      expect((await q.query('SELECT 1 FROM account_groups')).rowCount).toBe(0);
      expect((await q.query('SELECT 1 FROM account_placements')).rowCount).toBe(0);
      const err = await errorOf(() =>
        q.query(
          `INSERT INTO account_groups (id, household_id, member_id, name, sort_order) VALUES ($1, $2, $3, 'Mine', 0)`,
          [randomUUID(), H, people.A.member],
        ),
      );
      expect(err?.message).toMatch(/row-level security/);
    });
    // Nobody else's group: B can't place an account in A's.
    const crossed = await errorOf(() =>
      owner.query(
        `INSERT INTO account_placements (household_id, member_id, account_id, group_id, sort_order) VALUES ($1, $2, $3, $4, 0)`,
        [H, people.B.member, acct, group],
      ),
    );
    expect(crossed?.message).toMatch(/account_placements_group_fk/);

    // Deleting the group sends the account back to its type's section, keeping its place.
    await owner.query('DELETE FROM account_groups WHERE id = $1', [group]);
    expect(
      (
        await owner.query(
          'SELECT group_id, sort_order FROM account_placements WHERE account_id = $1',
          [acct],
        )
      ).rows,
    ).toEqual([{ group_id: null, sort_order: 0 }]);
    await owner.query('DELETE FROM account_placements WHERE account_id = $1', [acct]);
  });

  it('dates transactions by the authorized date when the household prefers it (#69)', async () => {
    const { rows } = await owner.query(
      `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, authorized_date, posted_date,
         original_description, display_name, source)
       VALUES (gen_random_uuid(), $1, $2, -100, 'USD', '2026-07-30', '2026-08-02', 'x', 'x', 'import')
       RETURNING effective_date::text AS posted, effective_authorized_date::text AS authorized`,
      [H, accounts[0]!.id],
    );
    expect(rows[0]).toEqual({ posted: '2026-08-02', authorized: '2026-07-30' });
  });

  it('shows nothing to another household or without context', async () => {
    await as({ household: X, member: people.Z.member, user: people.Z.user }, async (q) => {
      expect((await q.query('SELECT 1 FROM transactions')).rowCount).toBe(0);
      expect(
        (await q.query('SELECT 1 FROM categories WHERE household_id = $1', [H])).rowCount,
      ).toBe(0);
    });
    await as({}, async (q) => {
      expect((await q.query('SELECT 1 FROM transactions')).rowCount).toBe(0);
    });
  });

  it('keeps writes to the paying account’s owners', async () => {
    const acct = accounts[0]!; // A's full account
    const insert = (q: pg.Client) =>
      q.query(
        `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, authorized_date,
           original_description, display_name, source) VALUES ($1, $2, $3, 100, 'USD', '2026-08-01', 'x', 'x', 'manual')`,
        [randomUUID(), H, acct.id],
      );
    expect(await errorOf(() => asMember('B', insert))).toMatchObject({
      message: expect.stringMatching(/row-level security/),
    });
    expect(await errorOf(() => asMember('A', insert))).toBeUndefined();
    const attribute = (q: pg.Client) =>
      q.query(
        `INSERT INTO transaction_attributions (transaction_id, member_id, household_id, share_bps) VALUES ($1, $2, $3, 10000)`,
        [txns[0]!.id, people.B.member, H],
      );
    expect(await errorOf(() => asMember('B', attribute))).toMatchObject({
      message: expect.stringMatching(/row-level security/),
    });
  });

  describe('invariants (checked at commit)', () => {
    const acct = accounts[0]!;
    const txn = (id: string, amount: number, parent?: string, split = false) =>
      `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, authorized_date,
         original_description, display_name, source, parent_id, has_splits)
       VALUES ('${id}', '${H}', '${acct.id}', ${amount}, 'USD', '2026-08-02', 'x', 'x', 'manual', ${parent ? `'${parent}'` : 'NULL'}, ${split});`;

    it('refuses posted transactions of $0, but allows a pending $0 hold', async () => {
      const zero = (pending: boolean) =>
        errorOf(() =>
          asMember('A', (q) =>
            q.query(
              `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, authorized_date,
                 original_description, display_name, source, pending)
               VALUES ($1, $2, $3, 0, 'USD', '2026-08-03', 'x', 'x', 'manual', $4)`,
              [randomUUID(), H, acct.id, pending],
            ),
          ),
        );
      expect((await zero(false))?.constraint).toBe('transactions_nonzero');
      expect(await zero(true)).toBeUndefined();
    });

    it('requires attribution shares to sum to 100%', async () => {
      const err = await errorOf(() =>
        asMember(
          'A',
          (q) =>
            q.query(
              `INSERT INTO transaction_attributions (transaction_id, member_id, household_id, share_bps)
             VALUES ($1, $2, $3, 6000)`,
              [txns[0]!.id, people.B.member, H],
            ),
          true,
        ),
      );
      expect(err?.constraint).toBe('transaction_attributions_total');
    });

    it('requires split parts to add up to the whole, on the same account', async () => {
      const parent = randomUUID();
      const ok = await errorOf(() =>
        asMember(
          'A',
          (q) =>
            q.query(
              txn(parent, -5000, undefined, true) +
                txn(randomUUID(), -3000, parent) +
                txn(randomUUID(), -2000, parent),
            ),
          true,
        ),
      );
      expect(ok).toBeUndefined();
      const bad = randomUUID();
      const err = await errorOf(() =>
        asMember(
          'A',
          (q) =>
            q.query(
              txn(bad, -5000, undefined, true) +
                txn(randomUUID(), -3000, bad) +
                txn(randomUUID(), -1000, bad),
            ),
          true,
        ),
      );
      expect(err?.constraint).toBe('transactions_split_total');
      const unmarked = randomUUID();
      const err2 = await errorOf(() =>
        asMember(
          'A',
          (q) => q.query(txn(unmarked, -5000) + txn(randomUUID(), -5000, unmarked)),
          true,
        ),
      );
      expect(err2?.constraint).toBe('transactions_split_parent');
    });
  });
});
