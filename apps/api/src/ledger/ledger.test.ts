// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Categories and transactions behavior (docs/design/transactions.md). Permissions are in permissions.test.ts. */
describe('ledger', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client;
  let A: TestClient;
  let B: TestClient;
  let hh: string;
  const member = {} as Record<'A' | 'B', string>;
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const sql = async (text: string, params: unknown[] = []) =>
    (await owner.query(text, params)).rows;

  const account = async (c: TestClient, body: Record<string, unknown>) =>
    (await c.post(url('/accounts'), { name: 'Acct', type: 'depository', ...body })).body.data
      .id as string;
  const txn = async (
    c: TestClient,
    accountId: string,
    date: string,
    amountMinor: number,
    displayName = 'Item',
  ) => {
    const r = await c.post(url('/transactions'), { accountId, date, amountMinor, displayName });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const balances = async (accountId: string) =>
    Object.fromEntries(
      (await A.get(url(`/accounts/${accountId}/balances?from=2026-01-01`))).body.data.map(
        (b: { asOf: string; amountMinor: number }) => [b.asOf, b.amountMinor],
      ),
    );

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@ledger.test`,
        password: 'ledger test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    const h = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data;
    hh = h.id;
    member.A = h.you.memberId;
    const invite = await A.post(url('/invites'), { email: 'bea@ledger.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    member.B = (await B.get(url())).body.data.you.memberId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await owner?.end();
    await tdb?.stop();
  });

  it('gives a new household the default categories', async () => {
    const groups = (await A.get(url('/categories'))).body.data;
    expect(groups).toHaveLength(14);
    expect(groups.map((g: { name: string }) => g.name)).toContain('Food');
    const system = groups
      .flatMap((g: { categories: { systemKey: string | null }[] }) => g.categories)
      .filter((c: { systemKey: string | null }) => c.systemKey)
      .map((c: { systemKey: string }) => c.systemKey)
      .sort();
    expect(system).toEqual(['settlement', 'transfer', 'uncategorized']);
  });

  it('setting a category marks it reviewed, unless the household turns that off (#349)', async () => {
    const acct = await account(A, { name: 'Review acct' });
    const all = (await A.get(url('/categories'))).body.data.flatMap(
      (g: { categories: { id: string; name: string }[] }) => g.categories,
    );
    const cat = (name: string) => all.find((c: { name: string }) => c.name === name).id;
    const get = async (id: string) => (await A.get(url(`/transactions/${id}`))).body.data;
    const flag = async (id: string) => {
      const t = await get(id);
      const r = await A.request(
        'PATCH',
        url(`/transactions/${id}`),
        { reviewStatus: 'needs_review' },
        { headers: { 'if-match': `"v${t.version}"` } },
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    const categorize = async (id: string, name: string) => {
      const t = await get(id);
      const r = await A.request(
        'PATCH',
        url(`/transactions/${id}`),
        { categoryId: cat(name) },
        { headers: { 'if-match': `"v${t.version}"` } },
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.data;
    };

    const one = await txn(A, acct, '2025-01-15', -1200, 'Review probe');
    await flag(one);
    expect((await categorize(one, 'Coffee')).reviewStatus).toBe('reviewed');
    // Saying otherwise in the same change wins.
    await flag(one);
    const t = await get(one);
    const keep = await A.request(
      'PATCH',
      url(`/transactions/${one}`),
      { categoryId: cat('Restaurants'), reviewStatus: 'needs_review' },
      { headers: { 'if-match': `"v${t.version}"` } },
    );
    expect(keep.body.data.reviewStatus).toBe('needs_review');
    // In bulk too.
    const bulk = await A.request('PATCH', url('/transactions'), {
      ids: [one],
      changes: { categoryId: cat('Coffee') },
    });
    expect(bulk.body.data.updated).toEqual([one]);
    expect((await get(one)).reviewStatus).toBe('reviewed');

    // Off: the category changes, the review flag stays.
    const h = (await A.get(url())).body.data;
    const off = await A.request(
      'PATCH',
      url(),
      { categorizeMarksReviewed: false },
      { headers: { 'if-match': `"v${h.version}"` } },
    );
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data.categorizeMarksReviewed).toBe(false);
    await flag(one);
    expect((await categorize(one, 'Groceries')).reviewStatus).toBe('needs_review');
    const h2 = (await A.get(url())).body.data;
    await A.request(
      'PATCH',
      url(),
      { categorizeMarksReviewed: true },
      { headers: { 'if-match': `"v${h2.version}"` } },
    );
  });

  describe('balances follow transactions (design §2)', () => {
    it('computes days around an entered balance, backward and forward', async () => {
      const acct = await account(A, {
        openingBalance: { amountMinor: 100000, asOf: '2026-03-10' },
      });
      await txn(A, acct, '2026-03-05', -1000);
      await txn(A, acct, '2026-03-15', -2000);
      const late = await txn(A, acct, '2026-03-08', -500);
      expect(await balances(acct)).toEqual({
        '2026-03-05': 100500, // the anchor minus what happened after: -500 on the 8th
        '2026-03-08': 100000,
        '2026-03-10': 100000, // entered: the anchor
        '2026-03-15': 98000,
      });
      // Editing and deleting recompute too.
      const v = (await A.get(url(`/transactions/${late}`))).body.data.version;
      await A.request(
        'PATCH',
        url(`/transactions/${late}`),
        { amountMinor: -700 },
        { headers: { 'if-match': `"v${v}"` } },
      );
      expect((await balances(acct))['2026-03-05']).toBe(100700);
      await A.delete(url(`/transactions/${late}`));
      expect(await balances(acct)).toEqual({
        '2026-03-05': 100000,
        '2026-03-10': 100000,
        '2026-03-15': 98000,
      });
    });

    it('runs a total from zero when no balance was entered', async () => {
      const acct = await account(A, {});
      await txn(A, acct, '2026-04-01', 50000);
      await txn(A, acct, '2026-04-02', -1250);
      expect(await balances(acct)).toEqual({ '2026-04-01': 50000, '2026-04-02': 48750 });
    });

    it('never computes a bank-connected account’s balance from its transactions', async () => {
      const acct = await account(A, {
        openingBalance: { amountMinor: 500000, asOf: '2026-03-10' },
      });
      // Simulate a bank connection (M2): the reported balance is the truth.
      await sql('UPDATE accounts SET connection_id = gen_random_uuid() WHERE id = $1', [acct]);
      await txn(A, acct, '2026-03-12', -2000);
      await txn(A, acct, '2026-03-01', -1000);
      expect(await balances(acct)).toEqual({ '2026-03-10': 500000 });
    });

    it('leaves hand-valued assets alone', async () => {
      const house = await account(A, {
        type: 'property',
        openingBalance: { amountMinor: 41000000, asOf: '2026-01-01' },
      });
      await txn(A, house, '2026-02-01', -100000, 'Roof repair');
      expect(await balances(house)).toEqual({ '2026-01-01': 41000000 });
    });
  });

  it('refuses a $0 transaction', async () => {
    const acct = await account(A, {});
    const r = await A.post(url('/transactions'), {
      accountId: acct,
      date: '2026-05-01',
      amountMinor: 0,
      displayName: 'Nothing',
    });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].message).toBe('Enter an amount');
  });

  describe('splits', () => {
    it('requires the parts to add up, lists parts instead of the whole, and unsplits', async () => {
      const acct = await account(A, {});
      const id = await txn(A, acct, '2026-05-01', -10000, 'Costco');
      const bad = await A.request('PUT', url(`/transactions/${id}/splits`), {
        parts: [{ amountMinor: -6000 }, { amountMinor: -3000 }],
      });
      expect(bad.body.code).toBe('split_total');
      const zero = await A.request('PUT', url(`/transactions/${id}/splits`), {
        parts: [{ amountMinor: -10000 }, { amountMinor: 0 }],
      });
      expect(zero.status).toBe(422);
      expect(zero.body.errors[0].message).toBe('A part can’t be zero');
      const ok = await A.request('PUT', url(`/transactions/${id}/splits`), {
        parts: [
          { amountMinor: -6000, displayName: 'Groceries' },
          { amountMinor: -4000, displayName: 'Household', attribution: [{ memberId: member.B }] },
        ],
      });
      expect(ok.status).toBe(200);
      const listed = (await A.get(url(`/transactions?accounts=${acct}`))).body.data;
      expect(listed.map((t: { displayName: string }) => t.displayName).sort()).toEqual([
        'Groceries',
        'Household',
      ]);
      expect(listed.every((t: { parentId: string }) => t.parentId === id)).toBe(true);
      expect((await A.delete(url(`/transactions/${id}/splits`))).status).toBe(204);
      const after = (await A.get(url(`/transactions?accounts=${acct}`))).body.data;
      expect(after.map((t: { id: string }) => t.id)).toEqual([id]);
    });
  });

  describe('lists', () => {
    let joint = '';
    let privateA = '';
    let forB = '';
    beforeAll(async () => {
      joint = await account(A, { owners: [{ memberId: member.A }, { memberId: member.B }] });
      privateA = await account(A, { visibility: 'private' });
      await txn(A, joint, '2026-06-01', -3000, 'Groceries joint');
      await txn(A, privateA, '2026-06-02', -1500, 'Coffee mine');
      forB = await txn(A, privateA, '2026-06-03', -2500, 'Gift for Bea');
      await A.request('PUT', url(`/transactions/${forB}/attribution`), {
        attribution: [{ memberId: member.B }],
      });
    });

    it('follows attribution for the spending lens', async () => {
      const names = async (c: TestClient, lens: string) =>
        (await c.get(url(`/transactions?lens=${lens}&from=2026-06-01&to=2026-06-30`))).body.data
          .map((t: { displayName: string }) => t.displayName)
          .sort();
      expect(await names(A, 'me')).toEqual(['Coffee mine']);
      expect(await names(A, 'shared')).toEqual(['Groceries joint']);
      expect(await names(A, `member:${member.B}`)).toEqual(['Gift for Bea']);
      expect(await names(B, 'me')).toEqual(['Gift for Bea']);
      expect(await names(B, 'all')).toEqual(['Gift for Bea', 'Groceries joint']);
    });

    it('shows a purchase shared through attribution as paid by a person, not an account (F1)', async () => {
      const r = await B.get(url('/transactions?from=2026-06-01&to=2026-06-30'));
      const gift = r.body.data.find((t: { id: string }) => t.id === forB);
      expect(gift).toMatchObject({
        account: null,
        paidBy: [member.A],
        attribution: [{ memberId: member.B, shareBps: 10000 }],
      });
      expect(JSON.stringify(r.body)).not.toContain(privateA);
    });

    it('searches names and pages with a cursor', async () => {
      expect(
        (await A.get(url('/transactions?q=coffee'))).body.data.map(
          (t: { displayName: string }) => t.displayName,
        ),
      ).toEqual(['Coffee mine']);
      expect((await A.get(url('/transactions?q=100%25'))).body.data).toEqual([]); // wildcards are literal
      const first = await A.get(url('/transactions?from=2026-06-01&to=2026-06-30&limit=2'));
      expect(first.body.data).toHaveLength(2);
      const second = await A.get(
        url(
          `/transactions?from=2026-06-01&to=2026-06-30&limit=2&cursor=${first.body.meta.nextCursor}`,
        ),
      );
      expect(second.body.data).toHaveLength(1);
      expect(second.body.meta.nextCursor).toBeNull();
      const all = [...first.body.data, ...second.body.data].map((t: { date: string }) => t.date);
      expect(all).toEqual(['2026-06-03', '2026-06-02', '2026-06-01']);
    });

    it('bulk edits row by row, refusing what the caller may not change', async () => {
      const visible = (await B.get(url('/transactions?from=2026-06-01&to=2026-06-30'))).body.data;
      const groceries = visible.find(
        (t: { displayName: string }) => t.displayName === 'Groceries joint',
      ).id;
      const r = await B.request('PATCH', url('/transactions'), {
        ids: [groceries, forB, crypto.randomUUID()],
        changes: { reviewStatus: 'reviewed' },
      });
      expect(r.body.data.updated).toEqual([groceries]);
      expect(r.body.data.refused.map((x: { code: string }) => x.code).sort()).toEqual([
        'forbidden',
        'not_found',
      ]);
    });
  });

  describe('date override (#281)', () => {
    it('moves an imported transaction to another day without losing the bank’s date', async () => {
      const acct = await account(A, {});
      const [row] = await sql(
        `INSERT INTO transactions (household_id, id, account_id, amount_minor, currency, authorized_date, posted_date,
           original_description, display_name, source)
         VALUES ($1, gen_random_uuid(), $2, -4200, 'USD', '2026-07-30', '2026-07-31', 'LATE NIGHT PIZZA', 'Pizza', 'import')
         RETURNING id`,
        [hh, acct],
      );
      const id = row.id;
      const get = async () => (await A.get(url(`/transactions/${id}`))).body.data;
      const move = async (date: string | null) =>
        A.request(
          'PATCH',
          url(`/transactions/${id}`),
          { date },
          { headers: { 'if-match': `"v${(await get()).version}"` } },
        );
      expect((await move('2026-07-29')).status).toBe(200);
      expect(await get()).toMatchObject({
        date: '2026-07-29',
        reportedDate: '2026-07-31',
        dateEdited: true,
      });
      // The bank's amount stays the bank's.
      const amount = await A.request(
        'PATCH',
        url(`/transactions/${id}`),
        { amountMinor: -1 },
        {
          headers: { 'if-match': `"v${(await get()).version}"` },
        },
      );
      expect(amount.body.code).toBe('not_editable');
      expect((await move(null)).status).toBe(200);
      expect(await get()).toMatchObject({ date: '2026-07-31', dateEdited: false });
    });
  });
});
