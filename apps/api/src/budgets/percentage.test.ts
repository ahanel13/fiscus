// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { PercentageMonth } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * 50/30/20, end to end (#101, walkthrough §3.3): buckets by group kind, money moved into a
 * savings account counted in Savings, moving a category between buckets, and changing the split.
 */
describe('budgets: 50/30/20', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let hh = '';
  let checking = '';
  let savings = '';
  let budgetId = '';
  const cat: Record<string, string> = {};
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const month = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
  };
  const add = async (accountId: string, day: string, amountMinor: number, category?: string) => {
    const r = await A.post(url('/transactions'), {
      accountId,
      date: `${month(0)}-${day}`,
      amountMinor,
      displayName: category ?? 'Move to savings',
      ...(category ? { categoryId: cat[category] } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  const view = async (): Promise<PercentageMonth> => {
    const r = await A.get(url(`/budgets/${budgetId}/months/${month(0)}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data.view;
  };
  const bucket = (v: PercentageMonth, key: string) => v.buckets.find((b) => b.key === key)!;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    A = new TestClient(app);
    await A.post('/api/v1/auth/signup', {
      email: 'ada@split.test',
      password: 'fifty thirty Password1!',
      displayName: 'Ada',
    });
    hh = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
    checking = (await A.post(url('/accounts'), { name: 'Checking', type: 'depository' })).body.data
      .id;
    savings = (
      await A.post(url('/accounts'), { name: 'Savings', type: 'depository', subtype: 'savings' })
    ).body.data.id;
    for (const g of (await A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[]) {
      for (const c of g.categories) cat[c.name] = c.id;
    }
    budgetId = (await A.post(url('/budgets'), { amounts: [] })).body.data.id;
    await add(checking, '01', 500000, 'Paychecks');
    await add(checking, '02', -150000, 'Rent or mortgage');
    await add(checking, '03', -40000, 'Restaurants');
    await add(checking, '04', -20000, 'Medical');
    // Into savings: a linked transfer, which no budget counts as spending.
    await add(checking, '05', -60000);
    await add(savings, '05', 60000);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('switches to 50/30/20, and splits this month’s income', async () => {
    const r = await A.request('PUT', url(`/budgets/${budgetId}/strategy`), {
      strategy: 'percentage',
      fromMonth: month(0),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = await view();
    expect(v.strategy).toBe('percentage');
    expect(v.base.amountMinor).toBe(500000);
    expect(v.buckets.map((b) => [b.key, b.targetMinor])).toEqual([
      ['needs', 250000],
      ['wants', 150000],
      ['savings', 100000],
    ]);
  });

  it('fills buckets by group kind, and counts money moved into savings (D10)', async () => {
    const v = await view();
    expect(bucket(v, 'needs').spentMinor).toBe(150000);
    expect(bucket(v, 'wants').spentMinor).toBe(40000 + 20000);
    expect(bucket(v, 'savings')).toMatchObject({ spentMinor: 60000, movedToSavingsMinor: 60000 });
  });

  it('moves a category to another bucket, and back', async () => {
    const r = await A.request('PUT', url(`/budgets/${budgetId}/categories/${cat.Medical}`), {
      bucket: 'needs',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    let v = await view();
    expect(bucket(v, 'needs').spentMinor).toBe(170000);
    expect(bucket(v, 'wants').spentMinor).toBe(40000);
    await A.request('PUT', url(`/budgets/${budgetId}/categories/${cat.Medical}`), {
      bucket: null,
    });
    v = await view();
    expect(bucket(v, 'wants').spentMinor).toBe(60000);
  });

  it('changes the split, which adds up to 100%', async () => {
    const bad = await A.request('PUT', url(`/budgets/${budgetId}/months/${month(0)}/percentage`), {
      buckets: [{ key: 'needs', name: 'Needs', percent: 90 }],
      base: 'after_contributions',
      income: 'actual',
      expectedMinor: null,
    });
    expect(bad.status).toBe(422);
    const r = await A.request('PUT', url(`/budgets/${budgetId}/months/${month(0)}/percentage`), {
      buckets: [
        { key: 'needs', name: 'Needs', percent: 60 },
        { key: 'wants', name: 'Fun', percent: 20 },
        { key: 'savings', name: 'Savings', percent: 20 },
      ],
      base: 'after_contributions',
      income: 'expected',
      expectedMinor: 400000,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const v = await view();
    expect(v.base).toMatchObject({ income: 'expected', amountMinor: 400000 });
    expect(bucket(v, 'wants')).toMatchObject({ name: 'Fun', targetMinor: 80000 });
    expect(v.settings.expectedMinor).toBe(400000);
  });

  it('has no per-category limits in the year (D10)', async () => {
    const year = Number(month(0).slice(0, 4));
    const r = await A.get(url(`/budgets/${budgetId}/years/${year}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const i = (r.body.data.months as string[]).indexOf(month(0));
    for (const row of r.body.data.rows as { months: { budgetedMinor: number | null }[] }[]) {
      expect(row.months[i]!.budgetedMinor).toBeNull();
    }
  });
});
