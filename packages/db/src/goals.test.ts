// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Goals under row-level security (#131, goals walkthrough G7, G15), with no application code: the
 * household's goals are everyone's, a member's own is theirs alone, claims follow their goal and
 * are set only by the account's owners, and what a claim is worth never gives away a private
 * balance beyond the claim itself.
 */

type Actor = 'A' | 'B' | 'V';
const H = randomUUID();
const ROLES: Record<Actor, string> = { A: 'owner', B: 'member', V: 'viewer' };
const people = Object.fromEntries(
  (Object.keys(ROLES) as Actor[]).map((k) => [k, { user: randomUUID(), member: randomUUID() }]),
) as Record<Actor, { user: string; member: string }>;
const account = { joint: randomUUID(), alexs: randomUUID() };
const goal = { ours: randomUUID(), alexs: randomUUID() };
const claim = { house: randomUUID(), trip: randomUUID(), cushion: randomUUID() };

describe('goals (RLS)', () => {
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
    await Promise.all([owner.connect(), app.connect()]);
    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
      [H],
    );
    for (const [k, p] of Object.entries(people)) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k.toLowerCase()}-${p.user}@goals.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, $5, '#000')`,
        [p.member, H, p.user, ROLES[k as Actor], k],
      );
    }
    // Harbor Savings, joint and fully shared; Alex's savings, private.
    for (const [id, name, visibility, owners, balance] of [
      [account.joint, 'Harbor Savings', 'full', ['A', 'B'], 2000000],
      [account.alexs, 'Alex savings', 'private', ['A'], 940000],
    ] as const) {
      await owner.query('BEGIN');
      await owner.query(
        `INSERT INTO accounts (id, household_id, name, type, currency, visibility, balance_mode)
         VALUES ($1, $2, $3, 'depository', 'USD', $4, 'value')`,
        [id, H, name, visibility],
      );
      for (const o of owners) {
        await owner.query(
          `INSERT INTO account_owners (account_id, member_id, household_id, share_bps)
           VALUES ($1, $2, $3, $4)`,
          [id, people[o].member, H, 10000 / owners.length],
        );
      }
      await owner.query('COMMIT');
      await owner.query(
        `INSERT INTO balance_snapshots (account_id, as_of, household_id, balance_minor, source)
         VALUES ($1, '2026-11-01', $2, $3, 'manual')`,
        [id, H, balance],
      );
    }
    await owner.query(
      `INSERT INTO goals (id, household_id, member_id, name, target_minor) VALUES
         ($1, $3, NULL, 'House', 6000000), ($2, $3, $4, 'Cushion', 1000000)`,
      [goal.ours, goal.alexs, H, people.A.member],
    );
    // The house: $14,000 of Harbor Savings, and 50% of Alex's private savings.
    // Alex's own cushion: $3,000 of Harbor Savings.
    await owner.query(
      `INSERT INTO goal_claims (id, household_id, goal_id, account_id, amount_minor, percent_bps) VALUES
         ($1, $4, $5, $7, 1400000, NULL),
         ($2, $4, $5, $8, NULL, 5000),
         ($3, $4, $6, $7, 300000, NULL)`,
      [
        claim.house,
        claim.trip,
        claim.cushion,
        H,
        goal.ours,
        goal.alexs,
        account.joint,
        account.alexs,
      ],
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
    await tdb?.stop();
  });

  it('shows the household’s goals to everyone, and a member’s own to them alone (G15)', async () => {
    expect(await as('A', (q) => ids(q, 'SELECT id FROM goals'))).toEqual(
      new Set([goal.ours, goal.alexs]),
    );
    for (const a of ['B', 'V'] as const) {
      expect(await as(a, (q) => ids(q, 'SELECT id FROM goals'))).toEqual(new Set([goal.ours]));
      expect(await as(a, (q) => ids(q, 'SELECT id FROM goal_claims'))).toEqual(
        new Set([claim.house, claim.trip]),
      );
    }
  });

  it('shows a claim on a private account, never its balance (G7)', async () => {
    const values = await as('B', (q) =>
      q.query(
        `SELECT claim_id, value_minor::int AS value, short_minor::int AS short, account_name,
                cardinality(owner_ids) AS owners
         FROM fiscus_goal_claim_values() ORDER BY value DESC`,
      ),
    );
    expect(values.rows).toEqual([
      // Harbor Savings, which Bea sees.
      {
        claim_id: claim.house,
        value: 1400000,
        short: 0,
        account_name: 'Harbor Savings',
        owners: 2,
      },
      // Half of Alex's savings: the claim, with no name and no balance.
      { claim_id: claim.trip, value: 470000, short: 0, account_name: null, owners: 1 },
    ]);
    expect(await as('B', (q) => ids(q, 'SELECT id FROM accounts'))).not.toContain(account.alexs);
  });

  it('counts every goal’s claims on an account its owner checks, theirs or not (G3)', async () => {
    const mine = await as('B', (q) =>
      q.query('SELECT * FROM fiscus_account_claimed($1)', [account.joint]),
    );
    // Alex's own cushion counts, though Bea can't see it.
    expect(mine.rows).toEqual([
      { balance_minor: '2000000', fixed_minor: '1700000', percent_bps: 0 },
    ]);
    const notHers = await as('B', (q) =>
      q.query('SELECT * FROM fiscus_account_claimed($1)', [account.alexs]),
    );
    expect(notHers.rows).toEqual([]);
  });

  it('lets only an account’s owners claim it (G7)', async () => {
    const add = (a: Actor, accountId: string) =>
      error(() =>
        as(a, (q) =>
          q.query(
            `INSERT INTO goal_claims (id, household_id, goal_id, account_id, amount_minor)
             VALUES ($1, $2, $3, $4, 100)`,
            [randomUUID(), H, goal.ours, accountId],
          ),
        ),
      );
    expect(await add('B', account.alexs)).toMatch(/row-level security/);
    expect(await add('V', account.joint)).toMatch(/row-level security/);
    expect(await add('B', account.joint)).toMatch(/goal_claims_goal_account/); // allowed; one per account
    expect(
      await as('B', (q) =>
        q.query(`UPDATE goal_claims SET percent_bps = 1 WHERE id = $1`, [claim.trip]),
      ).then((r) => r.rowCount),
    ).toBe(0);
  });

  it('shows how far an account falls below its fixed claims', async () => {
    await owner.query(
      `INSERT INTO balance_snapshots (account_id, as_of, household_id, balance_minor, source)
       VALUES ($1, '2026-11-02', $2, 1550000, 'manual')`,
      [account.joint, H],
    );
    try {
      const r = await as('A', (q) =>
        q.query(
          `SELECT DISTINCT short_minor::int AS short FROM fiscus_goal_claim_values()
           WHERE account_id = $1`,
          [account.joint],
        ),
      );
      expect(r.rows).toEqual([{ short: 150000 }]);
    } finally {
      await owner.query(`DELETE FROM balance_snapshots WHERE as_of = '2026-11-02'`);
    }
  });

  it('keeps a claim’s history only with its goal, and never rewrites it', async () => {
    await as('A', async (q) => {
      await q.query(
        `INSERT INTO goal_claim_events (id, household_id, goal_id, account_id, reason, member_id,
           amount_after_minor) VALUES ($1, $2, $3, $4, 'earmarked', $5, 300000)`,
        [randomUUID(), H, goal.alexs, account.joint, people.A.member],
      );
      expect((await q.query(`UPDATE goal_claim_events SET reason = 'changed'`)).rowCount).toBe(0);
    });
    expect(
      await error(() =>
        as('B', (q) =>
          q.query(
            `INSERT INTO goal_claim_events (id, household_id, goal_id, account_id, reason)
             VALUES ($1, $2, $3, $4, 'released')`,
            [randomUUID(), H, goal.alexs, account.joint],
          ),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it('deletes a member’s own goals when they leave [GOAL-07]', async () => {
    const c = { user: randomUUID(), member: randomUUID(), goal: randomUUID() };
    await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'C')`, [
      c.user,
      `c-${c.user}@goals.test`,
    ]);
    await owner.query(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
       VALUES ($1, $2, $3, 'member', 'C', '#000')`,
      [c.member, H, c.user],
    );
    await owner.query(
      `INSERT INTO goals (id, household_id, member_id, name, target_minor)
       VALUES ($1, $2, $3, 'Bike', 90000)`,
      [c.goal, H, c.member],
    );
    await owner.query(`UPDATE household_members SET left_at = now() WHERE id = $1`, [c.member]);
    const { rows } = await owner.query(`SELECT id FROM goals WHERE household_id = $1`, [H]);
    expect(rows.map((r) => r.id).sort()).toEqual([goal.ours, goal.alexs].sort());
  });
});
