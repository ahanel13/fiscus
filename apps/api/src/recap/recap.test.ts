// SPDX-License-Identifier: AGPL-3.0-or-later
import { createDb, systemContext, withContext } from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { buildWeeklyRecap, lastWeekStart, RecapContextError } from '@fiscus/ledger';
import { addDays, type WeeklyRecap } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** The weekly recap (#128; bills walkthrough §8, D21; SYS-02). */
describe('weekly recap', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let C: TestClient;
  let hh = '';
  let alone = '';
  let ada = '';
  const account = { joint: '', adaCard: '', beaCard: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = lastWeekStart(today, 1);
  const inWeek = addDays(weekStart, 2);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@recap.test`,
        password: 'recap test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    C = await signup('cy');
    const household = async (c: TestClient, name: string) =>
      (
        await c.post('/api/v1/households', {
          name,
          baseCurrency: 'USD',
          timezone: 'UTC',
          financeStyle: 'hybrid',
        })
      ).body.data.id as string;
    hh = await household(A, 'Rivera Home');
    alone = await household(C, 'Cy’s place');
    const invite = await A.post(url('/invites'), { email: 'bea@recap.test', role: 'member' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    ada = ((await A.get(url('/members'))).body.data as { id: string; isYou: boolean }[]).find(
      (m) => m.isYou,
    )!.id;
    const add = async (c: TestClient, name: string, type: string, visibility: string) =>
      (await c.post(url('/accounts'), { name, type, visibility })).body.data.id as string;
    account.joint = await add(A, 'Joint checking', 'depository', 'full');
    account.adaCard = await add(A, 'Ada’s card', 'credit', 'private');
    account.beaCard = await add(B, 'Bea’s card', 'credit', 'private');
    const spend = async (c: TestClient, accountId: string, displayName: string, amount: number) => {
      const r = await c.post(url('/transactions'), {
        accountId,
        date: inWeek,
        amountMinor: amount,
        displayName,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    };
    await spend(A, account.adaCard, 'Costco', -41_218);
    await spend(A, account.joint, 'Corner Cafe', -2_500);
    await spend(B, account.beaCard, 'Secret Shop', -9_999);
    // A bill on the joint account, due in two days, and Ada's card statement in three.
    const due = addDays(today, 2);
    const bill = await A.post(url('/recurring'), {
      accountId: account.joint,
      name: 'Cascade Water',
      kind: 'bill',
      match: { direction: 'out', description: { op: 'equals', value: 'Cascade Water' } },
      schedule: {
        unit: 'month',
        every: 1,
        days: [Number(due.slice(8))],
        anchor: due,
        weekend: 'as_is',
      },
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      await db.query(
        `INSERT INTO account_liabilities (account_id, household_id, minimum_payment_minor,
           next_due_date, last_statement_balance_minor, last_statement_date)
         VALUES ($1, $2, 3500, $3, -50000, $4)`,
        [account.adaCard, hh, addDays(today, 3), addDays(today, -20)],
      );
    } finally {
      await db.end();
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  const recap = async (c: TestClient, household = hh) => {
    const r = await c.get(`/api/v1/households/${household}/recap`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as WeeklyRecap;
  };

  it('is last week’s, for the person reading it', async () => {
    const r = await recap(A);
    expect(r).toMatchObject({
      householdName: 'Rivera Home',
      memberName: 'ada',
      currency: 'USD',
      weekStart,
      weekEnd: addDays(weekStart, 6),
      today,
      spending: { spentMinor: 43_718, usualMinor: null },
      quiet: false,
    });
    expect(r.worthALook[0]).toEqual({
      kind: 'biggest_purchase',
      name: 'Costco',
      amountMinor: -41_218,
      account: 'Ada’s card',
      date: inWeek,
    });
    expect(r.history.seq).toBeGreaterThan(0);
    expect(r.history.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shows what’s coming up this week: bills and card statements', async () => {
    const r = await recap(A);
    expect(r.comingUp.map((c) => [c.kind, c.name, c.due])).toEqual([
      ['bill', 'Cascade Water', addDays(today, 2)],
      ['statement', 'Ada’s card statement', addDays(today, 3)],
    ]);
    expect(r.comingUp[1]).toMatchObject({ amountMinor: -50_000, about: false });
  });

  it('never shows someone else’s private card (SYS-02, D21)', async () => {
    const a = await recap(A);
    const b = await recap(B);
    expect(b.spending.spentMinor).toBe(2_500 + 9_999);
    expect(JSON.stringify(a)).not.toContain('Secret Shop');
    expect(JSON.stringify(b)).not.toContain('Costco');
    expect(JSON.stringify(b)).not.toContain('Ada’s card');
    // Bea sees the joint account's bill, not Ada's card statement.
    expect(b.comingUp.map((c) => c.name)).toEqual(['Cascade Water']);
    expect(b.comingUp[0]!.lookAfter).toBe('ada');
    expect(b.sees).toBe('yours_and_ours');
  });

  it('is short, not empty, on a quiet week', async () => {
    const r = await recap(C, alone);
    expect(r).toMatchObject({
      householdName: 'Cy’s place',
      sees: null,
      spending: { spentMinor: 0, usualMinor: null },
      budgets: null,
      netWorth: null,
      comingUp: [],
      worthALook: [],
      toReview: 0,
      quiet: true,
    });
  });

  it('is built only in its reader’s own context, never system context', async () => {
    const { db, close } = createDb(tdb.workerUrl, { max: 1 });
    try {
      await expect(
        withContext(db, systemContext(hh), (tx) =>
          buildWeeklyRecap(tx, { memberId: ada, weekStart, today }),
        ),
      ).rejects.toBeInstanceOf(RecapContextError);
    } finally {
      await close();
    }
  });

  it('says what’s left in this month’s budgets, and a category over its budget', async () => {
    const cat: Record<string, string> = {};
    for (const g of (await A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[]) {
      for (const c of g.categories) cat[c.name] = c.id;
    }
    const made = await A.post(url('/budgets'), {
      scope: 'mine',
      amounts: [
        { categoryId: cat.Restaurants!, amountMinor: 1_000 },
        { categoryId: cat.Groceries!, amountMinor: 20_000 },
      ],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const r = await A.post(url('/transactions'), {
      accountId: account.adaCard,
      date: today,
      amountMinor: -5_130,
      displayName: 'Noodle Bar',
      categoryId: cat.Restaurants,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = await recap(A);
    expect(a.budgets).toMatchObject({ month: today.slice(0, 7), leftMinor: 20_000 - 4_130 });
    expect(a.worthALook).toContainEqual({
      kind: 'over_budget',
      category: 'Restaurants',
      overMinor: 4_130,
    });
    // Ada's own budget is hers alone.
    expect((await recap(B)).budgets).toBeNull();
  });
});
