// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Ownership history (#447): a transaction with no attribution of its own is for whoever owned its
 * account on its date. Changing owners "from today" leaves the past where it was; "always" moves
 * it; the household's finance style picks when nobody says.
 */
describe('account ownership history', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  const member = { A: '', B: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const today = new Date().toISOString().slice(0, 10);
  const PAST = '2026-03-10';

  const account = async (name: string) =>
    (await A.post(url('/accounts'), { name, type: 'depository', visibility: 'full' })).body.data
      .id as string;
  const spend = async (
    accountId: string,
    date: string,
    amountMinor: number,
    displayName: string,
  ) => {
    const r = await A.post(url('/transactions'), { accountId, date, amountMinor, displayName });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  /** Ids of the transactions in `accountId` under a spending lens, as Ada sees them. */
  const under = async (lens: string, accountId: string) =>
    new Set(
      (
        (await A.get(url(`/transactions?lens=${lens}&accounts=${accountId}&limit=100`))).body
          .data as { id: string }[]
      ).map((t) => t.id),
    );
  const transaction = async (id: string) =>
    (await A.get(url(`/transactions/${id}`))).body.data as {
      attribution: { memberId: string }[];
      attributionInherited: boolean;
      paidBy: string[];
    };
  const setOwners = async (accountId: string, from?: 'today' | 'always') => {
    const r = await A.request('PUT', url(`/accounts/${accountId}/owners`), {
      owners: [{ memberId: member.A }, { memberId: member.B }],
      ...(from ? { from } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@ownership.test`,
        password: 'ownership test Password1!',
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
    const invite = await A.post(url('/invites'), { email: 'bea@ownership.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    for (const m of (await A.get(url('/members'))).body.data as {
      id: string;
      isYou: boolean;
    }[]) {
      member[m.isYou ? 'A' : 'B'] = m.id;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('keeps the past with whoever owned the account, when owners change from today', async () => {
    const checking = await account('Ada checking');
    const before = await spend(checking, PAST, -4200, 'Groceries in March');
    await setOwners(checking, 'today');
    const after = await spend(checking, today, -1800, 'Groceries today');

    expect(await under('me', checking)).toEqual(new Set([before]));
    expect(await under('shared', checking)).toEqual(new Set([after]));
    // What the transaction says, and who paid, follow its date too.
    const old = await transaction(before);
    expect(old.attribution.map((a) => a.memberId)).toEqual([member.A]);
    expect([old.attributionInherited, old.paidBy]).toEqual([true, [member.A]]);
    expect((await transaction(after)).attribution.map((a) => a.memberId).sort()).toEqual(
      [member.A, member.B].sort(),
    );

    // Cash flow under "me" still has March's spending.
    const march = await A.get(
      url('/cash-flow?range=custom&from=2026-03-01&to=2026-03-31&granularity=month&lens=me'),
    );
    expect(march.body.data.totals.spendingMinor).toBe(4200);

    // A second change the same day replaces the first, and still leaves March alone.
    const r = await A.request('PUT', url(`/accounts/${checking}/owners`), {
      owners: [
        { memberId: member.A, shareBps: 6000 },
        { memberId: member.B, shareBps: 4000 },
      ],
      from: 'today',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect(await under('me', checking)).toEqual(new Set([before]));
  });

  it('moves the past too, when owners change for its whole history', async () => {
    const savings = await account('Ada savings');
    const before = await spend(savings, PAST, -900, 'Fee in March');
    await setOwners(savings, 'always');
    expect(await under('me', savings)).toEqual(new Set());
    expect(await under('shared', savings)).toEqual(new Set([before]));
  });

  it('lets an attribution of its own win, whatever the date', async () => {
    const card = await account('Ada card');
    const gift = await spend(card, PAST, -5000, 'A gift for Bea');
    const r = await A.request('PUT', url(`/transactions/${gift}/attribution`), {
      attribution: [{ memberId: member.A }, { memberId: member.B }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    await setOwners(card, 'today');
    expect(await under('shared', card)).toEqual(new Set([gift]));
    expect((await transaction(gift)).attributionInherited).toBe(false);
  });

  it('follows the finance style when nobody says: Hybrid keeps the past, Combined moves it', async () => {
    const hybrid = await account('Ada wallet');
    const old = await spend(hybrid, PAST, -300, 'Coffee in March');
    await setOwners(hybrid);
    expect(await under('me', hybrid)).toEqual(new Set([old]));

    const { version } = (await A.get(url())).body.data as { version: number };
    const style = await A.request(
      'PATCH',
      url(),
      { financeStyle: 'combined' },
      { headers: { 'if-match': `"v${version}"` } },
    );
    expect(style.status, JSON.stringify(style.body)).toBeLessThan(300);
    const combined = await account('Ada travel');
    const trip = await spend(combined, PAST, -12000, 'Flights in March');
    const joint = await A.post(url('/accounts/make-joint'));
    expect(joint.status, JSON.stringify(joint.body)).toBe(200);
    expect(await under('shared', combined)).toEqual(new Set([trip]));
    // Ada's wallet was made joint "from today" already: making it joint again changes nothing.
    expect(await under('me', hybrid)).toEqual(new Set([old]));
  });
});
