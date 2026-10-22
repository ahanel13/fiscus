// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Rules of your own under row-level security (#58, permissions RULE-02/04/07), with no application
 * code: who sees and changes a member's rules, the other owners' rules for a joint account
 * (fiscus_owner_rules()), and a member's rules going when they leave.
 */

type Actor = 'A' | 'B' | 'C' | 'V';
const H = randomUUID();
const ROLES: Record<Actor, string> = { A: 'owner', B: 'member', C: 'member', V: 'viewer' };
const people = Object.fromEntries(
  (Object.keys(ROLES) as Actor[]).map((k) => [k, { user: randomUUID(), member: randomUUID() }]),
) as Record<Actor, { user: string; member: string }>;
const acct = { joint: randomUUID(), a: randomUUID(), b: randomUUID() };
const rule = {
  household: randomUUID(),
  a: randomUUID(),
  aOff: randomUUID(), // A's, turned off
  b: randomUUID(),
  c: randomUUID(),
};

describe('rules of your own (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;

  async function as<T>(
    ctx: { member?: string; user?: string; system?: boolean },
    fn: (q: pg.Client) => Promise<T>,
  ): Promise<T> {
    const c = ctx.system ? worker : app;
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [H, ctx.member ?? '', ctx.user ?? '', ctx.system ? 'on' : 'off'],
      );
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  }
  const asMember = <T>(a: Actor, fn: (q: pg.Client) => Promise<T>) =>
    as({ member: people[a].member, user: people[a].user }, fn);
  const ids = async (q: pg.Client, sqlText: string, params: unknown[] = []) =>
    new Set((await q.query(sqlText, params)).rows.map((r) => r.id as string));
  const insert = (q: pg.Client, memberId: string | null, author: string) =>
    q.query(
      `INSERT INTO rules (id, household_id, member_id, position, conditions, actions, author_member_id)
       VALUES ($1, $2, $3, 1, '{}', '{}', $4)`,
      [randomUUID(), H, memberId, author],
    );
  const error = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    worker = new pg.Client({ connectionString: tdb.workerUrl });
    await Promise.all([owner.connect(), app.connect(), worker.connect()]);

    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
      [H],
    );
    for (const [k, p] of Object.entries(people)) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k.toLowerCase()}-${p.user}@rules.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, $5, '#000')`,
        [p.member, H, p.user, ROLES[k as Actor], k],
      );
    }
    const accounts: [string, [Actor, number][]][] = [
      [
        acct.joint,
        [
          ['A', 6000],
          ['B', 4000],
        ],
      ],
      [acct.a, [['A', 10000]]],
      [acct.b, [['B', 10000]]],
    ];
    for (const [id, owners] of accounts) {
      await owner.query('BEGIN');
      await owner.query(
        `INSERT INTO accounts (id, household_id, name, type, currency, visibility, balance_mode)
         VALUES ($1, $2, 'acct', 'depository', 'USD', 'full', 'transactions')`,
        [id, H],
      );
      for (const [by, share] of owners) {
        await owner.query(
          `INSERT INTO account_owners (account_id, member_id, household_id, share_bps) VALUES ($1, $2, $3, $4)`,
          [id, people[by].member, H, share],
        );
      }
      await owner.query('COMMIT');
    }
    const rules: [string, Actor | null, Actor, boolean][] = [
      [rule.household, null, 'A', true],
      [rule.a, 'A', 'A', true],
      [rule.aOff, 'A', 'A', false],
      [rule.b, 'B', 'B', true],
      [rule.c, 'C', 'C', true],
    ];
    for (const [id, of, by, enabled] of rules) {
      await owner.query(
        `INSERT INTO rules (id, household_id, member_id, position, enabled, conditions, actions, author_member_id)
         VALUES ($1, $2, $3, 1, $4, '{}', '{}', $5)`,
        [id, H, of ? people[of].member : null, enabled, people[by].member],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
    await tdb?.stop();
  });

  // RULE-01/02: the household's rules, and your own. Written independently of the policy.
  const VISIBLE: Record<Actor, string[]> = {
    A: [rule.household, rule.a, rule.aOff],
    B: [rule.household, rule.b],
    C: [rule.household, rule.c],
    V: [rule.household],
  };

  it.each(Object.keys(VISIBLE) as Actor[])(
    '[RULE-02] shows %s the household’s rules and only their own',
    (a) =>
      asMember(a, async (q) =>
        expect(await ids(q, 'SELECT id FROM rules')).toEqual(new Set(VISIBLE[a])),
      ),
  );

  it('gives the worker every member’s rules, and the app role nothing for system context', async () => {
    await as({ system: true }, async (q) =>
      expect(await ids(q, 'SELECT id FROM rules')).toEqual(new Set(Object.values(rule))),
    );
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.system', 'on', true)`,
        [H],
      );
      expect((await app.query('SELECT 1 FROM rules')).rowCount).toBe(0);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('[RULE-04] lets only their member write a member’s rules', async () => {
    await asMember('A', async (q) => {
      await insert(q, people.A.member, people.A.member);
      expect((await q.query(`UPDATE rules SET name = 'x' WHERE id = $1`, [rule.b])).rowCount).toBe(
        0,
      );
      expect((await q.query(`DELETE FROM rules WHERE id = $1`, [rule.b])).rowCount).toBe(0);
      expect((await q.query(`DELETE FROM rules WHERE id = $1`, [rule.a])).rowCount).toBe(1);
    });
    expect(
      await error(() => asMember('A', (q) => insert(q, people.B.member, people.B.member))),
    ).toMatch(/row-level security/);
    // A rule of your own can't be handed to someone else.
    expect(
      await error(() =>
        asMember('A', (q) =>
          q.query(`UPDATE rules SET member_id = $2 WHERE id = $1`, [rule.aOff, people.B.member]),
        ),
      ),
    ).toMatch(/row-level security|rules_member_author/);
    // A member's rule acts with their own access: its author is them.
    expect(
      await error(() => asMember('B', (q) => insert(q, people.B.member, people.A.member))),
    ).toMatch(/rules_member_author/);
  });

  it("returns the other owners' enabled rules, for accounts you own too", async () => {
    const owned = (a: Actor, accounts: string[]) =>
      asMember(a, (q) =>
        ids(q, 'SELECT id FROM fiscus_owner_rules($1::uuid[])', [`{${accounts.join(',')}}`]),
      );
    expect(await owned('A', [acct.joint])).toEqual(new Set([rule.a, rule.b]));
    expect(await owned('B', [acct.joint])).toEqual(new Set([rule.a, rule.b]));
    expect(await owned('A', [acct.a])).toEqual(new Set([rule.a]));
    // B owns acct.b alone, and C and V own nothing: nobody else's rules come with them.
    expect(await owned('A', [acct.b])).toEqual(new Set());
    expect(await owned('C', [acct.joint, acct.a, acct.b])).toEqual(new Set());
    expect(await owned('V', [acct.joint])).toEqual(new Set());
  });

  it('[RULE-07] deletes a member’s rules when they leave, and keeps the household’s', async () => {
    await owner.query(`UPDATE household_members SET left_at = now() WHERE id = $1`, [
      people.C.member,
    ]);
    await as({ system: true }, async (q) => {
      const left = await ids(q, 'SELECT id FROM rules');
      expect(left.has(rule.c)).toBe(false);
      expect(left.has(rule.household)).toBe(true);
      expect(left.has(rule.b)).toBe(true);
    });
  });
});
