// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Ownership history under row-level security (#447), with no application code: who owned an
 * account on a date (fiscus_owners_on()), who sees and writes the periods, and "Paid by" through
 * attribution naming whoever owned the account then.
 */

type Actor = 'A' | 'B' | 'C';
const H = randomUUID();
const people = Object.fromEntries(
  (['A', 'B', 'C'] as Actor[]).map((k) => [k, { user: randomUUID(), member: randomUUID() }]),
) as Record<Actor, { user: string; member: string }>;
// B co-owned it until June; since then it's A's alone, and private.
const account = randomUUID();
const txn = { march: randomUUID(), july: randomUUID() };

describe('account ownership history (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;

  async function as<T>(a: Actor, fn: (q: pg.Client) => Promise<T>): Promise<T> {
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
  const ownersOn = (q: pg.Client, date: string) =>
    q
      .query(`SELECT member_id, share_bps FROM fiscus_owners_on($1, $2) ORDER BY share_bps DESC`, [
        account,
        date,
      ])
      .then((r) => r.rows.map((o) => [o.member_id as string, o.share_bps as number]));
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
    await Promise.all([owner.connect(), app.connect()]);

    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
      [H],
    );
    for (const [k, p] of Object.entries(people)) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k.toLowerCase()}-${p.user}@periods.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, 'member', $4, '#000')`,
        [p.member, H, p.user, k],
      );
    }
    await owner.query('BEGIN');
    await owner.query(
      `INSERT INTO accounts (id, household_id, name, type, currency, visibility, balance_mode)
       VALUES ($1, $2, 'Checking', 'depository', 'USD', 'private', 'transactions')`,
      [account, H],
    );
    await owner.query(
      `INSERT INTO account_owners (account_id, member_id, household_id, share_bps)
       VALUES ($1, $2, $3, 10000)`,
      [account, people.A.member, H],
    );
    await owner.query('COMMIT');
    for (const [m, share] of [
      ['A', 5000],
      ['B', 5000],
    ] as const) {
      await owner.query(
        `INSERT INTO account_owner_periods
           (account_id, member_id, household_id, share_bps, valid_from, valid_until)
         VALUES ($1, $2, $3, $4, NULL, '2026-06-01')`,
        [account, people[m].member, H, share],
      );
    }
    for (const [id, date] of [
      [txn.march, '2026-03-10'],
      [txn.july, '2026-07-10'],
    ] as const) {
      await owner.query(
        `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency,
           authorized_date, posted_date, original_description, display_name, source)
         VALUES ($1, $2, $3, -1000, 'USD', $4, $4, 'x', 'x', 'manual')`,
        [id, H, account, date],
      );
      // Both are C's too, by attribution: C sees them without seeing the account (F1).
      await owner.query(
        `INSERT INTO transaction_attributions (transaction_id, member_id, household_id, share_bps)
         VALUES ($1, $2, $3, 10000)`,
        [id, people.C.member, H],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
    await tdb?.stop();
  });

  it('gives an account’s owners on a date: the period covering it, else today’s', () =>
    as('A', async (q) => {
      expect(await ownersOn(q, '2026-03-10')).toEqual(
        expect.arrayContaining([
          [people.A.member, 5000],
          [people.B.member, 5000],
        ]),
      );
      expect(await ownersOn(q, '2026-05-31')).toHaveLength(2);
      // The period ends the day before valid_until.
      expect(await ownersOn(q, '2026-06-01')).toEqual([[people.A.member, 10000]]);
      expect(await ownersOn(q, '2026-07-10')).toEqual([[people.A.member, 10000]]);
    }));

  it('shows a past owner nothing new once the account is private to someone else', () =>
    as('B', async (q) => {
      expect((await q.query('SELECT 1 FROM account_owner_periods')).rowCount).toBe(0);
      expect((await q.query('SELECT 1 FROM transactions')).rowCount).toBe(0);
      expect(await ownersOn(q, '2026-03-10')).toEqual([]);
    }));

  it('lets only whoever may change the owners write the periods', async () => {
    await as('A', async (q) => {
      const r = await q.query(`DELETE FROM account_owner_periods WHERE account_id = $1`, [account]);
      expect(r.rowCount).toBe(2);
    });
    await as('B', async (q) => {
      const r = await q.query(`DELETE FROM account_owner_periods WHERE account_id = $1`, [account]);
      expect(r.rowCount).toBe(0);
    });
    expect(
      await error(() =>
        as('C', (q) =>
          q.query(
            `INSERT INTO account_owner_periods
               (account_id, member_id, household_id, share_bps, valid_until)
             VALUES ($1, $2, $3, 10000, '2026-01-01')`,
            [account, people.C.member, H],
          ),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it('names whoever owned the account then as having paid (F1)', () =>
    as('C', async (q) => {
      const paid = new Map<string, string[]>();
      for (const r of (await q.query('SELECT * FROM fiscus_attributed_payers()')).rows) {
        paid.set(r.transaction_id, [...(paid.get(r.transaction_id) ?? []), r.member_id].sort());
      }
      expect(paid.get(txn.march)).toEqual([people.A.member, people.B.member].sort());
      expect(paid.get(txn.july)).toEqual([people.A.member]);
    }));

  it('refuses a period that ends before it starts', async () => {
    expect(
      await error(() =>
        owner.query(
          `INSERT INTO account_owner_periods
             (account_id, member_id, household_id, share_bps, valid_from, valid_until)
           VALUES ($1, $2, $3, 10000, '2026-06-01', '2026-06-01')`,
          [account, people.A.member, H],
        ),
      ),
    ).toMatch(/account_owner_periods_dates/);
  });
});
