// SPDX-License-Identifier: AGPL-3.0-or-later
import { createDb, systemContext, withContext } from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { cardStatementsDue } from '@fiscus/ledger';
import {
  addDays,
  type Goal,
  previousDueDate,
  type RecurringMonth,
  type RecurringOccurrence,
} from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * A debt's minimum as a bill (#134; goals and budgets G9, goals walkthrough G23): with no due date
 * from the bank, a pay-down goal says which day its minimum is due, and it shows in Bills with
 * the statements, paid by payments into the debt since the due date before.
 */
describe('a debt’s minimum as a bill', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  let ada = '';
  let bea = '';
  const debt = { loan: '', joint: '', bank: '' };
  const goal: Record<string, Goal> = {};
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDays(today, -1);
  const due = addDays(today, 5);
  const dueDay = Number(due.slice(8));

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@debt-bills.test`,
        password: 'debt bills test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    V = await signup('vic');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'hybrid',
      })
    ).body.data.id;
    for (const [c, email, role] of [
      [B, 'bea@debt-bills.test', 'member'],
      [V, 'vic@debt-bills.test', 'viewer'],
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
    ada = members.find((m) => m.displayName === 'ada')!.id;
    bea = members.find((m) => m.displayName === 'bea')!.id;
    // A manual loan and card (no bank to say when they're due), and a card whose bank does.
    for (const [key, name, type, owed, owners] of [
      ['loan', 'Car loan', 'loan', 1_200_000, [ada]],
      ['joint', 'Store card', 'credit', 50_000, [ada, bea]],
      ['bank', 'Harbor Visa', 'credit', 300_000, [ada]],
    ] as const) {
      const r = await A.post(url('/accounts'), {
        name,
        type,
        visibility: 'full',
        owners: owners.map((memberId) => ({ memberId })),
        openingBalance: { amountMinor: -owed, asOf: yesterday },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      debt[key] = r.body.data.id;
    }
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      await db.query(
        `INSERT INTO account_liabilities (account_id, household_id, minimum_payment_minor,
           next_due_date, last_statement_balance_minor, last_statement_date)
         VALUES ($1, $2, 10000, $3, -300000, $4)`,
        [debt.bank, hh, due, addDays(today, -15)],
      );
    } finally {
      await db.end();
    }
    const make = async (key: string, body: object) => {
      const r = await A.post(url('/goals/pay-down'), body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      goal[key] = r.body.data as Goal;
    };
    await make('loan', {
      accountId: debt.loan,
      scope: 'household',
      minimumMinor: 25_000,
      dueDay,
    });
    // Ada's own goal on a card Bea owns with her: Bea doesn't know it's there (G15).
    await make('joint', { accountId: debt.joint, scope: 'mine' });
    await make('bank', { accountId: debt.bank, scope: 'household', dueDay });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  const month = async (c: TestClient) =>
    (await c.get(url(`/recurring/month?month=${due.slice(0, 7)}`))).body.data as RecurringMonth;
  const statements = async (c: TestClient) =>
    (await month(c)).occurrences.filter((o) => o.kind === 'statement');
  const billOf = async (c: TestClient, accountId: string) =>
    (await statements(c)).filter((o) => o.accountId === accountId) as RecurringOccurrence[];
  const patch = async (c: TestClient, key: string, body: object) => {
    const r = await c.request('PATCH', url(`/goals/${goal[key]!.id}`), body, {
      headers: { 'if-match': `"v${goal[key]!.version}"` },
    });
    if (r.status === 200) goal[key] = r.body.data as Goal;
    return r;
  };

  it('is the minimum, due on the goal’s day, from the goal [GOAL-08/OWN]', async () => {
    expect(goal.loan!.debt).toMatchObject({
      entered: { minimumMinor: 25_000, dueDay },
      bank: null,
    });
    const [bill, ...more] = await billOf(A, debt.loan);
    expect(more).toEqual([]);
    expect(bill).toMatchObject({
      seriesId: null,
      name: 'Car loan payment',
      source: 'goal',
      due,
      status: 'due',
      expectedMinor: -25_000,
      minimumMinor: 25_000,
      paidSoFarMinor: 0,
      statementPaid: null,
      memberIds: [ada],
    });
    // Whoever sees the loan's details and the goal sees it: Bea, and Vic as a viewer.
    expect(await billOf(B, debt.loan)).toHaveLength(1);
    expect(await billOf(V, debt.loan)).toHaveLength(1);
    // It's counted with the statements, never as a bill (D9).
    expect((await month(A)).totals.billsMinor).toBe(0);
  });

  it('is paid by payments since the due date before', async () => {
    const pay = (date: string, amountMinor: number) =>
      A.post(url('/transactions'), {
        accountId: debt.loan,
        date,
        amountMinor,
        displayName: 'Loan payment',
      });
    // On the due date before: that paid the one before.
    expect((await pay(previousDueDate(dueDay, due), 25_000)).status).toBe(201);
    expect((await billOf(A, debt.loan))[0]).toMatchObject({ paidSoFarMinor: 0, status: 'due' });
    await pay(today, 10_000);
    expect((await billOf(A, debt.loan))[0]).toMatchObject({
      status: 'due',
      statementPaid: 'part',
      paidSoFarMinor: 10_000,
    });
    await pay(today, 15_000);
    expect((await billOf(A, debt.loan))[0]).toMatchObject({
      status: 'paid',
      statementPaid: 'paid',
      paidSoFarMinor: 25_000,
    });
  });

  it('assumes the estimate without a minimum, and keeps a Mine goal’s to you (G15)', async () => {
    expect((await patch(A, 'joint', { dueDay })).status).toBe(200);
    // 2% of $500 is under $25, so $25.
    expect((await billOf(A, debt.joint))[0]).toMatchObject({
      name: 'Store card payment',
      expectedMinor: -2_500,
      source: 'goal',
    });
    expect(await billOf(B, debt.joint)).toEqual([]);
  });

  it('gives way to the bank’s due dates (D9)', async () => {
    const bills = await billOf(A, debt.bank);
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ source: 'bank', name: 'Harbor Visa statement' });
  });

  it('goes with the due day, or the goal put away', async () => {
    expect((await patch(A, 'joint', { dueDay: null })).status).toBe(200);
    expect(await billOf(A, debt.joint)).toEqual([]);
    const put = await A.request('PUT', url(`/goals/${goal.loan!.id}/archived`), {
      archived: true,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await billOf(A, debt.loan)).toEqual([]);
    const back = await A.request('PUT', url(`/goals/${goal.loan!.id}/archived`), {
      archived: false,
    });
    expect(back.status).toBe(200);
    goal.loan = back.body.data as Goal;
  });

  it('is a debt’s alone, a day of the month, set by those who change the goal [GOAL-08/VIEW]', async () => {
    const save = await A.post(url('/goals'), { name: 'Trip', targetMinor: 100_000 });
    expect(save.status, JSON.stringify(save.body)).toBe(201);
    goal.save = save.body.data as Goal;
    expect((await patch(A, 'save', { dueDay: 5 })).body.code).toBe('not_a_debt');
    expect((await patch(A, 'loan', { dueDay: 32 })).status).toBe(422);
    expect((await patch(A, 'loan', { dueDay: 0 })).status).toBe(422);
    expect((await patch(V, 'loan', { dueDay: 3 })).status).toBe(403);
    // A day a month doesn't have is its last day.
    expect((await patch(B, 'loan', { dueDay: 31 })).status).toBe(200);
    const [bill] = await billOf(A, debt.loan);
    const end = new Date(Date.UTC(Number(due.slice(0, 4)), Number(due.slice(5, 7)), 0));
    expect(bill?.due).toBe(end.toISOString().slice(0, 10));
  });

  it('reminds the debt’s owners, and only you of your own goal’s', async () => {
    expect((await patch(A, 'joint', { dueDay })).status).toBe(200);
    const { db, close } = createDb(tdb.workerUrl, { max: 1 });
    try {
      await withContext(db, systemContext(hh), async (tx) => {
        const adas = await cardStatementsDue(tx, { memberId: ada, today, withinDays: 7 });
        expect(adas.filter((s) => s.source === 'goal').map((s) => s.accountId)).toEqual([
          debt.joint,
        ]);
        expect(adas.find((s) => s.accountId === debt.joint)).toMatchObject({
          goalId: goal.joint!.id,
          owedMinor: 2_500,
          due,
        });
        // Bea owns the card with Ada, but the goal is Ada's own.
        const beas = await cardStatementsDue(tx, { memberId: bea, today, withinDays: 7 });
        expect(beas.map((s) => s.accountId)).not.toContain(debt.joint);
      });
    } finally {
      await close();
    }
  });
});
