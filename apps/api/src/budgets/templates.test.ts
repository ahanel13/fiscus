// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Filling a month (#105): copy last month, the 3-month average, and templates. A preview first;
 * the source's amounts replace the month's, and categories it doesn't mention keep theirs. In
 * every strategy, both scopes, and only from what the reader can see.
 */
describe('budgets: templates, copy last month, 3-month average', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let C: TestClient;
  let hh = '';
  let checking = '';
  let mine = '';
  const member: Record<string, string> = {};
  const cat: Record<string, string> = {};
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  /** `YYYY-MM` `n` months from this one (UTC, the household's time zone). */
  const month = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
  };
  const spend = async (
    c: TestClient,
    accountId: string,
    m: string,
    day: string,
    amountMinor: number,
    category: string,
  ) => {
    const r = await c.post(url('/transactions'), {
      accountId,
      date: `${m}-${day}`,
      amountMinor,
      displayName: category,
      categoryId: cat[category],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const view = async (c: TestClient, id: string, m: string) => {
    const r = await c.get(url(`/budgets/${id}/months/${m}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const budgeted = (v: { view: { rows: { categoryId: string; budgetedMinor: number }[] } }) =>
    Object.fromEntries(
      Object.entries(cat)
        .map(([name, id]) => [name, v.view.rows.find((r) => r.categoryId === id)?.budgetedMinor])
        .filter(([, b]) => b !== undefined && b !== 0),
    );
  const preview = (c: TestClient, id: string, m: string, q: string) =>
    c.get(url(`/budgets/${id}/months/${m}/fill-preview?${q}`));
  const fill = (c: TestClient, id: string, m: string, body: object) =>
    c.post(url(`/budgets/${id}/months/${m}/fill`), body);
  const changes = (body: { data: { changes: { categoryId: string }[] } }) =>
    Object.fromEntries(
      body.data.changes.map((c) => [
        Object.entries(cat).find(([, id]) => id === c.categoryId)![0],
        c,
      ]),
    );
  const setAmount = async (m: string, category: string, amountMinor: number) => {
    const r = await A.request('PUT', url(`/budgets/${mine}/months/${m}/amounts/${cat[category]}`), {
      amountMinor,
      applyTo: 'month',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name.toLowerCase()}@templates.test`,
        password: 'templates test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('Ada');
    B = await signup('Bea');
    C = await signup('Cy');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'hybrid',
      })
    ).body.data.id;
    for (const c of [B, C]) {
      const name = c === B ? 'bea' : 'cy';
      const invite = await A.post(url('/invites'), { email: `${name}@templates.test` });
      await c.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    for (const m of (await A.get(url('/members'))).body.data as {
      id: string;
      displayName: string;
    }[]) {
      member[m.displayName] = m.id;
    }
    for (const g of (await A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[]) {
      for (const c of g.categories) cat[c.name] = c.id;
    }
    checking = (
      await A.post(url('/accounts'), {
        name: 'Ada checking',
        type: 'depository',
        visibility: 'private',
      })
    ).body.data.id;
    // Ada's own history: groceries every month, restaurants twice, a paycheck each month.
    await spend(A, checking, month(-3), '05', -60000, 'Groceries');
    await spend(A, checking, month(-2), '05', -70000, 'Groceries');
    await spend(A, checking, month(-2), '12', -20000, 'Restaurants');
    await spend(A, checking, month(-1), '05', -65000, 'Groceries');
    await spend(A, checking, month(-1), '12', -30000, 'Restaurants');
    await spend(A, checking, month(-1), '20', 5000, 'Restaurants'); // a refund
    for (const n of [-3, -2, -1, 0]) await spend(A, checking, month(n), '01', 400000, 'Paychecks');
    const r = await A.post(url('/budgets'), {
      scope: 'mine',
      amounts: [
        { categoryId: cat.Groceries, amountMinor: 50000 },
        { categoryId: cat.Utilities, amountMinor: 12000 },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    mine = r.body.data.id;
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('previews the 3-month average, then fills it, keeping what it doesn’t mention', async () => {
    const p = await preview(A, mine, month(0), 'source=average');
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.months).toEqual([month(-3), month(-2), month(-1)]);
    // Groceries (600 + 700 + 650) / 3; restaurants (0 + 200 + 250) / 3; income is expected too.
    expect(changes(p.body)).toEqual({
      Groceries: { categoryId: cat.Groceries, beforeMinor: 50000, afterMinor: 65000 },
      Restaurants: { categoryId: cat.Restaurants, beforeMinor: 0, afterMinor: 15000 },
      Paychecks: { categoryId: cat.Paychecks, beforeMinor: 0, afterMinor: 400000 },
    });
    expect(p.body.data.flexible).toBeNull();
    // Nothing changes on a preview.
    expect(budgeted(await view(A, mine, month(0)))).toEqual({ Groceries: 50000, Utilities: 12000 });

    const r = await fill(A, mine, month(0), { source: 'average' });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const v = await view(A, mine, month(0));
    expect(budgeted(v)).toEqual({ Groceries: 65000, Restaurants: 15000, Utilities: 12000 });
    expect(
      v.view.income.find((i: { categoryId: string }) => i.categoryId === cat.Paychecks)
        .budgetedMinor,
    ).toBe(400000);
    // The month after repeats it, as it does any change.
    expect(budgeted(await view(A, mine, month(1)))).toEqual(budgeted(v));

    const again = await fill(A, mine, month(0), { source: 'average' });
    expect([again.status, again.body.code]).toEqual([409, 'nothing_to_fill']);
    // A month still to come averages the last three full months, too.
    expect((await preview(A, mine, month(2), 'source=average')).body.data.months).toEqual([
      month(-3),
      month(-2),
      month(-1),
    ]);
  });

  it('copies last month into a month, and not before the budget starts', async () => {
    const first = await preview(A, mine, month(0), 'source=last_month');
    expect([first.status, first.body.code]).toEqual([409, 'nothing_to_copy']);
    // The month after repeats this one, so there's nothing to copy until it differs.
    expect((await preview(A, mine, month(1), 'source=last_month')).body.data.changes).toEqual([]);
    await setAmount(month(1), 'Groceries', 40000);
    const p = await preview(A, mine, month(1), 'source=last_month');
    expect(p.body.data.months).toEqual([month(0)]);
    expect(changes(p.body)).toEqual({
      Groceries: { categoryId: cat.Groceries, beforeMinor: 40000, afterMinor: 65000 },
    });
    expect((await fill(A, mine, month(1), { source: 'last_month' })).status).toBe(204);
    expect(budgeted(await view(A, mine, month(1))).Groceries).toBe(65000);
  });

  it('saves a month as a template, fills from it, and deletes it', async () => {
    const saved = await A.post(url(`/budgets/${mine}/templates`), {
      name: 'Usual',
      month: month(0),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const t = saved.body.data;
    expect(
      Object.fromEntries(t.amounts.map((a: never) => [a['categoryId'], a['amountMinor']])),
    ).toEqual({
      [cat.Groceries!]: 65000,
      [cat.Restaurants!]: 15000,
      [cat.Utilities!]: 12000,
      [cat.Paychecks!]: 400000,
    });
    expect(t.flexibleMinor).toBeNull();
    const dupe = await A.post(url(`/budgets/${mine}/templates`), {
      name: 'usual',
      month: month(1),
    });
    expect([dupe.status, dupe.body.code]).toEqual([409, 'duplicate_name']);
    expect((await A.get(url(`/budgets/${mine}/templates`))).body.data).toHaveLength(1);

    await setAmount(month(2), 'Utilities', 20000);
    const p = await preview(A, mine, month(2), `source=template&templateId=${t.id}`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(changes(p.body)).toEqual({
      Utilities: { categoryId: cat.Utilities, beforeMinor: 20000, afterMinor: 12000 },
    });
    expect((await fill(A, mine, month(2), { source: 'template', templateId: t.id })).status).toBe(
      204,
    );
    expect(budgeted(await view(A, mine, month(2))).Utilities).toBe(12000);

    // A template needs naming, and only for a template.
    expect((await fill(A, mine, month(2), { source: 'template' })).status).toBe(422);
    expect((await fill(A, mine, month(2), { source: 'average', templateId: t.id })).status).toBe(
      422,
    );

    // Your own budget's templates are yours alone (D3): to anyone else, they don't exist.
    expect((await B.get(url(`/budgets/${mine}/templates`))).status).toBe(404);
    expect((await preview(B, mine, month(2), `source=template&templateId=${t.id}`)).status).toBe(
      404,
    );
    expect((await B.request('DELETE', url(`/budgets/${mine}/templates/${t.id}`))).status).toBe(404);

    expect((await A.request('DELETE', url(`/budgets/${mine}/templates/${t.id}`))).status).toBe(204);
    expect((await preview(A, mine, month(2), `source=template&templateId=${t.id}`)).status).toBe(
      404,
    );
  });

  it('fills a zero-based month with what was assigned, and no income', async () => {
    const s = await A.request('PUT', url(`/budgets/${mine}/strategy`), {
      strategy: 'zero_based',
      fromMonth: month(3),
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    // Month 4 assigns afresh: nothing yet.
    expect(budgeted(await view(A, mine, month(4)))).toEqual({});
    const p = await preview(A, mine, month(4), 'source=last_month');
    expect(Object.keys(changes(p.body)).sort()).toEqual(['Groceries', 'Restaurants', 'Utilities']);
    expect((await fill(A, mine, month(4), { source: 'last_month' })).status).toBe(204);
    const v = await view(A, mine, month(4));
    expect(v.view.assigned).toBe(true);
    expect(budgeted(v)).toEqual({ Groceries: 65000, Restaurants: 15000, Utilities: 12000 });
  });

  it('fills flex’s flexible number with the rest', async () => {
    const s = await A.request('PUT', url(`/budgets/${mine}/strategy`), {
      strategy: 'flex',
      fromMonth: month(5),
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(
      (
        await A.request('PUT', url(`/budgets/${mine}/months/${month(5)}/flexible`), {
          amountMinor: 50000,
        })
      ).status,
    ).toBe(204);
    // Groceries and restaurants are flexible: their averages add up to the flexible number.
    const p = await preview(A, mine, month(5), 'source=average');
    expect(p.body.data.flexible).toEqual({ beforeMinor: 50000, afterMinor: 80000 });
    expect((await fill(A, mine, month(5), { source: 'average' })).status).toBe(204);
    expect((await view(A, mine, month(5))).view.flexible.budgetedMinor).toBe(80000);
    const t = await A.post(url(`/budgets/${mine}/templates`), {
      name: 'Flex month',
      month: month(5),
    });
    expect(t.body.data.flexibleMinor).toBe(80000);
  });

  it('keeps the amounts in 50/30/20, for switching back', async () => {
    const s = await A.request('PUT', url(`/budgets/${mine}/strategy`), {
      strategy: 'percentage',
      fromMonth: month(6),
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    await setAmount(month(6), 'Groceries', 10000);
    const p = await preview(A, mine, month(6), 'source=last_month');
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(changes(p.body).Groceries).toMatchObject({ beforeMinor: 10000, afterMinor: 65000 });
    expect((await fill(A, mine, month(6), { source: 'last_month' })).status).toBe(204);
  });

  it('averages only the spending you can see, in the shared budget', async () => {
    const ours = await A.post(url('/budgets'), { scope: 'household', amounts: [] });
    expect(ours.status, JSON.stringify(ours.body)).toBe(201);
    const id = ours.body.data.id as string;
    // Bea's own card, for something she and Cy share: theirs to see, not Ada's (F1).
    const card = (
      await B.post(url('/accounts'), { name: 'Bea card', type: 'credit', visibility: 'private' })
    ).body.data.id;
    const t = await spend(B, card, month(-1), '10', -30000, 'Groceries');
    const a = await B.request('PUT', url(`/transactions/${t}/attribution`), {
      attribution: [{ memberId: member.Bea }, { memberId: member.Cy }],
    });
    expect(a.status, JSON.stringify(a.body)).toBe(204);

    const bea = await preview(B, id, month(0), 'source=average');
    expect(changes(bea.body)).toEqual({
      Groceries: { categoryId: cat.Groceries, beforeMinor: 0, afterMinor: 30000 },
    });
    expect((await preview(C, id, month(0), 'source=average')).body.data.months).toEqual([
      month(-1),
    ]);
    const ada = await preview(A, id, month(0), 'source=average');
    expect([ada.status, ada.body.code]).toEqual([409, 'no_history']);
  });
});
