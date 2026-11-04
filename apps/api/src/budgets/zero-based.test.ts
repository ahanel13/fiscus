// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { ZeroBasedMonth } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Zero-based, end to end (#100, walkthrough §3.2): switching from category limits, Ready to
 * assign, Move money and Cover, a month that assigns afresh, and a category merge carrying moves.
 */
describe('budgets: zero-based', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let hh = '';
  let checking = '';
  let budgetId = '';
  const cat: Record<string, string> = {};
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
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
  const view = async (m: string): Promise<ZeroBasedMonth> => {
    const r = await A.get(url(`/budgets/${budgetId}/months/${m}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data.view;
  };
  const row = (v: ZeroBasedMonth, name: string) => v.rows.find((r) => r.categoryId === cat[name]);
  const move = (m: string, from: string, to: string, amountMinor: number) =>
    A.post(url(`/budgets/${budgetId}/months/${m}/moves`), {
      fromCategoryId: cat[from],
      toCategoryId: cat[to],
      amountMinor,
    });

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    A = new TestClient(app);
    await A.post('/api/v1/auth/signup', {
      email: 'ada@zero.test',
      password: 'zero based Password1!',
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
    budgetId = (
      await A.post(url('/budgets'), {
        amounts: [
          { categoryId: cat.Groceries, amountMinor: 65000 },
          { categoryId: cat.Restaurants, amountMinor: 15000 },
        ],
      })
    ).body.data.id;
    await spend(month(0), '01', 400000, 'Paychecks');
    await spend(month(0), '03', -30000, 'Groceries');
    await spend(month(0), '04', -20000, 'Restaurants');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('previews a switch: the limits become what’s assigned', async () => {
    const r = await A.get(
      url(`/budgets/${budgetId}/strategy-preview?strategy=zero_based&fromMonth=${month(0)}`),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.after.strategy).toBe('zero_based');
    expect(r.body.data.after.ready).toMatchObject({ assignedMinor: 80000, readyMinor: 320000 });
  });

  it('switches this month, and gives every dollar that came in a job (D8)', async () => {
    const r = await A.request('PUT', url(`/budgets/${budgetId}/strategy`), {
      strategy: 'zero_based',
      fromMonth: month(0),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.strategy).toBe('zero_based');
    const v = await view(month(0));
    expect(v.strategy).toBe('zero_based');
    expect(v.assigned).toBe(true);
    expect(v.ready).toMatchObject({
      cameInMinor: 400000,
      assignedMinor: 80000,
      readyMinor: 320000,
    });
    expect(row(v, 'Restaurants')).toMatchObject({ budgetedMinor: 15000, leftMinor: -5000 });
    expect(v.totals).toMatchObject({ overCount: 1, overspentMinor: 5000 });
  });

  it('covers an overspent category from another, leaving Ready to assign alone (D9)', async () => {
    const r = await move(month(0), 'Groceries', 'Restaurants', 5000);
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const v = await view(month(0));
    expect(row(v, 'Restaurants')).toMatchObject({ movedMinor: 5000, leftMinor: 0 });
    expect(row(v, 'Groceries')).toMatchObject({ movedMinor: -5000, leftMinor: 30000 });
    expect(v.ready.readyMinor).toBe(320000);
  });

  it('won’t move more than a category has', async () => {
    const r = await move(month(0), 'Groceries', 'Restaurants', 30001);
    expect([r.status, r.body.code]).toEqual([422, 'not_enough_available']);
    const same = await A.post(url(`/budgets/${budgetId}/months/${month(0)}/moves`), {
      fromCategoryId: cat.Groceries,
      toCategoryId: cat.Groceries,
      amountMinor: 1,
    });
    expect(same.status).toBe(422);
  });

  it('assigns afresh next month, with last month’s amounts a click away', async () => {
    // Assigning in a zero-based month changes that month only.
    const set = await A.request(
      'PUT',
      url(`/budgets/${budgetId}/months/${month(0)}/amounts/${cat.Groceries}`),
      { amountMinor: 70000 },
    );
    expect(set.status, JSON.stringify(set.body)).toBe(204);
    let next = await view(month(1));
    expect(next.assigned).toBe(false);
    expect(next.lastAssigned).toEqual({ month: month(0), assignedMinor: 85000 });
    expect(row(next, 'Groceries')).toMatchObject({ budgetedMinor: 0, rolledInMinor: 35000 });
    // Last month's unassigned money carries.
    expect(next.ready).toMatchObject({ carriedMinor: 315000, readyMinor: 315000 });

    const like = await A.post(
      url(`/budgets/${budgetId}/months/${month(1)}/assign-like-last-month`),
    );
    expect(like.status, JSON.stringify(like.body)).toBe(204);
    next = await view(month(1));
    expect(next.assigned).toBe(true);
    expect(row(next, 'Groceries')?.budgetedMinor).toBe(70000);
    expect(next.ready.readyMinor).toBe(315000 - 85000);
    const again = await A.post(
      url(`/budgets/${budgetId}/months/${month(1)}/assign-like-last-month`),
    );
    expect([again.status, again.body.code]).toEqual([409, 'already_assigned']);
  });

  it('carries moves into the category a merged one goes into', async () => {
    const r = await A.request(
      'DELETE',
      url(`/categories/${cat.Restaurants}?replaceWith=${cat.Coffee}`),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = await view(month(0));
    expect(row(v, 'Coffee')).toMatchObject({ movedMinor: 5000, budgetedMinor: 15000 });
    expect(row(v, 'Groceries')?.movedMinor).toBe(-5000);
  });

  it('moves money only in a zero-based month', async () => {
    const back = await A.request('PUT', url(`/budgets/${budgetId}/strategy`), {
      strategy: 'category',
      fromMonth: month(2),
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const r = await move(month(2), 'Groceries', 'Coffee', 100);
    expect([r.status, r.body.code]).toEqual([409, 'not_zero_based']);
  });
});
