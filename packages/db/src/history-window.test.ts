// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * The member history window under row-level security (#256, ADR 0012 §Joining), with no
 * application code. A is the household's first member, B has been widened to all of it, and C's
 * window starts on 2027-01-15. Household records from before C's window are hidden from C: the
 * household budget's months (except the amounts the window's first month still runs on), its moved
 * money, household goals' claim history, and the activity feed. C's own records aren't windowed.
 */

type Actor = 'A' | 'B' | 'C';
const H = randomUUID();
const ROLES: Record<Actor, string> = { A: 'owner', B: 'member', C: 'member' };
const people = Object.fromEntries(
  (Object.keys(ROLES) as Actor[]).map((k) => [k, { user: randomUUID(), member: randomUUID() }]),
) as Record<Actor, { user: string; member: string }>;
const WINDOW = '2027-01-15';
const budget = { ours: randomUUID(), c: randomUUID() };
const goal = randomUUID();
const groceries = randomUUID();
const dining = randomUUID();

/** Each record, and who sees it. Written independently of the policies. */
interface Row {
  id: string;
  seenBy: Actor[];
}

describe('member history window (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  const amounts: Row[] = [];
  const moves: Row[] = [];
  const claimEvents: Row[] = [];
  const events: (Row & { action: string })[] = [];

  async function asMember<T>(a: Actor, fn: (q: pg.Client) => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', 'off', true)`,
        [H, people[a].member, people[a].user],
      );
      return await fn(app);
    } finally {
      await app.query('ROLLBACK');
    }
  }
  const ids = async (q: pg.Client, sqlText: string) =>
    new Set((await q.query(sqlText)).rows.map((r) => String(r.id)));
  const error = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };
  const seen = (rows: Row[], a: Actor) =>
    new Set(rows.filter((r) => r.seenBy.includes(a)).map((r) => r.id));

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    await Promise.all([owner.connect(), app.connect()]);

    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
      [H],
    );
    for (const k of ['A', 'B', 'C'] as Actor[]) {
      const p = people[k];
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k.toLowerCase()}-${p.user}@history.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, $5, '#000')`,
        [p.member, H, p.user, ROLES[k], k],
      );
    }
    // B was widened to all of it (no household context: only "widen" applies). C joins on
    // WINDOW, after the records below: set without the triggers, as a join on that date would.
    await owner.query(`UPDATE household_members SET history_from = NULL WHERE id = $1`, [
      people.B.member,
    ]);
    await owner.query(`SET session_replication_role = replica`);
    await owner.query(`UPDATE household_members SET history_from = $2 WHERE id = $1`, [
      people.C.member,
      WINDOW,
    ]);
    await owner.query(`SET session_replication_role = DEFAULT`);

    const group = randomUUID();
    await owner.query(
      `INSERT INTO category_groups (id, household_id, name, kind) VALUES ($1, $2, 'Food', 'flexible')`,
      [group, H],
    );
    for (const [id, name] of [
      [groceries, 'Groceries'],
      [dining, 'Dining'],
    ]) {
      await owner.query(
        `INSERT INTO categories (id, household_id, group_id, name) VALUES ($1, $2, $3, $4)`,
        [id, H, group, name],
      );
    }
    await owner.query(
      `INSERT INTO budgets (id, household_id, member_id, starts_month) VALUES
         ($1, $3, NULL, '2026-10-01'), ($2, $3, $4, '2026-10-01')`,
      [budget.ours, budget.c, H, people.C.member],
    );
    // The household budget's amounts: October's are replaced by December's, which January (the
    // window's first month) still runs on, so C sees December's and not October's.
    for (const [b, month, seenBy] of [
      [budget.ours, '2026-10-01', ['A', 'B']],
      [budget.ours, '2026-12-01', ['A', 'B', 'C']],
      [budget.ours, '2027-02-01', ['A', 'B', 'C']],
      [budget.c, '2026-10-01', ['C']],
    ] as [string, string, Actor[]][]) {
      await owner.query(
        `INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
         VALUES ($1, $2, $3, $4, 70000)`,
        [H, b, month, groceries],
      );
      amounts.push({ id: `${b}:${month}`, seenBy });
    }
    // Money moved is the month's own: nothing carries.
    for (const [b, month, seenBy] of [
      [budget.ours, '2026-12-01', ['A', 'B']],
      [budget.ours, '2027-01-01', ['A', 'B', 'C']],
      [budget.c, '2026-10-01', ['C']],
    ] as [string, string, Actor[]][]) {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO budget_moves (id, household_id, budget_id, month, from_category_id,
           to_category_id, amount_minor) VALUES ($1, $2, $3, $4, $5, $6, 4130)`,
        [id, H, b, month, groceries, dining],
      );
      moves.push({ id, seenBy });
    }

    await owner.query(
      `INSERT INTO goals (id, household_id, member_id, name, target_minor)
       VALUES ($1, $2, NULL, 'Trip', 500000)`,
      [goal, H],
    );
    for (const [at, by, seenBy] of [
      ['2026-12-01T12:00:00Z', 'A', ['A', 'B']],
      ['2027-01-14T23:59:59Z', 'A', ['A', 'B']],
      ['2027-01-15T00:00:00Z', 'A', ['A', 'B', 'C']],
      // Your own doing is yours, whenever it was.
      ['2026-12-01T12:00:00Z', 'C', ['A', 'B', 'C']],
    ] as [string, Actor, Actor[]][]) {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO goal_claim_events (id, household_id, goal_id, account_id, reason, member_id,
           amount_after_minor, at) VALUES ($1, $2, $3, $4, 'earmarked', $5, 100, $6)`,
        [id, H, goal, randomUUID(), people[by].member, at],
      );
      claimEvents.push({ id, seenBy });
    }

    const event = async (
      action: string,
      at: string,
      seenBy: Actor[],
      extra: { actor?: Actor; targetType?: string; targetId?: string } = {},
    ) => {
      const { rows } = await owner.query(
        `INSERT INTO audit_events (occurred_at, actor_kind, actor_member_id, household_id, action,
           target_type, target_id, visible_to_household)
         VALUES ($1, 'user', $2, $3, $4, $5, $6, true) RETURNING id`,
        [
          at,
          people[extra.actor ?? 'A'].member,
          H,
          action,
          extra.targetType ?? null,
          extra.targetId ?? null,
        ],
      );
      events.push({ id: String(rows[0].id), action, seenBy });
    };
    await event('budget.changed', '2026-12-01T12:00:00Z', ['A', 'B']);
    await event('budget.changed', '2027-01-15T00:00:01Z', ['A', 'B', 'C']);
    await event('member.invited', '2027-01-10T12:00:00Z', ['A', 'B', 'C'], {
      targetType: 'household_member',
      targetId: people.C.member,
    });
    await event('member.invited', '2026-12-10T12:00:00Z', ['A', 'B'], {
      targetType: 'household_member',
      targetId: people.B.member,
    });
    await event('goal.claimed', '2026-12-02T12:00:00Z', ['A', 'B', 'C'], { actor: 'C' });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
    await tdb?.stop();
  });

  describe.each(['A', 'B', 'C'] as Actor[])('as %s', (a) => {
    it('sees the household budget’s amounts from the window on', async () => {
      const got = await asMember(a, (q) =>
        ids(q, `SELECT budget_id || ':' || month AS id FROM budget_amounts`),
      );
      expect(got).toEqual(seen(amounts, a));
    });

    it('sees money moved in the household budget from the window’s month on', async () => {
      expect(await asMember(a, (q) => ids(q, `SELECT id FROM budget_moves`))).toEqual(
        seen(moves, a),
      );
    });

    it('sees household goals’ claim history from the window on', async () => {
      expect(await asMember(a, (q) => ids(q, `SELECT id FROM goal_claim_events`))).toEqual(
        seen(claimEvents, a),
      );
    });

    it('sees household activity from the window on, and their own whenever it was', async () => {
      expect(await asMember(a, (q) => ids(q, `SELECT id FROM audit_events`))).toEqual(
        new Set(events.filter((e) => e.seenBy.includes(a)).map((e) => e.id)),
      );
    });
  });

  it('keeps the budget itself and its other tables visible: only history is windowed', async () => {
    expect(await asMember('C', (q) => ids(q, `SELECT id FROM budgets`))).toEqual(
      new Set([budget.ours, budget.c]),
    );
    expect(await asMember('C', (q) => ids(q, `SELECT id FROM goals`))).toEqual(new Set([goal]));
  });

  it('lets the newer member write the household budget only inside their window', async () => {
    const insert = (month: string) => (q: pg.Client) =>
      q.query(
        `INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
         VALUES ($1, $2, $3, $4, 100)`,
        [H, budget.ours, month, dining],
      );
    expect(await error(() => asMember('C', insert('2026-12-01')))).toMatch(/row-level security/);
    expect(await error(() => asMember('C', insert('2027-01-01')))).toBeUndefined();
    expect(await error(() => asMember('B', insert('2026-11-01')))).toBeUndefined();
    // An older month C can't see can't be changed either: nothing matches.
    const updated = await asMember('C', (q) =>
      q.query(
        `UPDATE budget_amounts SET amount_minor = 1 WHERE budget_id = $1 AND month = '2026-10-01'`,
        [budget.ours],
      ),
    );
    expect(updated.rowCount).toBe(0);
  });

  it('sets a joining member’s window to their join date, and leaves the first member’s open', async () => {
    const h2 = randomUUID();
    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone)
       VALUES ($1, 'H2', 'USD', 'Pacific/Auckland')`,
      [h2],
    );
    const first = randomUUID();
    const later = randomUUID();
    await owner.query(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name, color, joined_at)
       VALUES ($1, $3, $4, 'owner', 'First', '#000', '2026-03-01T10:00:00Z'),
              ($2, $3, $5, 'member', 'Later', '#111', '2026-06-30T20:00:00Z')`,
      [first, later, h2, people.A.user, people.B.user],
    );
    const { rows } = await owner.query(
      `SELECT id, history_from::text AS d FROM household_members WHERE household_id = $1`,
      [h2],
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r.d]));
    // 20:00 UTC on June 30 is already July 1 in Auckland.
    expect(by).toEqual({ [first]: null, [later]: '2026-07-01' });
  });

  describe('widening', () => {
    const setWindow = (a: Actor, of: Actor, value: string | null) =>
      error(() =>
        asMember(a, (q) =>
          q.query(`UPDATE household_members SET history_from = $2 WHERE id = $1`, [
            people[of].member,
            value,
          ]),
        ),
      );

    it('lets an owner widen a member’s window, earlier or to all of it', async () => {
      expect(await setWindow('A', 'C', '2026-11-01')).toBeUndefined();
      expect(await setWindow('A', 'C', null)).toBeUndefined();
    });

    it('never narrows it, not even for an owner', async () => {
      expect(await setWindow('A', 'C', '2027-02-01')).toMatch(/only be widened/);
      expect(await setWindow('A', 'B', '2027-01-01')).toMatch(/only be widened/);
      expect(await setWindow('A', 'A', '2027-01-01')).toMatch(/only be widened/);
    });

    it('is an owner’s to widen, not a member’s, not even their own', async () => {
      expect(await setWindow('C', 'C', '2026-01-01')).toMatch(/Only an owner/);
      expect(await setWindow('B', 'C', null)).toMatch(/Only an owner/);
      // Their own name and color are theirs to change as before (HH-18).
      expect(
        await error(() =>
          asMember('C', (q) =>
            q.query(`UPDATE household_members SET display_name = 'Cal' WHERE id = $1`, [
              people.C.member,
            ]),
          ),
        ),
      ).toBeUndefined();
    });

    it('shows the widened member what was hidden, in the same transaction', async () => {
      const got = await asMember('A', async (q) => {
        await q.query(`UPDATE household_members SET history_from = NULL WHERE id = $1`, [
          people.C.member,
        ]);
        await q.query(
          `SELECT set_config('app.member_id', $1, true), set_config('app.user_id', $2, true)`,
          [people.C.member, people.C.user],
        );
        return ids(q, `SELECT id FROM budget_moves`);
      });
      expect(got).toEqual(new Set(moves.map((m) => m.id)));
    });
  });
});
