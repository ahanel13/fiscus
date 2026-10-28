// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Who owes whom (#111, walkthrough §8): shared expenses paid on one person's card, from a joint
 * account (which evens out), carried from earlier months, and under a category's split rule.
 */
describe('shared costs: who owes whom', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  const member = { A: '', B: '' };
  const acct = { joint: '', ada: '', bea: '' };
  const cat: Record<string, string> = {};
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const month = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
  };
  /** A shared expense: spent by `c` from `accountId`, for both of them. */
  const shared = async (
    c: TestClient,
    accountId: string,
    date: string,
    amountMinor: number,
    name: string,
    category = 'Groceries',
  ) => {
    const r = await c.post(url('/transactions'), {
      accountId,
      date,
      amountMinor,
      displayName: name,
      categoryId: cat[category],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.data.id as string;
    const at = await c.request('PUT', url(`/transactions/${id}/attribution`), {
      attribution: [{ memberId: member.A }, { memberId: member.B }],
    });
    expect(at.status, JSON.stringify(at.body)).toBe(204);
    return id;
  };
  const statement = async (c: TestClient, m = month(0)) => {
    const r = await c.get(url(`/shared-costs?month=${m}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@owes.test`,
        password: 'owes test Password1!',
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
        financeStyle: 'separate',
      })
    ).body.data.id;
    const invite = await A.post(url('/invites'), { email: 'bea@owes.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    for (const m of (await A.get(url('/members'))).body.data as { id: string; isYou: boolean }[]) {
      member[m.isYou ? 'A' : 'B'] = m.id;
    }
    for (const g of (await A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[]) {
      for (const c of g.categories) cat[c.name] = c.id;
    }
    const account = async (c: TestClient, name: string, owners?: string[]) =>
      (
        await c.post(url('/accounts'), {
          name,
          type: 'depository',
          visibility: 'private',
          ...(owners ? { owners: owners.map((memberId) => ({ memberId })) } : {}),
        })
      ).body.data.id as string;
    acct.ada = await account(A, 'Ada card');
    acct.bea = await account(B, 'Bea card');
    acct.joint = (
      await A.post(url('/accounts'), {
        name: 'Joint checking',
        type: 'depository',
        visibility: 'full',
        owners: [{ memberId: member.A }, { memberId: member.B }],
      })
    ).body.data.id;

    // Last month: Ada paid 60.00 for both.
    await shared(A, acct.ada, `${month(-1)}-10`, -6000, 'Market', 'Groceries');
    // This month: Ada's Costco and movie, Bea's vet and dinner, rent from the joint account.
    await shared(A, acct.ada, `${month(0)}-01`, -18640, 'Costco', 'Groceries');
    await shared(A, acct.ada, `${month(0)}-01`, -4000, 'Movie night', 'Entertainment');
    await shared(B, acct.bea, `${month(0)}-01`, -13162, 'Riverside Vet', 'Pets');
    await shared(B, acct.bea, `${month(0)}-01`, -8850, 'Lantern Thai', 'Restaurants');
    const rent = await A.post(url('/transactions'), {
      accountId: acct.joint,
      date: `${month(0)}-01`,
      amountMinor: -215000,
      displayName: 'Rent',
      categoryId: cat['Rent or mortgage'],
    });
    expect(rent.status).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('gives each person their balance, carried and now, worded from their side', async () => {
    const a = await statement(A);
    // 30.00 from last month; this month 93.20 + 20.00 − 65.81 − 44.25 = 3.14.
    expect(a.carried).toEqual([{ memberId: member.B, amountMinor: 3000 }]);
    expect(a.balances).toEqual([{ memberId: member.B, amountMinor: 3314 }]);
    const b = await statement(B);
    expect(b.balances).toEqual([{ memberId: member.A, amountMinor: -3314 }]);
  });

  it('lists the month’s shared expenses with their effect, and rent from the joint account evens out', async () => {
    const a = await statement(A);
    expect(a.sharedSpendingMinor).toBe(18640 + 4000 + 13162 + 8850 + 215000);
    expect(a.evensOutMinor).toBe(215000);
    const byName = Object.fromEntries(
      (
        a.expenses as { displayName: string; effect: { amountMinor: number }[]; paidBy: string[] }[]
      ).map((e) => [e.displayName, e]),
    );
    expect(byName.Costco!.effect).toEqual([{ memberId: member.B, amountMinor: 9320 }]);
    expect(byName['Riverside Vet']!.effect).toEqual([{ memberId: member.B, amountMinor: -6581 }]);
    expect(byName['Riverside Vet']!.paidBy).toEqual([member.B]);
    expect(byName.Rent!.effect).toEqual([]);
    // Last month's market isn't this month's.
    expect(byName.Market).toBeUndefined();
  });

  it('follows a category’s split rule from its month', async () => {
    const r = await A.request('PUT', url(`/split-rules/categories/${cat.Pets}`), {
      rule: {
        method: 'fixed_percent',
        shares: [
          { memberId: member.B, shareBps: 7000 },
          { memberId: member.A, shareBps: 3000 },
        ],
      },
      effectiveFrom: `${month(0)}-01`,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = await statement(A);
    // The vet is now 30% Ada's: she owes 39.48 of Bea's 131.62 (the odd cent is the payer's).
    const vet = a.expenses.find((e: { displayName: string }) => e.displayName === 'Riverside Vet');
    expect(vet.effect).toEqual([{ memberId: member.B, amountMinor: -3948 }]);
    expect(a.balances).toEqual([
      { memberId: member.B, amountMinor: 3000 + 9320 + 2000 - 3948 - 4425 },
    ]);
  });

  it('settles up with a transfer already in Fiscus, which stops counting as income (#112)', async () => {
    const owed = 3000 + 9320 + 2000 - 3948 - 4425; // from the split rule test above
    const zelle = await A.post(url('/transactions'), {
      accountId: acct.ada,
      date: `${month(0)}-01`,
      amountMinor: owed,
      displayName: 'Zelle from Bea',
    });
    await A.post(url('/transactions'), {
      accountId: acct.ada,
      date: `${month(0)}-01`,
      amountMinor: 1200,
      displayName: 'Refund',
    });
    const cands = await A.get(
      url(`/shared-costs/settlement-candidates?memberId=${member.B}&balanceMinor=${owed}`),
    );
    expect(cands.status, JSON.stringify(cands.body)).toBe(200);
    expect(cands.body.data[0]).toMatchObject({ displayName: 'Zelle from Bea', amountMinor: owed });

    const r = await A.post(url('/shared-costs/settlements'), {
      memberId: member.B,
      direction: 'they_paid',
      amountMinor: owed,
      date: `${month(0)}-01`,
      kind: 'transfer',
      transactionId: zelle.body.data.id,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await statement(A)).balances).toEqual([]);
    const b = await statement(B);
    expect(b.balances).toEqual([]);
    expect(b.settlements).toEqual([
      expect.objectContaining({ fromMemberId: member.B, toMemberId: member.A, kind: 'transfer' }),
    ]);
    // The transfer is a settle-up now: in the Settlement category, not income.
    const t = (await A.get(url(`/transactions/${zelle.body.data.id}`))).body.data;
    const settlementCat = (
      (await A.get(url('/categories'))).body.data as {
        categories: { id: string; systemKey: string | null }[];
      }[]
    )
      .flatMap((g) => g.categories)
      .find((c) => c.systemKey === 'settlement')!.id;
    expect(t.categoryId).toBe(settlementCat);
    // It can't settle twice.
    const twice = await A.post(url('/shared-costs/settlements'), {
      memberId: member.B,
      direction: 'they_paid',
      amountMinor: 1,
      date: `${month(0)}-01`,
      kind: 'transfer',
      transactionId: zelle.body.data.id,
    });
    expect([twice.status, twice.body.code]).toEqual([422, 'not_a_settlement_transfer']);
  });

  it('records one paid another way, an adjustment with a note, and removes one', async () => {
    const cash = await B.post(url('/shared-costs/settlements'), {
      memberId: member.A,
      direction: 'you_paid',
      amountMinor: 2500,
      date: `${month(0)}-01`,
      kind: 'paid',
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    // Bea paid 25.00 more than she owed: Ada owes it back.
    expect((await statement(A)).balances).toEqual([{ memberId: member.B, amountMinor: -2500 }]);
    const noNote = await A.post(url('/shared-costs/settlements'), {
      memberId: member.B,
      direction: 'you_paid',
      amountMinor: 2500,
      date: `${month(0)}-01`,
      kind: 'adjustment',
    });
    expect(noNote.status).toBe(422);
    const adj = await A.post(url('/shared-costs/settlements'), {
      memberId: member.B,
      direction: 'you_paid',
      amountMinor: 2500,
      date: `${month(0)}-01`,
      kind: 'adjustment',
      note: 'Paid Bea back for the concert in cash',
    });
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    expect((await statement(A)).balances).toEqual([]);
    expect((await B.delete(url(`/shared-costs/settlements/${cash.body.data.id}`))).status).toBe(
      204,
    );
    expect((await statement(A)).balances).toEqual([{ memberId: member.B, amountMinor: 2500 }]);
    const self = await A.post(url('/shared-costs/settlements'), {
      memberId: member.A,
      direction: 'they_paid',
      amountMinor: 1,
      date: `${month(0)}-01`,
      kind: 'paid',
    });
    expect([self.status, self.body.code]).toEqual([422, 'settle_with_yourself']);
  });

  it('refuses a month that isn’t one', async () => {
    expect((await A.get(url('/shared-costs?month=2026-13'))).status).toBe(422);
  });
});
