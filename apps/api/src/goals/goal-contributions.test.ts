// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { Goal, GoalContributions } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Who's put in to a goal (#133; goals and budgets G7, G11; budgeting D36): each member's
 * contributions are its claims growing with new money moved into their accounts, and their share
 * of it on joint accounts. Earmarking money already there isn't anyone's; a claim on a private
 * account shows only what it put in; a newer member sees the months from their window on.
 */
describe('goals: who’s put in', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  const id = { A: '', B: '', V: '' };
  const acct = { checking: '', harbor: '', alexs: '' };
  const goal = { house: '', cushion: '', mine: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const longAgo = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  const contributions = async (c: TestClient, goalId: string): Promise<GoalContributions> => {
    const r = await c.get(url(`/goals/${goalId}/contributions`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const of = (c: GoalContributions, memberId: string) =>
    c.members.find((m) => m.memberId === memberId);
  const claim = async (goalId: string, accountId: string, body: object) => {
    const r = await A.request('PUT', url(`/goals/${goalId}/claims/${accountId}`), body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as Goal;
  };
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
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@put-in.test`,
        password: 'put in test Password1!',
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
      [B, 'sam@put-in.test', 'member'],
      [V, 'vic@put-in.test', 'viewer'],
    ] as const) {
      const invite = await A.post(url('/invites'), { email, role });
      await c.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    const members = (await A.get(url('/members'))).body.data as {
      id: string;
      displayName: string;
    }[];
    const keys = { alex: 'A', sam: 'B', vic: 'V' } as const;
    for (const m of members) id[keys[m.displayName as keyof typeof keys]] = m.id;
    const make = async (body: Record<string, unknown>) => {
      const r = await A.post(url('/accounts'), { type: 'depository', ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.id as string;
    };
    const joint = [
      { memberId: id.A, shareBps: 6000 },
      { memberId: id.B, shareBps: 4000 },
    ];
    acct.checking = await make({
      name: 'Joint checking',
      subtype: 'checking',
      visibility: 'full',
      owners: joint,
      openingBalance: { amountMinor: 5000000, asOf: longAgo },
    });
    acct.harbor = await make({
      name: 'Harbor Savings',
      subtype: 'savings',
      visibility: 'full',
      owners: joint,
      openingBalance: { amountMinor: 2000000, asOf: longAgo },
    });
    acct.alexs = await make({
      name: 'Alex savings',
      subtype: 'savings',
      visibility: 'private',
      openingBalance: { amountMinor: 1000000, asOf: yesterday },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('counts no one’s contribution for earmarking money already there (G11) [GOAL-09/OWN]', async () => {
    const r = await A.post(url('/goals'), {
      name: 'House down payment',
      targetMinor: 6000000,
      claims: [{ accountId: acct.harbor, amountMinor: 1500000 }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    goal.house = r.body.data.id;
    expect(await contributions(A, goal.house)).toEqual({
      goalId: goal.house,
      thisMonth,
      members: [],
      totalMinor: 0,
      months: [],
    });
  });

  it('counts a claim’s growth in a month up to the money moved in that month, by ownership (G11, D36) [GOAL-09/MEM]', async () => {
    // The claim grew by $15,000.00 this month, and $1,000.00 of it is new money.
    await transfer(acct.checking, acct.harbor, today, 100000);
    let c = await contributions(B, goal.house);
    expect(c.totalMinor).toBe(100000);
    // A joint account's is shared by its owners' shares: 60/40.
    expect(of(c, id.A)).toEqual({ memberId: id.A, totalMinor: 60000, thisMonthMinor: 60000 });
    expect(of(c, id.B)).toEqual({ memberId: id.B, totalMinor: 40000, thisMonthMinor: 40000 });
    expect(c.members.map((m) => m.memberId)).toEqual([id.A, id.B]);
    expect(c.months).toEqual([
      { month: thisMonth, memberId: id.A, amountMinor: 60000 },
      { month: thisMonth, memberId: id.B, amountMinor: 40000 },
    ]);
    // Raising it more earmarks more of what's there: no more new money.
    await claim(goal.house, acct.harbor, { amountMinor: 1650000 });
    c = await contributions(B, goal.house);
    expect(c.totalMinor).toBe(100000);
  });

  it('counts a percentage claim’s share of new money on a private account, all its owner’s (G7) [GOAL-09/VIEW]', async () => {
    await transfer(acct.checking, acct.alexs, today, 200000);
    await claim(goal.house, acct.alexs, { percentBps: 5000 });
    for (const c of [A, B, V]) {
      const put = await contributions(c, goal.house);
      expect(of(put, id.A)?.totalMinor).toBe(60000 + 100000);
      expect(of(put, id.B)?.totalMinor).toBe(40000);
      expect(put.totalMinor).toBe(200000);
    }
    // The others see the claim and what it put in, never the account.
    const seen = (await B.get(url('/goals'))).body.data.goals as Goal[];
    const alexs = seen.find((g) => g.id === goal.house)!.claims.find((x) => !x.accountName);
    expect(alexs).toMatchObject({ accountName: null, ownerIds: [id.A], percentBps: 5000 });
    expect(Object.keys(await contributions(B, goal.house)).sort()).toEqual([
      'goalId',
      'members',
      'months',
      'thisMonth',
      'totalMinor',
    ]);
  });

  it('doesn’t count money moved between the goal’s own accounts', async () => {
    const before = (await contributions(A, goal.house)).totalMinor;
    await transfer(acct.harbor, acct.alexs, today, 50000);
    await claim(goal.house, acct.harbor, { amountMinor: 1700000 });
    expect((await contributions(A, goal.house)).totalMinor).toBe(before);
  });

  it('keeps a goal of your own’s contributions yours (G15) [GOAL-02/MEM]', async () => {
    const r = await A.post(url('/goals'), {
      name: 'New laptop',
      scope: 'mine',
      targetMinor: 300000,
      claims: [],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    goal.mine = r.body.data.id;
    expect((await A.get(url(`/goals/${goal.mine}/contributions`))).status).toBe(200);
    for (const c of [B, V]) {
      expect((await c.get(url(`/goals/${goal.mine}/contributions`))).status).toBe(404);
    }
  });

  it('tells a joint account’s other owners about its claims, and not a goal of your own’s name (G7, G15)', async () => {
    await claim(goal.mine, acct.harbor, { amountMinor: 10000 });
    const r = await A.request('DELETE', url(`/goals/${goal.mine}/claims/${acct.harbor}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const feed = (await B.get(url('/activity?limit=100'))).body.data as {
      action: string;
      targetId: string | null;
      metadata: Record<string, unknown>;
    }[];
    const told = feed.filter((e) => e.action.startsWith('goal.joint_claim_'));
    expect(told.map((e) => [e.action, e.metadata])).toEqual([
      ['goal.joint_claim_released', { ownGoal: true }],
      ['goal.joint_claim_set', { ownGoal: true }],
      [
        'goal.joint_claim_set',
        { goalId: goal.house, name: 'House down payment', amountMinor: 1700000 },
      ],
      [
        'goal.joint_claim_set',
        { goalId: goal.house, name: 'House down payment', amountMinor: 1650000 },
      ],
      [
        'goal.joint_claim_set',
        { goalId: goal.house, name: 'House down payment', amountMinor: 1500000 },
      ],
    ]);
    expect(told.every((e) => e.targetId === acct.harbor)).toBe(true);
    // Nobody else learns its name or what it is.
    expect(JSON.stringify(feed)).not.toContain('New laptop');
    // A private account has no one else to tell.
    expect(feed.some((e) => e.targetId === acct.alexs)).toBe(false);
  });

  it('shows a newer member the months from their history window on, and their own (#256)', async () => {
    // A goal whose claim grew in a month before Sam joined (today).
    const r = await A.post(url('/goals'), {
      name: 'Cushion',
      targetMinor: 1000000,
      claims: [{ accountId: acct.harbor, amountMinor: 10000 }],
    });
    goal.cushion = r.body.data.id;
    await transfer(acct.checking, acct.harbor, longAgo, 50000);
    await claim(goal.cushion, acct.harbor, { amountMinor: 50000 });
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE goal_claim_events NO FORCE ROW LEVEL SECURITY');
      await db.query(
        `UPDATE goal_claim_events SET at = $2::date + time '12:00' WHERE goal_id = $1`,
        [goal.cushion, longAgo],
      );
      await db.query('ALTER TABLE goal_claim_events FORCE ROW LEVEL SECURITY');
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
    const then = longAgo.slice(0, 7);
    // Alex was there first: all of it, 60/40, in the month it happened.
    const alex = await contributions(A, goal.cushion);
    expect(alex.months).toEqual([
      { month: then, memberId: id.A, amountMinor: 30000 },
      { month: then, memberId: id.B, amountMinor: 20000 },
    ]);
    expect(of(alex, id.A)?.thisMonthMinor).toBe(0);
    // Sam joined since: only their own from before their window.
    expect((await contributions(B, goal.cushion)).months).toEqual([
      { month: then, memberId: id.B, amountMinor: 20000 },
    ]);
    expect((await contributions(V, goal.cushion)).months).toEqual([]);
  });

  it('has no contributions for a pay-down goal', async () => {
    const card = await A.post(url('/accounts'), {
      name: 'Visa',
      type: 'credit',
      visibility: 'full',
      owners: [{ memberId: id.A }, { memberId: id.B }],
      openingBalance: { amountMinor: -100000, asOf: yesterday },
    });
    const made = await A.post(url('/goals/pay-down'), { accountId: card.body.data.id });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await contributions(A, made.body.data.id)).members).toEqual([]);
  });
});
