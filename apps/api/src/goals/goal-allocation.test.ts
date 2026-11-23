// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { type Goal, type GoalsOverview, suggestAllocation } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Unclaimed money toward goals, by priority (#136, G25, GOAL-10): the suggestion is worked out
 * from what you see, and nothing is claimed until you confirm it. Confirmed, each step adds to a
 * goal's fixed claim, by the account's owners only, never beyond what's free, all or none.
 */
describe('goal allocation', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  const id = { A: '', B: '', V: '' };
  const acct = { harbor: '', alexs: '', checking: '' };
  const goal = { cushion: '', trip: '', mine: '', debt: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const overview = async (c: TestClient): Promise<GoalsOverview> => {
    const r = await c.get(url('/goals'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const find = async (c: TestClient, goalId: string): Promise<Goal> =>
    (await overview(c)).goals.find((g) => g.id === goalId)!;
  const allocate = (c: TestClient, add: object[]) => c.post(url('/goals/allocate'), { add });
  const fixedOn = (g: Goal, accountId: string) =>
    g.claims.find((c) => c.accountId === accountId)?.amountMinor ?? null;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@allocate.test`,
        password: 'allocate test Password1!',
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
      [B, 'sam@allocate.test', 'member'],
      [V, 'vic@allocate.test', 'viewer'],
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
    acct.harbor = await make({
      name: 'Harbor Savings',
      subtype: 'savings',
      visibility: 'full',
      owners: [{ memberId: id.A }, { memberId: id.B }],
      openingBalance: { amountMinor: 1000000, asOf: yesterday },
    });
    acct.alexs = await make({
      name: 'Alex savings',
      subtype: 'savings',
      visibility: 'private',
      openingBalance: { amountMinor: 300000, asOf: yesterday },
    });
    acct.checking = await make({
      name: 'Everyday checking',
      subtype: 'checking',
      visibility: 'full',
      openingBalance: { amountMinor: 500000, asOf: yesterday },
    });
    const card = await A.post(url('/accounts'), {
      type: 'credit',
      name: 'Visa',
      visibility: 'full',
      openingBalance: { amountMinor: -120000, asOf: yesterday },
    });
    // Priority: the cushion, then the trip, then Alex's own goal.
    const create = async (c: TestClient, body: object) => {
      const r = await c.post(url('/goals'), body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.id as string;
    };
    goal.cushion = await create(A, {
      name: 'Cushion',
      targetMinor: 600000,
      claims: [{ accountId: acct.harbor, amountMinor: 200000 }],
    });
    goal.trip = await create(A, { name: 'Japan trip', targetMinor: 900000 });
    goal.mine = await create(A, { name: 'Alex’s bike', scope: 'mine', targetMinor: 150000 });
    const debt = await A.post(url('/goals/pay-down'), { accountId: card.body.data.id });
    expect(debt.status, JSON.stringify(debt.body)).toBe(201);
    goal.debt = debt.body.data.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('works out the suggestion from what you see, and changes nothing until you confirm', async () => {
    const view = await overview(A);
    const harbor = view.accounts.find((a) => a.accountId === acct.harbor)!;
    expect(harbor).toMatchObject({ subtype: 'savings', unclaimedMinor: 800000 });
    expect(view.accounts.find((a) => a.accountId === acct.checking)?.subtype).toBe('checking');
    const steps = suggestAllocation(
      view.goals
        .filter((g) => g.kind === 'save')
        .map((g) => ({
          goalId: g.id,
          needMinor: g.targetMinor - g.progressMinor,
          claims: g.claims
            .filter((c) => c.yours)
            .map((c) => ({ accountId: c.accountId, fixed: c.amountMinor !== null })),
        })),
      view.accounts,
    );
    // The cushion's $4,000.00 from Harbor, which it draws on already; then the trip's from what's
    // left of Harbor and Alex's savings. Checking isn't offered.
    expect(steps).toEqual([
      { goalId: goal.cushion, accountId: acct.harbor, amountMinor: 400000 },
      { goalId: goal.trip, accountId: acct.harbor, amountMinor: 400000 },
      { goalId: goal.trip, accountId: acct.alexs, amountMinor: 300000 },
    ]);
    // Seeing it moved nothing.
    expect(fixedOn(await find(A, goal.cushion), acct.harbor)).toBe(200000);
    expect((await find(A, goal.trip)).claims).toEqual([]);
  });

  it('adds what you confirm to the goals’ claims, as earmarked [GOAL-10/OWN]', async () => {
    const r = await allocate(A, [
      { goalId: goal.cushion, accountId: acct.harbor, amountMinor: 400000 },
      { goalId: goal.trip, accountId: acct.alexs, amountMinor: 100000 },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const cushion = await find(A, goal.cushion);
    expect(fixedOn(cushion, acct.harbor)).toBe(600000);
    expect(cushion).toMatchObject({ progressMinor: 600000, done: true });
    const trip = await find(A, goal.trip);
    expect(fixedOn(trip, acct.alexs)).toBe(100000);
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      const { rows } = await db.query(
        `SELECT reason, amount_before_minor, amount_after_minor FROM goal_claim_events
         WHERE goal_id = $1 ORDER BY id`,
        [goal.cushion],
      );
      expect(rows.at(-1)).toEqual({
        reason: 'earmarked',
        amount_before_minor: '200000',
        amount_after_minor: '600000',
      });
    } finally {
      await db.end();
    }
    // Harbor's other owner is told, as for any claim (GOAL-05); Alex's private account has no one.
    const feed = (await B.get(url('/activity?limit=100'))).body.data as {
      action: string;
      targetId: string | null;
      metadata: Record<string, unknown>;
    }[];
    const told = feed.filter((e) => e.action === 'goal.joint_claim_set');
    expect(told.map((e) => [e.targetId, e.metadata])).toContainEqual([
      acct.harbor,
      { goalId: goal.cushion, name: 'Cushion', amountMinor: 600000 },
    ]);
    expect(told.some((e) => e.targetId === acct.alexs)).toBe(false);
  });

  it('does all of it or none: never beyond what’s free (G3)', async () => {
    const r = await allocate(A, [
      { goalId: goal.trip, accountId: acct.harbor, amountMinor: 100000 },
      // Alex savings has $2,000.00 free.
      { goalId: goal.mine, accountId: acct.alexs, amountMinor: 250000 },
    ]);
    expect(r.status).toBe(422);
    expect(r.body.detail).toBe('Alex savings has $2,000.00 free for this goal.');
    expect(fixedOn(await find(A, goal.trip), acct.harbor)).toBeNull();
  });

  it('lets a member allocate from an account they own, to a goal they see [GOAL-10/MEM]', async () => {
    const r = await allocate(B, [
      { goalId: goal.trip, accountId: acct.harbor, amountMinor: 50000 },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect(fixedOn(await find(A, goal.trip), acct.harbor)).toBe(50000);
    // Alex's own goal doesn't exist for Sam (G15); Alex's private account isn't Sam's to claim.
    expect(
      (await allocate(B, [{ goalId: goal.mine, accountId: acct.harbor, amountMinor: 100 }])).status,
    ).toBe(404);
    expect(
      (await allocate(B, [{ goalId: goal.trip, accountId: acct.alexs, amountMinor: 100 }])).status,
    ).toBe(403);
  });

  it('refuses viewers [GOAL-10/VIEW]', async () => {
    const r = await allocate(V, [{ goalId: goal.trip, accountId: acct.harbor, amountMinor: 100 }]);
    expect(r.status).toBe(403);
    expect(fixedOn(await find(A, goal.trip), acct.harbor)).toBe(50000);
  });

  it('leaves percentage claims and pay-down goals alone', async () => {
    const pct = await A.request('PUT', url(`/goals/${goal.mine}/claims/${acct.alexs}`), {
      percentBps: 1000,
    });
    expect(pct.status, JSON.stringify(pct.body)).toBe(200);
    const r = await allocate(A, [{ goalId: goal.mine, accountId: acct.alexs, amountMinor: 100 }]);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('percent_claim');
    expect(
      (await allocate(A, [{ goalId: goal.debt, accountId: acct.harbor, amountMinor: 100 }])).body
        .code,
    ).toBe('pay_down_no_claims');
  });

  it('asks for each goal and account once', async () => {
    const twice = { goalId: goal.trip, accountId: acct.harbor, amountMinor: 100 };
    expect((await allocate(A, [twice, twice])).status).toBe(422);
  });
});
