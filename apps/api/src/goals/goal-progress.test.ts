// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { Goal, GoalProgress } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * A savings goal up close, end to end (#135, #137; goals walkthrough §3–§4, G11, G12, G17, G18):
 * what it had at each month's end from its claims' history, earmarks apart from what moved in,
 * a percentage claim's fall as the market's, its pace from what moved, and its status from that.
 */
describe('goals: progress and status', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  const acct = { checking: '', harbor: '', brokerage: '' };
  const goal = { trip: '', mine: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const month = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
  };
  const progress = (c: TestClient, goalId: string) => c.get(url(`/goals/${goalId}/progress`));
  /** A transfer: both legs, which Fiscus links. */
  const transfer = async (from: string, to: string, date: string, amountMinor: number) => {
    for (const [accountId, amount] of [
      [from, -amountMinor],
      [to, amountMinor],
    ] as const) {
      const r = await A.post(url('/transactions'), {
        accountId,
        date,
        amountMinor: amount,
        displayName: 'Transfer',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@progress.test`,
        password: 'goal progress Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('alex');
    B = await signup('sam');
    V = await signup('vic');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Riveras',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'hybrid',
      })
    ).body.data.id;
    for (const [c, email, role] of [
      [B, 'sam@progress.test', 'member'],
      [V, 'vic@progress.test', 'viewer'],
    ] as const) {
      const invite = await A.post(url('/invites'), { email, role });
      await c.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    const members = (await A.get(url('/members'))).body.data as { id: string }[];
    const owners = members.slice(0, 2).map((m) => ({ memberId: m.id }));
    const make = async (body: Record<string, unknown>) => {
      const r = await A.post(url('/accounts'), { visibility: 'full', owners, ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.id as string;
    };
    const opened = `${month(-5)}-01`;
    acct.checking = await make({ name: 'Checking', type: 'depository', subtype: 'checking' });
    acct.harbor = await make({
      name: 'Harbor Savings',
      type: 'depository',
      subtype: 'savings',
      openingBalance: { amountMinor: 1000000, asOf: opened },
    });
    acct.brokerage = await make({
      name: 'Brokerage',
      type: 'investment',
      subtype: 'brokerage',
      openingBalance: { amountMinor: 1000000, asOf: opened },
    });

    // Japan trip, $12,000 six months from now at $500 a month: $3,000 of Harbor Savings and 20%
    // of the brokerage account, earmarked four months ago.
    const trip = await A.post(url('/goals'), {
      name: 'Japan trip',
      targetMinor: 1200000,
      targetDate: `${month(6)}-28`,
      planMinor: 50000,
      claims: [
        { accountId: acct.harbor, amountMinor: 300000 },
        { accountId: acct.brokerage, percentBps: 2000 },
      ],
    });
    expect(trip.status, JSON.stringify(trip.body)).toBe(201);
    goal.trip = trip.body.data.id;
    const mine = await A.post(url('/goals'), {
      name: 'Emergency fund',
      scope: 'mine',
      targetMinor: 500000,
      claims: [{ accountId: acct.harbor, amountMinor: 100000 }],
    });
    goal.mine = mine.body.data.id;
    const earmarked = `${month(-4)}-05T12:00:00Z`;
    await owner.query(`UPDATE goals SET created_at = $1 WHERE household_id = $2`, [earmarked, hh]);
    await owner.query(`UPDATE goal_claim_events SET at = $1 WHERE household_id = $2`, [
      earmarked,
      hh,
    ]);
    // The market takes the brokerage account down to $9,000 two months ago.
    await owner.query(
      `INSERT INTO balance_snapshots (account_id, as_of, household_id, balance_minor, source)
       VALUES ($1, $2, $3, 900000, 'manual')`,
      [acct.brokerage, `${month(-2)}-15`, hh],
    );
    // $1,500 moved into Harbor Savings in each of the last three months.
    for (const n of [-3, -2, -1]) {
      await transfer(acct.checking, acct.harbor, `${month(n)}-10`, 150000);
    }
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    await app?.close();
    await tdb?.stop();
  });

  it('gives what it had each month, earmarks apart from saving and the market (G11, G12, G17) [GOAL-01/OWN]', async () => {
    const r = await progress(A, goal.trip);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = r.body.data as GoalProgress;
    expect(p.thisMonth).toBe(month(0));
    expect(p.months).toEqual([
      // Earmarking $3,000 and 20% of $10,000 is progress, not saving (G11).
      { month: month(-4), savedMinor: 500000, movedMinor: 0, marketMinor: 0, claimsMinor: 500000 },
      { month: month(-3), savedMinor: 500000, movedMinor: 150000, marketMinor: 0, claimsMinor: 0 },
      // The brokerage account's fall is the market's, never a missed month (G12).
      {
        month: month(-2),
        savedMinor: 480000,
        movedMinor: 150000,
        marketMinor: -20000,
        claimsMinor: 0,
      },
      { month: month(-1), savedMinor: 480000, movedMinor: 150000, marketMinor: 0, claimsMinor: 0 },
      { month: month(0), savedMinor: 480000, movedMinor: 0, marketMinor: 0, claimsMinor: 0 },
    ]);
    expect(p.steady).toEqual({
      fromMonth: month(-4),
      fromMinor: 500000,
      toMonth: month(6),
      toMinor: 1200000,
    });
  });

  it('paces by what moved, not the plan, and projects to the target (G18)', async () => {
    const p = (await progress(A, goal.trip)).body.data as GoalProgress;
    // $7,200 left at $1,500 a month, this month counting: five months.
    expect(p.pace).toEqual({
      status: 'on_track',
      projectedMonth: month(4),
      monthsLate: 0,
      paceMinor: 150000,
      basis: 'moved',
    });
    expect(p.projection.map((x) => x.savedMinor)).toEqual([
      630000, 780000, 930000, 1080000, 1200000,
    ]);
    expect(p.fixes).toEqual({ planMinor: null, month: null });
    // The list says the same: its $500 plan alone would be late.
    const goals = (await A.get(url('/goals'))).body.data.goals as Goal[];
    expect(goals.find((g) => g.id === goal.trip)!.pace).toEqual({
      status: 'on_track',
      projectedMonth: month(4),
      monthsLate: 0,
    });
  });

  it('is at risk once nothing moves, with what to change', async () => {
    // Moving the date nearer: three months left, so the pace is too slow.
    await owner.query(`UPDATE goals SET target_date = $1 WHERE id = $2`, [
      `${month(2)}-28`,
      goal.trip,
    ]);
    try {
      const p = (await progress(A, goal.trip)).body.data as GoalProgress;
      expect(p.pace).toMatchObject({ status: 'at_risk', projectedMonth: month(4), monthsLate: 2 });
      // $7,200 over this month and the next two.
      expect(p.fixes).toEqual({ planMinor: 240000, month: month(4) });
    } finally {
      await owner.query(`UPDATE goals SET target_date = $1 WHERE id = $2`, [
        `${month(6)}-28`,
        goal.trip,
      ]);
    }
  });

  it('shows the household’s goal to everyone, a newer member from their window [GOAL-01/MEM] [GOAL-01/VIEW]', async () => {
    const seen = (await progress(V, goal.trip)).body.data as GoalProgress;
    // Vic and Sam joined this month: its history from then on, and nothing before is known.
    expect(seen.months).toEqual([
      { month: month(0), savedMinor: 480000, movedMinor: 0, marketMinor: 0, claimsMinor: 0 },
    ]);
    // Its pace is still what moved over three months: accounts aren't windowed.
    expect(seen.pace).toMatchObject({ status: 'on_track', paceMinor: 150000 });
    const b = await progress(B, goal.trip);
    expect(b.status).toBe(200);
    expect(b.body.data.months).toHaveLength(1);
  });

  it('keeps your own goal’s history yours [GOAL-02/OWN] [GOAL-02/MEM] [GOAL-02/VIEW]', async () => {
    const p = (await progress(A, goal.mine)).body.data as GoalProgress;
    expect(p.months.map((m) => m.savedMinor)).toEqual([100000, 100000, 100000, 100000, 100000]);
    // No date: no status, and no steady line.
    expect(p.pace.status).toBeNull();
    expect(p.steady).toBeNull();
    for (const c of [B, V]) expect((await progress(c, goal.mine)).status).toBe(404);
  });
});
