// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Category limits, end to end (#99): starting from the last three months (D5), whose budget it is
 * by finance style (D21), a month's limits, spending and rollover, and amounts carried into a new
 * month until one is changed.
 */
describe('budgets: category limits', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let hh = '';
  let checking = '';
  const cat: Record<string, string> = {};
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  /** `YYYY-MM` `n` months from this one (UTC, the household's time zone). */
  const month = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
  };
  const spend = async (m: string, day: string, amountMinor: number, category: string) => {
    const r = await A.post(url('/transactions'), {
      accountId: checking,
      date: `${m}-${day}`,
      amountMinor,
      displayName: category,
      categoryId: cat[category],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  let budgetId = '';
  const view = async (m: string) => {
    const r = await A.get(url(`/budgets/${budgetId}/months/${m}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const row = (v: { view: { rows: { categoryId: string }[] } }, name: string) =>
    v.view.rows.find((r) => r.categoryId === cat[name]);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    A = new TestClient(app);
    await A.post('/api/v1/auth/signup', {
      email: 'ada@budget.test',
      password: 'budget test Password1!',
      displayName: 'Ada',
    });
    hh = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
    checking = (await A.post(url('/accounts'), { name: 'Checking', type: 'depository' })).body.data
      .id;
    for (const g of (await A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[]) {
      for (const c of g.categories) cat[c.name] = c.id;
    }
    // Three months of history: groceries every month, restaurants twice, a paycheck each month.
    await spend(month(-3), '05', -60000, 'Groceries');
    await spend(month(-2), '05', -70000, 'Groceries');
    await spend(month(-2), '12', -20000, 'Restaurants');
    await spend(month(-1), '05', -65000, 'Groceries');
    await spend(month(-1), '12', -30000, 'Restaurants');
    await spend(month(-1), '20', 5000, 'Restaurants'); // a refund
    for (const n of [-3, -2, -1, 0]) await spend(month(n), '01', 400000, 'Paychecks');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('suggests limits from the last three months, rounded, for you alone in a household of one', async () => {
    const r = await A.get(url('/budgets/suggestion'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = r.body.data;
    expect(s.scope).toBe('mine');
    expect(s.months).toEqual([month(-3), month(-2), month(-1)]);
    const amounts = Object.fromEntries(
      (s.average as { categoryId: string; amountMinor: number }[]).map((a) => [
        a.categoryId,
        a.amountMinor,
      ]),
    );
    // Groceries (600 + 700 + 650) / 3 = 650; restaurants (0 + 200 + 250) / 3 = 150. No paychecks.
    expect(amounts).toEqual({ [cat.Groceries!]: 65000, [cat.Restaurants!]: 15000 });
    expect(s.lastMonth).toEqual(
      expect.arrayContaining([
        { categoryId: cat.Groceries, amountMinor: 65000 },
        { categoryId: cat.Restaurants, amountMinor: 25000 },
      ]),
    );
  });

  it('starts a budget this month, yours, and only one', async () => {
    const r = await A.post(url('/budgets'), {
      amounts: [
        { categoryId: cat.Groceries, amountMinor: 65000 },
        { categoryId: cat.Restaurants, amountMinor: 15000 },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      scope: 'mine',
      startsMonth: month(0),
      strategy: 'category',
    });
    budgetId = r.body.data.id;
    const again = await A.post(url('/budgets'), { amounts: [] });
    expect([again.status, again.body.code]).toEqual([409, 'budget_exists']);
    // Income isn't budgeted.
    const income = await A.post(url('/budgets'), {
      scope: 'household',
      amounts: [{ categoryId: cat.Paychecks, amountMinor: 1 }],
    });
    expect([income.status, income.body.code]).toEqual([422, 'not_a_spending_category']);
    expect((await A.get(url('/budgets'))).body.data).toHaveLength(1);
  });

  it('shows a month: each limit, what’s spent and left, and spending without a limit', async () => {
    await spend(month(0), '01', -40000, 'Groceries');
    await spend(month(0), '01', -20000, 'Restaurants');
    await spend(month(0), '01', -5999, 'Electronics');
    const v = await view(month(0));
    expect(v).toMatchObject({ month: month(0), currency: 'USD', canEdit: true });
    expect(row(v, 'Groceries')).toMatchObject({
      budgetedMinor: 65000,
      spentMinor: 40000,
      leftMinor: 25000,
    });
    expect(row(v, 'Restaurants')).toMatchObject({ leftMinor: -5000 });
    expect(v.view.notBudgeted).toEqual([{ categoryId: cat.Electronics, spentMinor: 5999 }]);
    expect(v.view.incomeMinor).toBe(400000);
    expect(v.view.totals).toEqual({
      budgetedMinor: 80000,
      spentMinor: 65999,
      leftMinor: 20000,
      overCount: 1,
    });
  });

  it('carries limits into next month, and changes one month only', async () => {
    expect(row(await view(month(1)), 'Groceries')).toMatchObject({ budgetedMinor: 65000 });
    const r = await A.request(
      'PUT',
      url(`/budgets/${budgetId}/months/${month(1)}/amounts/${cat.Groceries}`),
      { amountMinor: 70000 },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const next = await view(month(1));
    expect(row(next, 'Groceries')).toMatchObject({ budgetedMinor: 70000 });
    // The other limit came along, and this month kept its own.
    expect(row(next, 'Restaurants')).toMatchObject({ budgetedMinor: 15000 });
    expect(row(await view(month(0)), 'Groceries')).toMatchObject({ budgetedMinor: 65000 });
  });

  it('rolls what’s left into next month once rollover is on', async () => {
    const r = await A.request('PUT', url(`/budgets/${budgetId}/categories/${cat.Groceries}`), {
      rollover: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    // 250 left this month, on top of next month's 700.
    expect(row(await view(month(1)), 'Groceries')).toMatchObject({
      rolledInMinor: 25000,
      leftMinor: 95000,
      rollover: true,
    });
  });

  it('gives a category’s last six months: its limit once the budget began, and spending throughout', async () => {
    const r = await A.get(
      url(`/budgets/${budgetId}/categories/${cat.Groceries}/history?to=${month(0)}`),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.months).toEqual([
      { month: month(-5), budgetedMinor: null, spentMinor: 0 },
      { month: month(-4), budgetedMinor: null, spentMinor: 0 },
      { month: month(-3), budgetedMinor: null, spentMinor: 60000 },
      { month: month(-2), budgetedMinor: null, spentMinor: 70000 },
      { month: month(-1), budgetedMinor: null, spentMinor: 65000 },
      { month: month(0), budgetedMinor: 65000, spentMinor: 40000 },
    ]);
    // This month isn't over, so it isn't in the average.
    expect(r.body.data.averageSpentMinor).toBe(65000);
    const income = await A.get(
      url(`/budgets/${budgetId}/categories/${cat.Paychecks}/history?to=${month(0)}`),
    );
    expect(income.status).toBe(404);
  });

  it('previews a switch to flex, starting from the flexible limits added up (#104)', async () => {
    const r = await A.get(
      url(`/budgets/${budgetId}/strategy-preview?strategy=flex&fromMonth=${month(1)}`),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Next month's flexible limits: groceries 700 (changed above) and restaurants 150.
    expect(r.body.data.flexibleMinor).toBe(85000);
    expect(r.body.data.before.strategy).toBe('category');
    expect(r.body.data.after).toMatchObject({
      strategy: 'flex',
      flexible: { budgetedMinor: 85000 },
    });
    const past = await A.get(
      url(`/budgets/${budgetId}/strategy-preview?strategy=flex&fromMonth=${month(-1)}`),
    );
    expect([past.status, past.body.code]).toEqual([422, 'switch_month_started']);
  });

  it('switches to flex from next month, keeping this month as it was (D14)', async () => {
    const r = await A.request('PUT', url(`/budgets/${budgetId}/strategy`), {
      strategy: 'flex',
      fromMonth: month(1),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await view(month(0))).view.strategy).toBe('category');
    const next = await view(month(1));
    expect(next.budget.strategy).toBe('flex');
    expect(next.view.flexible).toMatchObject({ budgetedMinor: 85000 });
    const again = await A.request('PUT', url(`/budgets/${budgetId}/strategy`), {
      strategy: 'flex',
      fromMonth: month(1),
    });
    expect([again.status, again.body.code]).toEqual([409, 'same_strategy']);
  });

  it('changes the flexible number from a month, and a non-monthly yearly figure', async () => {
    const flexR = await A.request('PUT', url(`/budgets/${budgetId}/months/${month(2)}/flexible`), {
      amountMinor: 90000,
    });
    expect(flexR.status, JSON.stringify(flexR.body)).toBe(204);
    expect((await view(month(1))).view.flexible.budgetedMinor).toBe(85000);
    expect((await view(month(2))).view.flexible.budgetedMinor).toBe(90000);
    // Not flex this month.
    const notFlex = await A.request(
      'PUT',
      url(`/budgets/${budgetId}/months/${month(0)}/flexible`),
      {
        amountMinor: 1,
      },
    );
    expect([notFlex.status, notFlex.body.code]).toEqual([409, 'not_flex']);

    const yearly = await A.request('PUT', url(`/budgets/${budgetId}/categories/${cat.Flights}`), {
      yearlyMinor: 240000,
    });
    expect(yearly.status, JSON.stringify(yearly.body)).toBe(204);
    expect(
      (await view(month(1))).view.nonMonthly.find(
        (r: { categoryId: string }) => r.categoryId === cat.Flights,
      ),
    ).toMatchObject({ yearlyMinor: 240000, setAsideMinor: 20000, savedMinor: 20000 });
    // Groceries kept its rollover through the change.
    const g = await A.get(
      url(`/budgets/${budgetId}/categories/${cat.Groceries}/history?to=${month(1)}`),
    );
    expect(g.status).toBe(200);
  });

  it('has nothing before its first month, or for a month that isn’t one', async () => {
    const before = await A.get(url(`/budgets/${budgetId}/months/${month(-1)}`));
    expect([before.status, before.body.code]).toEqual([404, 'before_budget']);
    expect((await A.get(url(`/budgets/${budgetId}/months/2026-13`))).status).toBe(422);
  });
});
