// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Budgets under row-level security (#98, permissions BUD-02/05), with no application code: the
 * household's budget is everyone's, a member's own is theirs alone, the rows under a budget follow
 * it, and a member's budget goes when they leave.
 */

type Actor = 'A' | 'B' | 'C' | 'V';
const H = randomUUID();
const ROLES: Record<Actor, string> = { A: 'owner', B: 'member', C: 'member', V: 'viewer' };
const people = Object.fromEntries(
  (Object.keys(ROLES) as Actor[]).map((k) => [k, { user: randomUUID(), member: randomUUID() }]),
) as Record<Actor, { user: string; member: string }>;
const budget = { ours: randomUUID(), a: randomUUID(), b: randomUUID(), c: randomUUID() };
const groceries = randomUUID();
const MONTH = '2026-10-01';

describe('budgets (RLS)', () => {
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
  const ids = async (q: pg.Client, sqlText: string) =>
    new Set((await q.query(sqlText)).rows.map((r) => r.id as string));
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
        `${k.toLowerCase()}-${p.user}@budgets.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, $5, '#000')`,
        [p.member, H, p.user, ROLES[k as Actor], k],
      );
    }
    const group = randomUUID();
    await owner.query(
      `INSERT INTO category_groups (id, household_id, name, kind) VALUES ($1, $2, 'Food', 'flexible')`,
      [group, H],
    );
    await owner.query(
      `INSERT INTO categories (id, household_id, group_id, name) VALUES ($1, $2, $3, 'Groceries')`,
      [groceries, H, group],
    );
    const budgets: [string, Actor | null][] = [
      [budget.ours, null],
      [budget.a, 'A'],
      [budget.b, 'B'],
      [budget.c, 'C'],
    ];
    for (const [id, of] of budgets) {
      await owner.query(
        `INSERT INTO budgets (id, household_id, member_id, starts_month) VALUES ($1, $2, $3, $4)`,
        [id, H, of ? people[of].member : null, MONTH],
      );
      await owner.query(
        `INSERT INTO budget_strategies (household_id, budget_id, from_month, strategy)
         VALUES ($1, $2, $3, 'category')`,
        [H, id, MONTH],
      );
      await owner.query(
        `INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
         VALUES ($1, $2, $3, $4, 70000)`,
        [H, id, MONTH, groceries],
      );
      await owner.query(
        `INSERT INTO budget_categories (household_id, budget_id, category_id, rollover)
         VALUES ($1, $2, $3, true)`,
        [H, id, groceries],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
    await tdb?.stop();
  });

  // BUD-01/02: the household's budget, and your own. Written independently of the policy.
  const VISIBLE: Record<Actor, string[]> = {
    A: [budget.ours, budget.a],
    B: [budget.ours, budget.b],
    C: [budget.ours, budget.c],
    V: [budget.ours],
  };
  // The matrix cell each one covers (permissions §7).
  const CELL: Record<Actor, string> = {
    A: '[BUD-02/OWN]',
    B: '[BUD-02/MEM]',
    C: '[BUD-02/MEM]',
    V: '[BUD-02/VIEW]',
  };

  it.each(Object.keys(VISIBLE) as Actor[])(
    'shows %s the household’s budget and only their own, with what’s under it',
    (a) =>
      asMember(a, async (q) => {
        expect(await ids(q, 'SELECT id FROM budgets'), CELL[a]).toEqual(new Set(VISIBLE[a]));
        for (const table of ['budget_strategies', 'budget_amounts', 'budget_categories']) {
          expect(await ids(q, `SELECT budget_id AS id FROM ${table}`), table).toEqual(
            new Set(VISIBLE[a]),
          );
        }
      }),
  );

  it('gives the worker every budget, and the app role nothing for system context', async () => {
    await as({ system: true }, async (q) =>
      expect(await ids(q, 'SELECT id FROM budgets')).toEqual(new Set(Object.values(budget))),
    );
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.system', 'on', true)`,
        [H],
      );
      expect((await app.query('SELECT 1 FROM budgets')).rowCount).toBe(0);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('lets only their member write a member’s budget, or anything under it', async () => {
    await asMember('A', async (q) => {
      expect(
        (await q.query(`UPDATE budgets SET starts_month = '2026-09-01' WHERE id = $1`, [budget.b]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await q.query(`UPDATE budget_amounts SET amount_minor = 1 WHERE budget_id = $1`, [
            budget.b,
          ])
        ).rowCount,
      ).toBe(0);
      expect((await q.query(`DELETE FROM budgets WHERE id = $1`, [budget.b])).rowCount).toBe(0);
      expect(
        (
          await q.query(`UPDATE budget_amounts SET amount_minor = 1 WHERE budget_id = $1`, [
            budget.a,
          ])
        ).rowCount,
      ).toBe(1);
    });
    // Amounts can't be added under a budget you can't see…
    expect(
      await error(() =>
        asMember('A', (q) =>
          q.query(
            `INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
             VALUES ($1, $2, '2026-11-01', $3, 1)`,
            [H, budget.b, groceries],
          ),
        ),
      ),
    ).toMatch(/row-level security/);
    // …nor a budget made for someone else, nor yours handed to them.
    expect(
      await error(() =>
        asMember('A', (q) =>
          q.query(
            `INSERT INTO budgets (id, household_id, member_id, starts_month) VALUES ($1, $2, $3, $4)`,
            [randomUUID(), H, people.V.member, MONTH],
          ),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await error(() =>
        asMember('A', (q) =>
          q.query(`UPDATE budgets SET member_id = $2 WHERE id = $1`, [budget.a, people.V.member]),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it('keeps one household budget, and one of your own', async () => {
    expect(
      await error(() =>
        asMember('B', (q) =>
          q.query(
            `INSERT INTO budgets (id, household_id, member_id, starts_month) VALUES ($1, $2, NULL, $3)`,
            [randomUUID(), H, MONTH],
          ),
        ),
      ),
    ).toMatch(/budgets_scope/);
    expect(
      await error(() =>
        asMember('B', (q) =>
          q.query(
            `INSERT INTO budgets (id, household_id, member_id, starts_month) VALUES ($1, $2, $3, $4)`,
            [randomUUID(), H, people.B.member, MONTH],
          ),
        ),
      ),
    ).toMatch(/budgets_scope/);
    // Months are the first of the month.
    expect(
      await error(() =>
        asMember('A', (q) =>
          q.query(
            `INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
             VALUES ($1, $2, '2026-11-15', $3, 1)`,
            [H, budget.a, groceries],
          ),
        ),
      ),
    ).toMatch(/budget_amounts_month/);
  });

  it('[BUD-05] deletes a member’s budget when they leave, and keeps the household’s', async () => {
    await owner.query(`UPDATE household_members SET left_at = now() WHERE id = $1`, [
      people.C.member,
    ]);
    await as({ system: true }, async (q) => {
      expect(await ids(q, 'SELECT id FROM budgets')).toEqual(
        new Set([budget.ours, budget.a, budget.b]),
      );
      expect(await ids(q, 'SELECT budget_id AS id FROM budget_amounts')).toEqual(
        new Set([budget.ours, budget.a, budget.b]),
      );
    });
  });
});
