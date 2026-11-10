// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type {
  BudgetMonth,
  CategoryLimitsMonth,
  Goal,
  PercentageMonth,
  ZeroBasedMonth,
} from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Goals in the budget, end to end (goals and budgets G4, G5, G9, G13, G16): a goal's plan is its
 * line, changed from either side; what moved is what reached its accounts, split by claims, or
 * what was paid over a debt's minimum; and each strategy treats the line its own way.
 */
describe('budgets: goal lines', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  let budgetId = '';
  const acct = { checking: '', harbor: '', visa: '' };
  const goal = { trip: '', house: '', visa: '', mine: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const month = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
  };
  const day = (d: string) => `${month(0)}-${d}`;
  const read = async (m = month(0), c = A): Promise<BudgetMonth> => {
    const r = await c.get(url(`/budgets/${budgetId}/months/${m}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const line = <T extends { goalId: string }>(v: { goals: T[] }, goalId: string) =>
    v.goals.find((g) => g.goalId === goalId);
  const setLine = (goalId: string, amountMinor: number, m = month(0), c = A, applyTo?: string) =>
    c.request('PUT', url(`/budgets/${budgetId}/months/${m}/goals/${goalId}`), {
      amountMinor,
      ...(applyTo ? { applyTo } : {}),
    });
  const goalOf = async (goalId: string): Promise<Goal> =>
    ((await A.get(url('/goals'))).body.data.goals as Goal[]).find((g) => g.id === goalId)!;
  /** A transfer: both legs, which Fiscus links. */
  const transfer = async (from: string, to: string, d: string, amountMinor: number) => {
    for (const [accountId, amount] of [
      [from, -amountMinor],
      [to, amountMinor],
    ] as const) {
      const r = await A.post(url('/transactions'), {
        accountId,
        date: day(d),
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
        email: `${name}@lines.test`,
        password: 'goal lines Password1!',
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
      [B, 'sam@lines.test', 'member'],
      [V, 'vic@lines.test', 'viewer'],
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
    acct.checking = await make({ name: 'Checking', type: 'depository', subtype: 'checking' });
    acct.harbor = await make({
      name: 'Harbor Savings',
      type: 'depository',
      subtype: 'savings',
      openingBalance: { amountMinor: 1000000, asOf: yesterday },
    });
    acct.visa = await make({
      name: 'Visa',
      type: 'credit',
      subtype: 'credit_card',
      openingBalance: { amountMinor: -500000, asOf: yesterday },
    });
    // The household's budget (Hybrid makes it Ours).
    budgetId = (await A.post(url('/budgets'), { amounts: [] })).body.data.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('puts an Ours goal’s plan in the Ours budget as its line (G4, G16)', async () => {
    const trip = await A.post(url('/goals'), {
      name: 'Japan trip',
      targetMinor: 800000,
      planMinor: 40000,
      claims: [{ accountId: acct.harbor, amountMinor: 300000 }],
    });
    expect(trip.status, JSON.stringify(trip.body)).toBe(201);
    goal.trip = trip.body.data.id;
    const m = await read();
    expect(m.goals).toEqual([
      expect.objectContaining({
        id: goal.trip,
        name: 'Japan trip',
        kind: 'save',
        accountNames: ['Harbor Savings'],
        archived: false,
      }),
    ]);
    expect(line(m.view as CategoryLimitsMonth, goal.trip)).toEqual({
      goalId: goal.trip,
      budgetedMinor: 40000,
      movedMinor: 0,
      leftMinor: 40000,
    });
    // Earmarking money already there isn't moving it (G11).
    expect((m.view as CategoryLimitsMonth).totals.budgetedMinor).toBe(0);
  });

  it('counts what moved into its accounts, split by claims (G4, G13)', async () => {
    await transfer(acct.checking, acct.harbor, '02', 30000);
    expect(line((await read()).view as CategoryLimitsMonth, goal.trip)).toMatchObject({
      movedMinor: 30000,
      leftMinor: 10000,
    });
    // A second goal on the same account: $3,000 and $6,000 claimed, so a third and two thirds.
    const house = await A.post(url('/goals'), {
      name: 'House',
      targetMinor: 6000000,
      planMinor: 60000,
      claims: [{ accountId: acct.harbor, amountMinor: 600000 }],
    });
    goal.house = house.body.data.id;
    const v = (await read()).view as CategoryLimitsMonth;
    expect(line(v, goal.trip)?.movedMinor).toBe(10000);
    expect(line(v, goal.house)?.movedMinor).toBe(20000);
  });

  it('counts a debt’s payments over its minimum (G9)', async () => {
    const r = await A.post(url('/goals/pay-down'), {
      accountId: acct.visa,
      planMinor: 25000,
      minimumMinor: 13000,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    goal.visa = r.body.data.id;
    await transfer(acct.checking, acct.visa, '05', 33000);
    const m = await read();
    expect(m.goals.find((g) => g.id === goal.visa)).toMatchObject({
      kind: 'pay_down',
      accountNames: ['Visa'],
    });
    expect(line(m.view as CategoryLimitsMonth, goal.visa)).toEqual({
      goalId: goal.visa,
      budgetedMinor: 25000,
      movedMinor: 20000,
      leftMinor: 5000,
    });
  });

  it('changes the goal’s plan with its line, from that month on (G16) [BUD-03/MEM]', async () => {
    const before = await goalOf(goal.trip);
    const r = await setLine(goal.trip, 50000, month(0), B);
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const after = await goalOf(goal.trip);
    expect(after.planMinor).toBe(50000);
    expect(after.version).toBe(before.version + 1);
    expect(line((await read(month(2))).view as CategoryLimitsMonth, goal.trip)?.budgetedMinor).toBe(
      50000,
    );
    // Next month only: the month after keeps what it had, and the goal's plan is this month's.
    expect((await setLine(goal.trip, 70000, month(1), A, 'month')).status).toBe(204);
    expect(line((await read(month(1))).view as CategoryLimitsMonth, goal.trip)?.budgetedMinor).toBe(
      70000,
    );
    expect(line((await read(month(2))).view as CategoryLimitsMonth, goal.trip)?.budgetedMinor).toBe(
      50000,
    );
    expect((await goalOf(goal.trip)).planMinor).toBe(50000);
  });

  it('changes the line with the goal’s plan, from this month on (G16)', async () => {
    const g = await goalOf(goal.trip);
    const r = await A.request(
      'PATCH',
      url(`/goals/${goal.trip}`),
      { planMinor: 45000 },
      { headers: { 'if-match': `"v${g.version}"` } },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const m of [month(0), month(1), month(2)]) {
      expect(line((await read(m)).view as CategoryLimitsMonth, goal.trip)?.budgetedMinor).toBe(
        45000,
      );
    }
  });

  it('keeps viewers and other scopes’ goals out [BUD-03/VIEW]', async () => {
    expect((await setLine(goal.trip, 1000, month(0), V)).status).toBe(403);
    // Sam's own goal isn't in the household's budget, and Alex doesn't see it at all.
    const mine = await B.post(url('/goals'), { name: 'Bike', targetMinor: 90000, scope: 'mine' });
    goal.mine = mine.body.data.id;
    expect((await read()).goals.map((g) => g.id)).not.toContain(goal.mine);
    expect((await setLine(goal.mine, 1000, month(0), B)).status).toBe(404);
    expect((await setLine(goal.mine, 1000, month(0), A)).status).toBe(404);
  });

  it('refuses a line on an archived goal, and keeps its month’s line', async () => {
    const r = await A.request('PUT', url(`/goals/${goal.house}/archived`), { archived: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const refused = await setLine(goal.house, 1000);
    expect([refused.status, refused.body.code]).toEqual([409, 'goal_archived']);
    // Archived this month: its line stays for the month, with what moved.
    const m = await read();
    expect(m.goals.find((g) => g.id === goal.house)?.archived).toBe(true);
    expect(line(m.view as CategoryLimitsMonth, goal.house)).toBeDefined();
  });

  it('counts goals in 50/30/20’s Savings once (G5)', async () => {
    const r = await A.request('PUT', url(`/budgets/${budgetId}/strategy`), {
      strategy: 'percentage',
      fromMonth: month(0),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const savings = ((await read()).view as PercentageMonth).buckets.find((b) => b.saving)!;
    // $300 into Harbor Savings is counted as saving already; the $200 extra on the Visa is added.
    expect(savings).toMatchObject({ movedToSavingsMinor: 30000, spentMinor: 50000 });
    // The house's claim ended with it, so the transfer is split by the claims there are now.
    expect(savings.goals).toEqual(
      expect.arrayContaining([
        { goalId: goal.trip, movedMinor: 30000 },
        { goalId: goal.visa, movedMinor: 20000 },
      ]),
    );
  });

  it('assigns the plan in zero-based, from Ready to assign (G5)', async () => {
    const r = await A.request('PUT', url(`/budgets/${budgetId}/strategy`), {
      strategy: 'zero_based',
      fromMonth: month(1),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Next month assigns afresh; a plan set in it is assigned, even before anything else is.
    expect((await setLine(goal.trip, 45000, month(1), A, 'month')).status).toBe(204);
    const next = (await read(month(1))).view as ZeroBasedMonth;
    expect(next.goals.find((g) => g.goalId === goal.trip)?.budgetedMinor).toBe(45000);
    expect(next.goals.find((g) => g.goalId === goal.visa)?.budgetedMinor).toBe(0);
    expect(next.ready.assignedMinor).toBe(45000);
  });

  it('moves money to and from a goal line’s to-move money in zero-based (goals and budgets §7)', async () => {
    const cats = (
      (await A.get(url('/categories'))).body.data as {
        categories: { id: string; name: string }[];
      }[]
    ).flatMap((g) => g.categories);
    const groceries = cats.find((c) => c.name === 'Groceries')!.id;
    const put = await A.request(
      'PUT',
      url(`/budgets/${budgetId}/months/${month(1)}/amounts/${groceries}`),
      { amountMinor: 30000, applyTo: 'month' },
    );
    expect(put.status, JSON.stringify(put.body)).toBe(204);
    const move = (body: Record<string, unknown>, c = A) =>
      c.post(url(`/budgets/${budgetId}/months/${month(1)}/moves`), body);
    const state = async () => {
      const v = (await read(month(1))).view as ZeroBasedMonth;
      return {
        trip: v.goals.find((g) => g.goalId === goal.trip)!,
        visa: v.goals.find((g) => g.goalId === goal.visa)!,
        groceries: v.rows.find((r) => r.categoryId === groceries)!.leftMinor,
        ready: v.ready.assignedMinor,
      };
    };

    const assigned = (await state()).ready;
    // From a category to a goal, and back: Ready to assign doesn't change.
    expect(
      (await move({ fromCategoryId: groceries, toGoalId: goal.trip, amountMinor: 10000 })).status,
    ).toBe(204);
    let s = await state();
    expect([s.trip.movedMinor, s.trip.leftMinor, s.groceries, s.ready]).toEqual([
      10000,
      55000,
      20000,
      assigned,
    ]);
    expect(
      (await move({ fromGoalId: goal.trip, toCategoryId: groceries, amountMinor: 20000 })).status,
    ).toBe(204);
    // From one goal to another.
    expect(
      (await move({ fromGoalId: goal.trip, toGoalId: goal.visa, amountMinor: 5000 })).status,
    ).toBe(204);
    s = await state();
    expect([s.trip.movedMinor, s.trip.leftMinor, s.visa.movedMinor, s.groceries]).toEqual([
      -15000, 30000, 5000, 40000,
    ]);

    // Only what's still to move, never the goal's claims.
    const tooMuch = await move({
      fromGoalId: goal.trip,
      toCategoryId: groceries,
      amountMinor: 30001,
    });
    expect([tooMuch.status, tooMuch.body.code]).toEqual([422, 'not_enough_available']);
    // Not an archived goal, another scope's, a viewer, or a line to itself.
    const archived = await move({
      fromCategoryId: groceries,
      toGoalId: goal.house,
      amountMinor: 100,
    });
    expect([archived.status, archived.body.code]).toEqual([409, 'goal_archived']);
    expect(
      (await move({ fromCategoryId: groceries, toGoalId: goal.mine, amountMinor: 100 })).status,
    ).toBe(404);
    expect(
      (await move({ fromCategoryId: groceries, toGoalId: goal.trip, amountMinor: 100 }, V)).status,
    ).toBe(403);
    for (const bad of [
      { fromGoalId: goal.trip, toGoalId: goal.trip },
      { fromCategoryId: groceries, fromGoalId: goal.trip, toGoalId: goal.visa },
      { toGoalId: goal.visa },
    ])
      expect((await move({ ...bad, amountMinor: 100 })).status).toBe(422);
    expect((await state()).trip.leftMinor).toBe(30000);
  });
});
