// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { addMonths } from '@fiscus/domain';
import { budgetMonthSql } from '@fiscus/ledger';
import { addDays, budgetMonthOf, budgetMonthStart, todayIn } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * The budget month start day (#71, ADR 0011 §4): a household setting, day 1 by default. Months
 * are named for the month they start in, and a start day a month doesn't have falls on its last
 * day. Changing it keeps every amount with its month and recounts what each month spent.
 */
describe('budgets: month start day', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let hh = '';
  let checking = '';
  let budgetId = '';
  const cat: Record<string, string> = {};
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const today = () => todayIn('UTC');
  /** Calendar months from this one. */
  const cal = (n: number) => addMonths(today().slice(0, 7), n);
  const household = async () => (await A.get(url())).body.data;
  const setStartDay = async (budgetMonthStartDay: number) =>
    A.request(
      'PATCH',
      url(),
      { budgetMonthStartDay },
      { headers: { 'if-match': `"v${(await household()).version}"` } },
    );
  const spend = async (date: string, amountMinor: number) => {
    const r = await A.post(url('/transactions'), {
      accountId: checking,
      date,
      amountMinor,
      displayName: 'Groceries',
      categoryId: cat.Groceries,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  const view = async (m: string) => {
    const r = await A.get(url(`/budgets/${budgetId}/months/${m}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const groceries = async (m: string) =>
    (await view(m)).view.rows.find((r: { categoryId: string }) => r.categoryId === cat.Groceries);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    A = new TestClient(app);
    await A.post('/api/v1/auth/signup', {
      email: 'ada@startday.test',
      password: 'start day test Password1!',
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
    const r = await A.post(url('/budgets'), {
      amounts: [{ categoryId: cat.Groceries, amountMinor: 50000 }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    budgetId = r.body.data.id;
    // Give it two months of history: it started two months ago, with the same amounts.
    const db = new pg.Client({ connectionString: tdb.maintenanceUrl });
    await db.connect();
    try {
      const first = `${cal(-2)}-01`;
      await db.query('UPDATE budgets SET starts_month = $2 WHERE id = $1', [budgetId, first]);
      await db.query('UPDATE budget_amounts SET month = $2 WHERE budget_id = $1', [
        budgetId,
        first,
      ]);
      await db.query('UPDATE budget_strategies SET from_month = $2 WHERE budget_id = $1', [
        budgetId,
        first,
      ]);
    } finally {
      await db.end();
    }
    const rollover = await A.request(
      'PUT',
      url(`/budgets/${budgetId}/categories/${cat.Groceries}`),
      { rollover: true },
    );
    expect(rollover.status, JSON.stringify(rollover.body)).toBe(204);
    await spend(`${cal(-2)}-10`, -20000);
    await spend(`${cal(-1)}-05`, -10000);
    await spend(`${cal(-1)}-20`, -30000);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('is day 1 for a new household, so months are calendar months', async () => {
    expect((await household()).budgetMonthStartDay).toBe(1);
    const m = await view(cal(-2));
    expect([m.from, m.to, m.partial]).toEqual([
      `${cal(-2)}-01`,
      addDays(`${cal(-1)}-01`, -1),
      false,
    ]);
    expect(await groceries(cal(-2))).toMatchObject({ spentMinor: 20000, leftMinor: 30000 });
    expect(await groceries(cal(-1))).toMatchObject({
      rolledInMinor: 30000,
      spentMinor: 40000,
      leftMinor: 40000,
    });
    expect(await groceries(cal(0))).toMatchObject({ rolledInMinor: 40000 });
  });

  it('takes a day from 1 to 31, and nothing else', async () => {
    for (const bad of [0, 32, 1.5]) {
      const r = await setStartDay(bad);
      expect(r.status, `${bad}`).toBe(422);
    }
  });

  it('moves every month’s edges when it changes, and keeps each month’s amounts', async () => {
    const r = await setStartDay(15);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.budgetMonthStartDay).toBe(15);
    const m = await view(cal(-2));
    expect([m.from, m.to]).toEqual([`${cal(-2)}-15`, `${cal(-1)}-14`]);
    // The 10th of the first month is now before the budget; the 5th of the next counts in it.
    expect(await groceries(cal(-2))).toMatchObject({
      budgetedMinor: 50000,
      spentMinor: 10000,
      leftMinor: 40000,
    });
    // Rollover follows the months as they now are.
    expect(await groceries(cal(-1))).toMatchObject({
      budgetedMinor: 50000,
      rolledInMinor: 40000,
      spentMinor: 30000,
      leftMinor: 60000,
    });
    // This month is the one today is in: last month's, before the 15th.
    const current = budgetMonthOf(today(), 15);
    const list = await A.get(url('/budgets'));
    expect(list.status).toBe(200);
    const now = await view(current);
    expect(now).toMatchObject({ partial: true, to: today() });
    expect(now.from <= today() && today() <= now.periodEnd).toBe(true);
  });

  it('gives back the calendar months when it’s changed back', async () => {
    expect((await setStartDay(1)).status).toBe(200);
    expect(await groceries(cal(-2))).toMatchObject({ spentMinor: 20000, leftMinor: 30000 });
    expect(await groceries(cal(-1))).toMatchObject({ rolledInMinor: 30000, leftMinor: 40000 });
  });

  it('records the change in the household’s activity', async () => {
    const r = await A.get(url('/activity'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const changes = (
      r.body.data as { action: string; changes?: { before: object; after: object } }[]
    ).filter((e) => e.action === 'household.updated');
    expect(changes.map((e) => e.changes)).toEqual(
      expect.arrayContaining([
        { before: { budgetMonthStartDay: 1 }, after: { budgetMonthStartDay: 15 } },
        { before: { budgetMonthStartDay: 15 }, after: { budgetMonthStartDay: 1 } },
      ]),
    );
  });

  /**
   * Features that came after it count in budget months too (#71): the 3-month average, a newer
   * member's first month under the history window (#256), and allowances (#114). A start day
   * after today's day makes the budget month last calendar month's, so each answer changes. On a
   * month's last day no start day does that, and the 15th still checks they agree.
   */
  describe('in what came after it', () => {
    const shifting = Array.from({ length: 30 }, (_, i) => i + 2).find(
      (d) => budgetMonthOf(today(), d) !== today().slice(0, 7),
    );
    const day = shifting ?? 15;
    const current = () => budgetMonthOf(today(), day);
    let B: TestClient;
    let ours = '';

    beforeAll(async () => {
      expect((await setStartDay(day)).status).toBe(200);
      B = new TestClient(app);
      await B.post('/api/v1/auth/signup', {
        email: 'bea@startday.test',
        password: 'start day test Password1!',
        displayName: 'Bea',
      });
      const invite = await A.post(url('/invites'), { email: 'bea@startday.test' });
      const accepted = await B.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
      const r = await A.post(url('/budgets'), {
        scope: 'household',
        amounts: [{ categoryId: cat.Restaurants, amountMinor: 20000 }],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ours = r.body.data.id;
      // The household's budget began three months ago, before Bea joined today.
      const db = new pg.Client({ connectionString: tdb.maintenanceUrl });
      await db.connect();
      try {
        const first = `${cal(-3)}-01`;
        await db.query('UPDATE budgets SET starts_month = $2 WHERE id = $1', [ours, first]);
        await db.query('UPDATE budget_amounts SET month = $2 WHERE budget_id = $1', [ours, first]);
        await db.query('UPDATE budget_strategies SET from_month = $2 WHERE budget_id = $1', [
          ours,
          first,
        ]);
      } finally {
        await db.end();
      }
    }, 60_000);

    afterAll(async () => {
      await setStartDay(1);
    });

    it('averages the three budget months before this one', async () => {
      // On this budget month's first day: it's this month's, so the average leaves it out.
      await spend(budgetMonthStart(current(), day), -5000);
      const dates = [`${cal(-2)}-10`, `${cal(-1)}-05`, `${cal(-1)}-20`];
      const expected = [-3, -2, -1]
        .map((n) => addMonths(current(), n))
        .filter((m) => dates.some((d) => budgetMonthOf(d, day) === m));
      const p = await A.get(
        url(`/budgets/${budgetId}/months/${current()}/fill-preview?source=average`),
      );
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect(p.body.data.months).toEqual(expected);
      expect(p.body.data.months).not.toContain(current());
    });

    it('starts the household budget for a newer member in the budget month they joined in', async () => {
      const list = (await B.get(url('/budgets'))).body.data as {
        id: string;
        startsMonth: string;
      }[];
      expect(list.find((b) => b.id === ours)?.startsMonth).toBe(current());
      expect((await B.get(url(`/budgets/${ours}/months/${current()}`))).status).toBe(200);
      expect((await B.get(url(`/budgets/${ours}/months/${addMonths(current(), -1)}`))).status).toBe(
        404,
      );
      // Ada, the first member, sees all of it.
      const hers = (await A.get(url('/budgets'))).body.data as typeof list;
      expect(hers.find((b) => b.id === ours)?.startsMonth).toBe(cal(-3));
    });

    it('sets an allowance from the budget month today is in, not the calendar month', async () => {
      const bea = (await B.get(url())).body.data.you.memberId as string;
      const r = await A.request('PUT', url(`/allowances/${bea}`), {
        categoryId: cat.Restaurants,
        amountMinor: 15000,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data).toMatchObject([{ memberId: bea, fromMonth: current() }]);
      // This budget month is still open to change, even when it began last calendar month.
      const again = await A.request('PUT', url(`/allowances/${bea}`), {
        categoryId: cat.Restaurants,
        amountMinor: 10000,
        fromMonth: current(),
      });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      const before = await A.request('PUT', url(`/allowances/${bea}`), {
        categoryId: cat.Restaurants,
        amountMinor: 10000,
        fromMonth: addMonths(current(), -1),
      });
      expect([before.status, before.body.code]).toEqual([422, 'month_started']);
      expect((await A.get(url('/allowances'))).body.data).toMatchObject([
        { memberId: bea, amountMinor: 10000, fromMonth: current() },
      ]);
    });
  });

  it('counts each date in the same month in the database as budgetMonthOf() does', async () => {
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      const dialect = new PgDialect();
      for (const day of [1, 14, 15, 28, 29, 30, 31]) {
        const q = dialect.sqlToQuery(
          sql`SELECT d::date::text AS date, ${budgetMonthSql(sql`d::date`, day)} AS month
              FROM generate_series('2027-12-01'::date, '2029-03-31'::date, interval '1 day') d`,
        );
        const { rows } = await db.query<{ date: string; month: string }>(q.sql, q.params);
        expect(rows.length).toBeGreaterThan(400);
        const wrong = rows.filter((x) => x.month !== budgetMonthOf(x.date, day));
        expect(wrong, `start day ${day}`).toEqual([]);
      }
    } finally {
      await db.end();
    }
  });
});
