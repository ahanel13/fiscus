// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * A split by income (#110, ADR 0006 F4, walkthrough D19): it waits for everyone the expense is
 * for, uses the income each chose (paychecks over the last 3 months, or a figure), shows only the
 * split, and goes back to the default from the day someone withdraws.
 */
describe('split by income', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  const member = { A: '', B: '' };
  const cat: Record<string, string> = {};
  const acct = { adaCard: '', adaChecking: '', beaCard: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const month = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
  };
  const today = new Date().toISOString().slice(0, 10);
  const owes = async () => {
    const r = await A.get(url(`/shared-costs?month=${month(0)}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // From Ada's side: negative, Ada owes Bea.
    return -(
      r.body.data.balances.find((b: { memberId: string }) => b.memberId === member.B)
        ?.amountMinor ?? 0
    );
  };
  const state = async (c: TestClient) => {
    const r = await c.get(url('/income-split'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@income.test`,
        password: 'income test Password1!',
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
        financeStyle: 'separate',
      })
    ).body.data.id;
    for (const [c, email, role] of [
      [B, 'bea@income.test', 'member'],
      [V, 'vic@income.test', 'viewer'],
    ] as const) {
      const invite = await A.post(url('/invites'), { email, role });
      await c.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    for (const m of (await A.get(url('/members'))).body.data as {
      id: string;
      displayName: string;
    }[]) {
      if (m.displayName === 'ada') member.A = m.id;
      if (m.displayName === 'bea') member.B = m.id;
    }
    for (const g of (await A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[]) {
      for (const c of g.categories) cat[c.name] = c.id;
    }
    const account = async (c: TestClient, name: string) =>
      (await c.post(url('/accounts'), { name, type: 'depository', visibility: 'private' })).body
        .data.id as string;
    acct.adaCard = await account(A, 'Ada card');
    acct.adaChecking = await account(A, 'Ada checking');
    acct.beaCard = await account(B, 'Bea card');
    // Ada's paychecks: 3,000.00 a month over the last 3 months, in her private account.
    for (const n of [-3, -2, -1]) {
      const r = await A.post(url('/transactions'), {
        accountId: acct.adaChecking,
        date: `${month(n)}-05`,
        amountMinor: 300000,
        displayName: 'Payroll',
        categoryId: cat.Paychecks,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    // A paycheck this month doesn't count until next month.
    await A.post(url('/transactions'), {
      accountId: acct.adaChecking,
      date: `${month(0)}-01`,
      amountMinor: 900000,
      displayName: 'Bonus',
      categoryId: cat.Paychecks,
    });
    // Rent today, paid by Bea, for both.
    const rent = await B.post(url('/transactions'), {
      accountId: acct.beaCard,
      date: today,
      amountMinor: -200000,
      displayName: 'Rent',
      categoryId: cat['Rent or mortgage'],
    });
    expect(rent.status, JSON.stringify(rent.body)).toBe(201);
    await B.request('PUT', url(`/transactions/${rent.body.data.id}/attribution`), {
      attribution: [{ memberId: member.A }, { memberId: member.B }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('takes a split by income as a rule, which waits for everyone', async () => {
    const r = await A.request('PUT', url(`/split-rules/categories/${cat['Rent or mortgage']}`), {
      rule: { method: 'income_proportional' },
      effectiveFrom: `${month(0)}-01`,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.rule).toEqual({ method: 'income_proportional' });
    expect(await state(A)).toEqual({
      today,
      members: expect.arrayContaining([
        { memberId: member.A, consented: false },
        { memberId: member.B, consented: false },
      ]),
      shares: [],
      yours: null,
    });
    // Viewers aren't asked.
    expect((await state(A)).members).toHaveLength(2);
    // Until then, the household default: equally.
    expect(await owes()).toBe(100000);
  });

  it('still waits while only some have agreed', async () => {
    const r = await A.request('PUT', url('/income-split/consent'), { basis: 'actual' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.yours).toEqual({ basis: 'actual' });
    expect((await state(B)).members).toContainEqual({ memberId: member.A, consented: true });
    expect(await owes()).toBe(100000);
  });

  it('splits by income once everyone it’s for has agreed', async () => {
    const r = await B.request('PUT', url('/income-split/consent'), {
      basis: 'declared',
      declaredMonthlyMinor: 200000,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Ada 3,000 a month from her paychecks, Bea 2,000 declared: 60% / 40%.
    const shares = [
      { memberId: member.A, shareBps: 6000 },
      { memberId: member.B, shareBps: 4000 },
    ];
    for (const c of [A, B, V]) {
      expect((await state(c)).shares).toEqual(expect.arrayContaining(shares));
    }
    expect(await owes()).toBe(120000);
  });

  it('shows each person their own choice, and nobody else’s income', async () => {
    expect((await state(B)).yours).toEqual({ basis: 'declared', declaredMonthlyMinor: 200000 });
    for (const c of [A, V]) {
      const s = await state(c);
      expect(JSON.stringify(s)).not.toContain('200000');
      expect(JSON.stringify(s)).not.toContain('declared');
    }
    expect(JSON.stringify(await state(B))).not.toContain('300000');
  });

  it('records agreeing in the activity, without any income', async () => {
    const r = await A.get(url('/activity?limit=100'));
    const events = r.body.data as { action: string; targetId: string }[];
    expect(
      events.filter((e) => e.action === 'income_split.consented').map((e) => e.targetId),
    ).toEqual(expect.arrayContaining([member.A, member.B]));
    expect(JSON.stringify(r.body)).not.toContain('200000');
  });

  it('uses a changed figure from today, seen only by its owner', async () => {
    const r = await B.request('PUT', url('/income-split/consent'), {
      basis: 'declared',
      declaredMonthlyMinor: 300000,
    });
    expect(r.status).toBe(200);
    expect(await owes()).toBe(100000);
    const feed = (await A.get(url('/activity?limit=100'))).body.data as { action: string }[];
    expect(feed.some((e) => e.action === 'income_split.income_changed')).toBe(false);
  });

  it('goes back to the default from the day someone withdraws', async () => {
    expect((await A.delete(url('/income-split/consent'))).status).toBe(204);
    expect(await state(A)).toMatchObject({
      yours: null,
      shares: [{ memberId: member.B, shareBps: 10000 }],
    });
    expect(await owes()).toBe(100000);
    // Withdrawing again changes nothing.
    expect((await A.delete(url('/income-split/consent'))).status).toBe(204);
  });

  it('keeps viewers out, and takes only a figure of zero or more', async () => {
    expect((await V.request('PUT', url('/income-split/consent'), { basis: 'actual' })).status).toBe(
      403,
    );
    expect((await V.delete(url('/income-split/consent'))).status).toBe(403);
    const negative = await B.request('PUT', url('/income-split/consent'), {
      basis: 'declared',
      declaredMonthlyMinor: -1,
    });
    expect(negative.status).toBe(422);
  });
});
