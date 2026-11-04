// SPDX-License-Identifier: AGPL-3.0-or-later
import { createDb, systemContext, withContext } from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { cardStatementsDue } from '@fiscus/ledger';
import { addDays, type RecurringMonth, type RecurringOccurrence } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Card statements from the bank, on Upcoming and the calendar (#122; bills walkthrough D9). */
describe('card statements', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  let ada = '';
  let bea = '';
  /** Ada's cards: shared in full, view-only, and private. */
  const card = { full: '', view: '', mine: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const today = new Date().toISOString().slice(0, 10);
  const due = addDays(today, 5);
  const statementDate = addDays(today, -20);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@statements.test`,
        password: 'statements test Password1!',
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
      [B, 'bea@statements.test', 'member'],
      [V, 'vic@statements.test', 'viewer'],
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
    for (const [key, name, visibility] of [
      ['full', 'Joint card', 'full'],
      ['view', 'Travel card', 'view_only'],
      ['mine', 'My card', 'private'],
    ] as const) {
      card[key] = (
        await A.post(url('/accounts'), { name, type: 'credit', visibility })
      ).body.data.id;
    }
    // What the bank says (Plaid liabilities, #86): $500 owed, $35 minimum, due in five days.
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      for (const id of Object.values(card)) {
        await db.query(
          `INSERT INTO account_liabilities (account_id, household_id, minimum_payment_minor,
             next_due_date, last_statement_balance_minor, last_statement_date)
           VALUES ($1, $2, 3500, $3, -50000, $4)`,
          [id, hh, due, statementDate],
        );
      }
    } finally {
      await db.end();
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  const month = async (c: TestClient) =>
    (await c.get(url(`/recurring/month?month=${due.slice(0, 7)}`))).body.data as RecurringMonth;
  const statements = async (c: TestClient) =>
    (await month(c)).occurrences.filter((o) => o.kind === 'statement');
  const statementOf = async (c: TestClient, accountId: string) =>
    (await statements(c)).find((o) => o.accountId === accountId) as RecurringOccurrence;
  const pay = (date: string, amountMinor: number) =>
    A.post(url('/transactions'), {
      accountId: card.full,
      date,
      amountMinor,
      displayName: 'Payment, thank you',
    });

  it('shows from the bank with no history, and stays out of the bills total', async () => {
    const m = await month(A);
    expect(m.occurrences.filter((o) => o.kind === 'statement')).toHaveLength(3);
    expect(await statementOf(A, card.full)).toMatchObject({
      seriesId: null,
      name: 'Joint card statement',
      due,
      status: 'due',
      expectedMinor: -50_000,
      minimumMinor: 3_500,
      paidSoFarMinor: 0,
      statementPaid: null,
    });
    expect(m.totals.billsMinor).toBe(0);
    expect(m.totals.statementsMinor).toBe(150_000);
  });

  it('is seen only by those who see the card’s statement [REC-03]', async () => {
    // Bea sees the joint card in full; the travel card is view-only for her, and the other
    // private. Statement details are for owner and full access (0041).
    expect((await statements(B)).map((o) => o.accountId)).toEqual([card.full]);
    expect((await statements(V)).map((o) => o.accountId)).toEqual([card.full]);
    expect((await month(B)).totals.statementsMinor).toBe(50_000);
  });

  it('says whose card it is where more than one of you sees it (D22)', async () => {
    expect(await statementOf(A, card.full)).toMatchObject({ memberIds: [ada], shared: true });
    expect(await statementOf(A, card.mine)).toMatchObject({ memberIds: [ada], shared: false });
  });

  it('is partly paid, then minimum paid, then paid, by payments since the statement', async () => {
    // Before the statement: that paid the one before.
    await pay(addDays(statementDate, -2), 60_000);
    expect(await statementOf(A, card.full)).toMatchObject({ paidSoFarMinor: 0, status: 'due' });
    await pay(today, 1_000);
    expect(await statementOf(A, card.full)).toMatchObject({
      status: 'due',
      statementPaid: 'part',
      paidSoFarMinor: 1_000,
    });
    await pay(today, 2_500);
    expect(await statementOf(A, card.full)).toMatchObject({
      status: 'paid',
      statementPaid: 'minimum',
      paidSoFarMinor: 3_500,
    });
    await pay(today, 46_500);
    expect(await statementOf(A, card.full)).toMatchObject({
      status: 'paid',
      statementPaid: 'paid',
      paidSoFarMinor: 50_000,
    });
  });

  it('tells notifications which statements are due on the cards someone owns', async () => {
    const { db, close } = createDb(tdb.workerUrl, { max: 1 });
    try {
      await withContext(db, systemContext(hh), async (tx) => {
        const adas = await cardStatementsDue(tx, { memberId: ada, today, withinDays: 7 });
        // The joint card's is paid in full now.
        expect(adas.map((s) => s.accountId).sort()).toEqual([card.view, card.mine].sort());
        expect(adas[0]).toMatchObject({ owedMinor: 50_000, minimumMinor: 3_500, due });
        expect(await cardStatementsDue(tx, { memberId: ada, today, withinDays: 2 })).toEqual([]);
        expect(await cardStatementsDue(tx, { memberId: bea, today, withinDays: 7 })).toEqual([]);
      });
    } finally {
      await close();
    }
  });
});
