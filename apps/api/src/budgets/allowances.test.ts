// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Allowances, or fun money (#114; budgeting walkthrough D15; ADR 0006 §7.4, F5): a line in the
 * shared budget funds a member's own. Everyone sees the amount; nobody else sees how it was spent,
 * beyond what the accounts it was spent from already show them.
 */
describe('allowances', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient; // Ada, the owner
  let B: TestClient; // Bea, whose allowance it is
  let hh = '';
  let shared = '';
  let beas = '';
  let adas = '';
  let fun = '';
  let groceries = '';
  const member = { A: '', B: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  const nextMonth = () => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
  };
  const today = () => new Date().toISOString().slice(0, 10);
  type Row = { categoryId: string; budgetedMinor: number; spentMinor: number; leftMinor: number };
  const month = async (c: TestClient, id: string) => {
    const r = await c.get(url(`/budgets/${id}/months/${thisMonth()}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const row = (v: { view: { rows: Row[] } }, categoryId: string) =>
    v.view.rows.find((r) => r.categoryId === categoryId);
  const setAllowance = (c: TestClient, memberId: string, body: Record<string, unknown>) =>
    c.request('PUT', url(`/allowances/${memberId}`), body);
  const txn = async (
    c: TestClient,
    accountId: string,
    amountMinor: number,
    displayName: string,
    categoryId = fun,
  ) => {
    const r = await c.post(url('/transactions'), {
      accountId,
      date: today(),
      amountMinor,
      displayName,
      categoryId,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const names = async (c: TestClient) =>
    ((await c.get(url('/transactions'))).body.data as { displayName: string }[]).map(
      (t) => t.displayName,
    );

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@allowances.test`,
        password: 'allowances test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('Ada');
    B = await signup('Bea');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'hybrid',
      })
    ).body.data.id;
    const groups = (await A.get(url('/categories'))).body.data as {
      id: string;
      name: string;
      categories: { id: string; name: string }[];
    }[];
    groceries = groups.flatMap((g) => g.categories).find((c) => c.name === 'Groceries')!.id;
    fun = (
      await A.post(url('/categories'), {
        name: 'Fun money',
        groupId: groups.find((g) => g.name === 'Fun')!.id,
      })
    ).body.data.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('needs two of you, and the shared budget', async () => {
    const me = (await A.get(url('/members'))).body.data[0].id as string;
    const alone = await setAllowance(A, me, { categoryId: fun, amountMinor: 15000 });
    expect([alone.status, alone.body.code]).toEqual([409, 'one_person']);

    const invite = await A.post(url('/invites'), { email: 'bea@allowances.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    for (const m of (await A.get(url('/members'))).body.data as {
      id: string;
      isYou: boolean;
    }[]) {
      member[m.isYou ? 'A' : 'B'] = m.id;
    }
    const noBudget = await setAllowance(A, member.B, { categoryId: fun, amountMinor: 15000 });
    expect([noBudget.status, noBudget.body.code]).toEqual([409, 'no_shared_budget']);

    shared = (
      await A.post(url('/budgets'), {
        scope: 'household',
        amounts: [{ categoryId: groceries, amountMinor: 60000 }],
      })
    ).body.data.id;
    beas = (await B.post(url('/budgets'), { scope: 'mine', amounts: [] })).body.data.id;
    adas = (await A.post(url('/budgets'), { scope: 'mine', amounts: [] })).body.data.id;
  });

  it('refuses income, transfers, earlier months, and members it doesn’t know', async () => {
    const groups = (await A.get(url('/categories'))).body.data as {
      name: string;
      categories: { id: string }[];
    }[];
    const paychecks = groups.find((g) => g.name === 'Income')!.categories[0]!.id;
    expect(
      (await setAllowance(A, member.B, { categoryId: paychecks, amountMinor: 15000 })).status,
    ).toBe(404);
    expect(
      (await setAllowance(A, crypto.randomUUID(), { categoryId: fun, amountMinor: 15000 })).status,
    ).toBe(404);
    const past = await setAllowance(A, member.B, {
      categoryId: fun,
      amountMinor: 15000,
      fromMonth: '2020-01',
    });
    expect([past.status, past.body.code]).toEqual([422, 'month_started']);
  });

  it('sets one, and everyone sees its amount, and only that', async () => {
    const r = await setAllowance(A, member.B, { categoryId: fun, amountMinor: 15000 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const expected = [
      {
        memberId: member.B,
        categoryId: fun,
        amountMinor: 15000,
        fromMonth: thisMonth(),
        next: null,
      },
    ];
    expect(r.body.data).toEqual(expected);
    expect((await A.get(url('/allowances'))).body.data).toEqual(expected);
    expect((await B.get(url('/allowances'))).body.data).toEqual(expected);
  });

  describe('what Bea spends of it doesn’t reach Ada (cross-member leakage)', () => {
    let beaPrivate = '';
    let beaBalanceOnly = '';
    let joint = '';
    const SECRET = 'Arcade on Bea’s own card';
    const QUIET = 'Records on Bea’s balance-only card';
    const OPEN = 'Concert from the joint account';

    beforeAll(async () => {
      beaPrivate = (
        await B.post(url('/accounts'), {
          name: 'Bea card',
          type: 'credit',
          visibility: 'private',
        })
      ).body.data.id;
      beaBalanceOnly = (
        await B.post(url('/accounts'), {
          name: 'Bea other card',
          type: 'credit',
          visibility: 'balance_only',
        })
      ).body.data.id;
      joint = (
        await A.post(url('/accounts'), {
          name: 'Joint checking',
          type: 'depository',
          visibility: 'full',
          owners: [{ memberId: member.A }, { memberId: member.B }],
        })
      ).body.data.id;
      await txn(B, beaPrivate, -4000, SECRET);
      await txn(B, beaBalanceOnly, -1700, QUIET);
      // From the joint account, but for Bea alone: her spending, though Ada can see it (F5).
      const concert = await txn(A, joint, -2500, OPEN);
      const attributed = await A.request('PUT', url(`/transactions/${concert}/attribution`), {
        attribution: [{ memberId: member.B }],
      });
      expect(attributed.status, JSON.stringify(attributed.body)).toBe(204);
      // And something shared, which the shared budget does count.
      await txn(A, joint, -9000, 'Market', groceries);
    });

    it('the shared budget shows the allowance as handed over, never how it was spent', async () => {
      for (const c of [A, B]) {
        const v = await month(c, shared);
        expect(row(v, fun)).toMatchObject({
          budgetedMinor: 15000,
          spentMinor: 15000,
          leftMinor: 0,
        });
        expect(row(v, groceries)?.spentMinor).toBe(9000);
        expect(v.view.notBudgeted).toEqual([]);
        expect(v.view.totals.spentMinor).toBe(15000 + 9000);
        expect(v.allowances).toEqual([{ memberId: member.B, categoryId: fun, amountMinor: 15000 }]);
      }
      // The same to both of them: nothing in it depends on what Bea spent.
      expect(await month(A, shared)).toEqual(await month(B, shared));
    });

    it('its history and year show the allowance, not Bea’s spending', async () => {
      const history = await A.get(
        url(`/budgets/${shared}/categories/${fun}/history?to=${thisMonth()}`),
      );
      expect(history.status, JSON.stringify(history.body)).toBe(200);
      expect(history.body.data.months.at(-1)).toEqual({
        month: thisMonth(),
        budgetedMinor: 15000,
        spentMinor: 15000,
      });
      const year = Number(thisMonth().slice(0, 4));
      const y = (await A.get(url(`/budgets/${shared}/years/${year}`))).body.data;
      const funRow = y.rows.find((r: { categoryId: string }) => r.categoryId === fun);
      expect(funRow.spentMinor).toBe(15000);
    });

    it('Bea’s own budget is hers alone: Ada can’t find it', async () => {
      const seen = (await A.get(url('/budgets'))).body.data as { id: string }[];
      expect(seen.map((b) => b.id)).not.toContain(beas);
      expect((await A.get(url(`/budgets/${beas}/months/${thisMonth()}`))).status).toBe(404);
      expect(
        (await A.get(url(`/budgets/${beas}/categories/${fun}/history?to=${thisMonth()}`))).status,
      ).toBe(404);
    });

    it('Ada’s own budget gets nothing of Bea’s allowance', async () => {
      const v = await month(A, adas);
      expect(v.allowances).toEqual([]);
      expect(v.view.incomeMinor).toBe(0);
      expect(row(v, fun)).toBeUndefined();
    });

    it('Ada sees only what the accounts already show her: the joint one (F5)', async () => {
      const seen = await names(A);
      expect(seen).not.toContain(SECRET);
      expect(seen).not.toContain(QUIET);
      expect(seen).toContain(OPEN);
    });

    it('in Bea’s own budget it arrives as money in, and her spending counts against it', async () => {
      const v = await month(B, beas);
      expect(v.allowances).toEqual([{ memberId: member.B, categoryId: fun, amountMinor: 15000 }]);
      expect(v.view.incomeMinor).toBe(15000);
      expect(row(v, fun)).toMatchObject({
        budgetedMinor: 15000,
        spentMinor: 4000 + 1700 + 2500,
        leftMinor: 15000 - 8200,
      });
    });

    it('rolls over when Bea turns it on, in her own budget', async () => {
      const r = await B.request('PUT', url(`/budgets/${beas}/categories/${fun}`), {
        rollover: true,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(204);
      expect(row(await month(B, beas), fun)).toMatchObject({ rollover: true });
    });
  });

  it('the amount isn’t typed into either budget: it’s the allowance’s', async () => {
    for (const [c, id] of [
      [A, shared],
      [B, beas],
    ] as const) {
      const r = await c.request('PUT', url(`/budgets/${id}/months/${thisMonth()}/amounts/${fun}`), {
        amountMinor: 1,
      });
      expect([r.status, r.body.code]).toEqual([409, 'allowance_category']);
    }
  });

  it('changes from a later month, keeping this one, and stops', async () => {
    const later = await setAllowance(B, member.B, {
      categoryId: fun,
      amountMinor: 20000,
      fromMonth: nextMonth(),
    });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect(later.body.data).toEqual([
      {
        memberId: member.B,
        categoryId: fun,
        amountMinor: 15000,
        fromMonth: thisMonth(),
        next: { month: nextMonth(), amountMinor: 20000 },
      },
    ]);
    expect(row(await month(A, shared), fun)?.budgetedMinor).toBe(15000);

    // Stopping from this month takes the later change with it.
    const stopped = await setAllowance(A, member.B, { categoryId: fun, amountMinor: 0 });
    expect(stopped.body.data).toEqual([]);
    const v = await month(A, shared);
    expect(row(v, fun)).toBeUndefined();
    expect(v.allowances).toEqual([]);
    expect((await month(B, beas)).view.incomeMinor).toBe(0);
  });

  it('follows its category when that’s merged into another', async () => {
    await setAllowance(A, member.B, { categoryId: fun, amountMinor: 12000 });
    const groups = (await A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[];
    const hobbies = groups.flatMap((g) => g.categories).find((c) => c.name === 'Hobbies')!.id;
    const r = await A.request('DELETE', url(`/categories/${fun}?replaceWith=${hobbies}`));
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect((await A.get(url('/allowances'))).body.data).toEqual([
      expect.objectContaining({ memberId: member.B, categoryId: hobbies, amountMinor: 12000 }),
    ]);
    expect(row(await month(A, shared), hobbies)).toMatchObject({ budgetedMinor: 12000 });
  });

  it('goes into the household’s activity', async () => {
    const r = await A.get(url('/activity'));
    const actions = (r.body.data as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['allowance.set', 'allowance.stopped']));
  });

  it('starts at the history window of a member who joined later (#256)', async () => {
    // As if Bea had joined next month: the household's budget starts there for her.
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      await db.query(`SET session_replication_role = replica`);
      await db.query(`UPDATE household_members SET history_from = $1::date WHERE id = $2`, [
        `${nextMonth()}-01`,
        member.B,
      ]);
    } finally {
      await db.end();
    }
    const groups = (await A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[];
    const hobbies = groups.flatMap((g) => g.categories).find((c) => c.name === 'Hobbies')!.id;
    const history = async (c: TestClient) => {
      const r = await c.get(
        url(`/budgets/${shared}/categories/${hobbies}/history?to=${nextMonth()}`),
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.data.months.slice(-2);
    };
    // Ada sees this month's allowance handed over; Bea's budget hasn't started then, so nothing
    // of it is there for her. Next month it runs on for both of them.
    expect(await history(A)).toEqual([
      { month: thisMonth(), budgetedMinor: 12000, spentMinor: 12000 },
      { month: nextMonth(), budgetedMinor: 12000, spentMinor: 12000 },
    ]);
    expect(await history(B)).toEqual([
      { month: thisMonth(), budgetedMinor: null, spentMinor: 0 },
      { month: nextMonth(), budgetedMinor: 12000, spentMinor: 12000 },
    ]);
    const year = Number(thisMonth().slice(0, 4));
    const yearRow = async (c: TestClient) =>
      (
        (await c.get(url(`/budgets/${shared}/years/${year}`))).body.data.rows as {
          categoryId: string;
          spentMinor: number;
        }[]
      ).find((r) => r.categoryId === hobbies);
    expect((await yearRow(A))?.spentMinor).toBe(12000);
    expect((await yearRow(B))?.spentMinor ?? 0).toBe(0);
    // The allowance itself, and Bea's own budget, are as they were.
    expect((await B.get(url('/allowances'))).body.data).toEqual(
      (await A.get(url('/allowances'))).body.data,
    );
    expect((await month(B, beas)).view.incomeMinor).toBe(12000);
  });
});
