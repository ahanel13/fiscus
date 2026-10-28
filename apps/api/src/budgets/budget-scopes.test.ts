// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Budgets that follow the household (#107, budgeting walkthrough §7, §7a): a budget changes scope
 * keeping its history (D25), and contributions connect the shared budget with each person's (D2).
 */
describe('budgets: scopes and contributions', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  let checking = '';
  let budgetId = '';
  const cat: Record<string, string> = {};
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  const today = () => new Date().toISOString().slice(0, 10);
  const view = async (c: TestClient, id: string) => {
    const r = await c.get(url(`/budgets/${id}/months/${thisMonth()}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const scope = (c: TestClient, id: string, s: string) =>
    c.request('PUT', url(`/budgets/${id}/scope`), { scope: s });
  const spentOn = (v: { view: { rows: { categoryId: string; spentMinor: number }[] } }) =>
    v.view.rows.find((r) => r.categoryId === cat.Groceries)?.spentMinor;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@scopes.test`,
        password: 'scopes test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'hybrid',
      })
    ).body.data.id;
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
    await A.post(url('/transactions'), {
      accountId: checking,
      date: today(),
      amountMinor: -8000,
      displayName: 'Market',
      categoryId: cat.Groceries,
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('makes a shared budget yours once you’re the only one, keeping its amounts (D25)', async () => {
    // Bea's own household of two doesn't make Ada any less alone in hers.
    const other = (
      await B.post('/api/v1/households', {
        name: 'Elsewhere',
        baseCurrency: 'USD',
        timezone: 'UTC',
      })
    ).body.data.id;
    const invite = await B.post(`/api/v1/households/${other}/invites`, {
      email: 'ada@scopes.test',
    });
    await A.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });

    const created = await A.post(url('/budgets'), {
      scope: 'household',
      amounts: [{ categoryId: cat.Groceries, amountMinor: 50000 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    budgetId = created.body.data.id;
    // Shared, it counts nothing in a household of one: the market is Ada's alone.
    expect(spentOn(await view(A, budgetId))).toBe(0);

    const preview = await A.get(url(`/budgets/${budgetId}/scope-preview?scope=mine`));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.month).toBe(thisMonth());
    expect(
      preview.body.data.after.rows.find(
        (r: { categoryId: string }) => r.categoryId === cat.Groceries,
      ),
    ).toMatchObject({ budgetedMinor: 50000, spentMinor: 8000 });

    const r = await scope(A, budgetId, 'mine');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ id: budgetId, scope: 'mine' });
    const v = await view(A, budgetId);
    expect(
      v.view.rows.find((x: { categoryId: string }) => x.categoryId === cat.Groceries),
    ).toMatchObject({ budgetedMinor: 50000, spentMinor: 8000 });
    expect([(await scope(A, budgetId, 'mine')).body.code]).toEqual(['same_scope']);
    // Sharing needs someone to share with.
    const alone = await scope(A, budgetId, 'household');
    expect([alone.status, alone.body.code]).toEqual([409, 'one_person']);
  });

  it('shares your budget once someone joins, and only yours (D25)', async () => {
    const invite = await A.post(url('/invites'), { email: 'bea@scopes.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    // Bea can't see Ada's budget, so can't share it.
    expect((await scope(B, budgetId, 'household')).status).toBe(404);
    const r = await scope(A, budgetId, 'household');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const seen = (await B.get(url('/budgets'))).body.data as { id: string; scope: string }[];
    expect(seen).toEqual([expect.objectContaining({ id: budgetId, scope: 'household' })]);
    // With two of them, it stays the household's.
    const back = await scope(A, budgetId, 'mine');
    expect([back.status, back.body.code]).toEqual([409, 'not_alone']);
  });

  it('counts money moved into a joint account as the shared budget’s, and leaving yours (D2)', async () => {
    const members = (await A.get(url('/members'))).body.data as { id: string; isYou: boolean }[];
    const joint = (
      await A.post(url('/accounts'), {
        name: 'Joint checking',
        type: 'depository',
        visibility: 'full',
        owners: members.map((m) => ({ memberId: m.id })),
      })
    ).body.data.id;
    const out = await A.post(url('/transactions'), {
      accountId: checking,
      date: today(),
      amountMinor: -260000,
      displayName: 'To joint',
    });
    const into = await A.post(url('/transactions'), {
      accountId: joint,
      date: today(),
      amountMinor: 260000,
      displayName: 'From Ada',
    });
    const link = await A.post(url(`/transactions/${out.body.data.id}/transfer`), {
      transactionId: into.body.data.id,
    });
    expect([200, 409], JSON.stringify(link.body)).toContain(link.status);
    expect(
      (await A.get(url(`/transactions/${into.body.data.id}`))).body.data.transfer,
    ).not.toBeNull();

    const mine = await A.post(url('/budgets'), { scope: 'mine', amounts: [] });
    const beas = await B.post(url('/budgets'), { scope: 'mine', amounts: [] });
    expect([mine.status, beas.status]).toEqual([201, 201]);

    // Bea can't see Ada's checking, yet the money that arrived is still a contribution.
    expect((await view(B, budgetId)).view.contributionsMinor).toBe(260000);
    expect((await view(A, budgetId)).view.contributionsMinor).toBe(260000);
    // It left Ada's own budget for Ours; Bea moved nothing.
    expect((await view(A, mine.body.data.id)).view.contributionsMinor).toBe(260000);
    expect((await view(B, beas.body.data.id)).view.contributionsMinor).toBe(0);
    // It's neither income nor spending.
    expect((await view(A, budgetId)).view.incomeMinor).toBe(0);
  });
});
