// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Consent to a split by income under row-level security (#110, ADR 0006 F4), with no application
 * code: each member's consent and income are theirs alone, and the others learn only who has
 * agreed and the split it makes, never an income.
 */

type Actor = 'A' | 'B' | 'C' | 'V';
const H = randomUUID();
const ROLES: Record<Actor, string> = { A: 'owner', B: 'member', C: 'member', V: 'viewer' };
const people = Object.fromEntries(
  (Object.keys(ROLES) as Actor[]).map((k) => [k, { user: randomUUID(), member: randomUUID() }]),
) as Record<Actor, { user: string; member: string }>;
// Distinct figures, so any trace of them in a result shows.
const INCOME = { A: 613_579, B: 402_461 };

describe('income split consents (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;

  async function as<T>(a: Actor | 'system', fn: (q: pg.Client) => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      const p = a === 'system' ? { member: '', user: '' } : people[a];
      await app.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [H, p.member, p.user, a === 'system' ? 'on' : 'off'],
      );
      return await fn(app);
    } finally {
      await app.query('ROLLBACK');
    }
  }
  const error = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };
  const shares = (q: pg.Client, day: string) =>
    q
      .query(
        `SELECT member_id, share_bps FROM fiscus_income_split_shares(ARRAY[$1::date])
         ORDER BY share_bps DESC`,
        [day],
      )
      .then((r) => r.rows);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    await Promise.all([owner.connect(), app.connect()]);
    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
      [H],
    );
    for (const [k, p] of Object.entries(people)) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k.toLowerCase()}-${p.user}@income.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, $5, '#000')`,
        [p.member, H, p.user, ROLES[k as Actor], k],
      );
    }
    // A agrees from Oct 1 and B from Oct 10, each with a declared income; C never does.
    await owner.query(
      `INSERT INTO income_split_consents
         (id, household_id, member_id, effective_from, basis, declared_monthly_minor) VALUES
         (gen_random_uuid(), $1, $2, '2026-10-01', 'declared', $3),
         (gen_random_uuid(), $1, $4, '2026-10-10', 'declared', $5)`,
      [H, people.A.member, INCOME.A, people.B.member, INCOME.B],
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
    await tdb?.stop();
  });

  it('shows each member their own consent, and nobody else’s', async () => {
    for (const a of ['A', 'B', 'C', 'V'] as const) {
      const rows = await as(a, (q) =>
        q.query('SELECT member_id, declared_monthly_minor FROM income_split_consents'),
      );
      const own = a === 'A' ? [INCOME.A] : a === 'B' ? [INCOME.B] : [];
      expect(rows.rows.map((r) => Number(r.declared_monthly_minor))).toEqual(own);
      expect(rows.rows.every((r) => r.member_id === people[a].member)).toBe(true);
    }
    // Not even system jobs read them.
    expect(
      (await as('system', (q) => q.query('SELECT 1 FROM income_split_consents'))).rowCount,
    ).toBe(0);
  });

  it('lets a member agree only for themselves', async () => {
    const forged = await as('B', (q) =>
      error(() =>
        q.query(
          `INSERT INTO income_split_consents (id, household_id, member_id, effective_from, basis)
           VALUES (gen_random_uuid(), $1, $2, '2026-11-01', 'actual')`,
          [H, people.C.member],
        ),
      ),
    );
    expect(forged).toMatch(/row-level security/);
    const changed = await as('B', (q) =>
      q.query(`UPDATE income_split_consents SET declared_monthly_minor = 1 WHERE member_id = $1`, [
        people.A.member,
      ]),
    );
    expect(changed.rowCount).toBe(0);
  });

  it('says who has agreed, to everyone, and nothing more', async () => {
    for (const a of ['A', 'B', 'C', 'V'] as const) {
      const { rows } = await as(a, (q) =>
        q.query(`SELECT * FROM fiscus_income_split_status('2026-10-12') ORDER BY consented DESC`),
      );
      expect(Object.keys(rows[0]!).sort()).toEqual(['consented', 'member_id']);
      expect(new Map(rows.map((r) => [r.member_id, r.consented]))).toEqual(
        new Map([
          [people.A.member, true],
          [people.B.member, true],
          [people.C.member, false],
        ]),
      );
    }
  });

  it('gives the split between those who had agreed by the day, never the incomes', async () => {
    const total = INCOME.A + INCOME.B;
    const expected = [
      { member_id: people.A.member, share_bps: Math.round((INCOME.A * 10000) / total) },
      { member_id: people.B.member, share_bps: Math.round((INCOME.B * 10000) / total) },
    ];
    for (const a of ['A', 'B', 'C', 'V'] as const) {
      const rows = await as(a, (q) => shares(q, '2026-10-12'));
      expect(rows).toEqual(expected);
      const text = JSON.stringify(rows);
      expect(text).not.toContain(String(INCOME.A));
      expect(text).not.toContain(String(INCOME.B));
    }
    // Before B agreed, only A had: a split of one, which says nothing about A's income.
    expect(await as('C', (q) => shares(q, '2026-10-05'))).toEqual([
      { member_id: people.A.member, share_bps: 10000 },
    ]);
    expect(await as('C', (q) => shares(q, '2026-09-30'))).toEqual([]);
  });

  it('stops counting someone from the day they withdraw', async () => {
    await owner.query(
      `INSERT INTO income_split_consents (id, household_id, member_id, effective_from, basis)
       VALUES (gen_random_uuid(), $1, $2, '2026-11-03', NULL)`,
      [H, people.A.member],
    );
    expect((await as('B', (q) => shares(q, '2026-11-02'))).length).toBe(2);
    expect(await as('B', (q) => shares(q, '2026-11-03'))).toEqual([
      { member_id: people.B.member, share_bps: 10000 },
    ]);
  });

  it('answers nothing without a valid context', async () => {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.household_id', $1, true)`, [H]);
      expect((await shares(app, '2026-10-12')).length).toBe(0);
      expect(
        (await app.query(`SELECT * FROM fiscus_income_split_status('2026-10-12')`)).rowCount,
      ).toBe(0);
    } finally {
      await app.query('ROLLBACK');
    }
  });
});
