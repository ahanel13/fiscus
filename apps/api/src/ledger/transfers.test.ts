// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { CategoryGroup, Transaction } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Transfers between accounts (#40, imports.md §5) and the review queue (#44). */
describe('transfers and the review queue', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  let bea = '';
  let transferCat = '';
  let groceries = '';
  let day = 0;
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const account = async (c: TestClient, name: string, visibility = 'full') =>
    (await c.post(url('/accounts'), { name, type: 'depository', visibility })).body.data
      .id as string;
  /** Each scenario gets its own month, so detection never pairs across scenarios. */
  const month = () => `2026-${String(++day).padStart(2, '0')}`;
  const txn = async (
    c: TestClient,
    accountId: string,
    amountMinor: number,
    date: string,
    extra: Record<string, unknown> = {},
  ) => {
    const r = await c.post(url('/transactions'), {
      accountId,
      date,
      amountMinor,
      displayName: 'Move money',
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const get = async (c: TestClient, id: string) =>
    (await c.get(url(`/transactions/${id}`))).body.data as Transaction;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@transfers.test`,
        password: 'transfers test password',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    hh = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
    const invite = await A.post(url('/invites'), { email: 'bea@transfers.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    bea = ((await A.get(url('/members'))).body.data as { id: string; isYou: boolean }[]).find(
      (m) => !m.isYou,
    )!.id;
    const groups = (await A.get(url('/categories'))).body.data as CategoryGroup[];
    const all = groups.flatMap((g) => g.categories);
    transferCat = all.find((c) => c.systemKey === 'transfer')!.id;
    groceries = all.find((c) => c.name === 'Groceries')!.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('links an unambiguous pair on entry, and cash flow leaves it out', async () => {
    const m = month();
    const checking = await account(A, 'Checking');
    const savings = await account(A, 'Savings');
    const out = await txn(A, checking, -50000, `${m}-10`);
    const into = await txn(A, savings, 50000, `${m}-12`);
    const [o, i] = [await get(A, out), await get(A, into)];
    expect(o.categoryId).toBe(transferCat);
    expect(i.categoryId).toBe(transferCat);
    expect(o.transfer).toEqual({
      transactionId: into,
      account: { id: savings, name: 'Savings', mask: null },
      ownerIds: [expect.any(String)],
    });
    expect(i.transfer?.transactionId).toBe(out);

    const flow = await A.get(url(`/cash-flow?range=custom&from=${m}-01&to=${m}-28`));
    expect(flow.body.data.totals).toEqual({ incomeMinor: 0, spendingMinor: 0, netMinor: 0 });
  });

  it('leaves ambiguous, categorized, distant, and same-account pairs alone', async () => {
    const m = month();
    const a1 = await account(A, 'A1');
    const a2 = await account(A, 'A2');
    const a3 = await account(A, 'A3');
    // Two possible other legs: none is linked.
    await txn(A, a2, 7000, `${m}-05`);
    await txn(A, a3, 7000, `${m}-06`);
    const out = await txn(A, a1, -7000, `${m}-05`);
    expect((await get(A, out)).transfer).toBeNull();
    // Filed under Groceries: a refund, not a transfer.
    await txn(A, a1, -800, `${m}-10`);
    const refund = await txn(A, a2, 800, `${m}-10`, { categoryId: groceries });
    expect((await get(A, refund)).transfer).toBeNull();
    // Four days apart: outside the window.
    await txn(A, a1, -900, `${m}-15`);
    expect((await get(A, await txn(A, a2, 900, `${m}-19`))).transfer).toBeNull();
    // The same account.
    await txn(A, a1, -1000, `${m}-20`);
    expect((await get(A, await txn(A, a1, 1000, `${m}-20`))).transfer).toBeNull();
  });

  it('links by hand, refuses what isn’t a transfer, and unlinking restores categories', async () => {
    const m = month();
    const a1 = await account(A, 'Hand 1');
    const a2 = await account(A, 'Hand 2');
    const a3 = await account(A, 'Hand 3');
    const out = await txn(A, a1, -2500, `${m}-01`, { categoryId: groceries });
    const into = await txn(A, a2, 2500, `${m}-08`);
    const other = await txn(A, a3, 2500, `${m}-09`);

    const cands = await A.get(url(`/transactions/${out}/transfer-candidates`));
    expect(cands.body.data.map((t: Transaction) => t.id)).toEqual([into, other]);

    const same = await txn(A, a1, 2500, `${m}-02`, { categoryId: groceries });
    expect(
      (await A.post(url(`/transactions/${out}/transfer`), { transactionId: same })).body.code,
    ).toBe('same_account');
    const odd = await txn(A, a2, 2400, `${m}-02`, { categoryId: groceries });
    expect(
      (await A.post(url(`/transactions/${out}/transfer`), { transactionId: odd })).body.code,
    ).toBe('not_opposite');

    const r = await A.post(url(`/transactions/${out}/transfer`), { transactionId: into });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.transfer.transactionId).toBe(into);
    expect(r.body.data.categoryId).toBe(transferCat);
    expect(
      (await A.post(url(`/transactions/${other}/transfer`), { transactionId: out })).body.code,
    ).toBe('already_linked');
    // Splitting a linked leg would orphan it.
    const split = await A.request('PUT', url(`/transactions/${out}/splits`), {
      parts: [{ amountMinor: -1000 }, { amountMinor: -1500 }],
    });
    expect(split.body.code).toBe('transfer');

    const del = await A.request('DELETE', url(`/transactions/${into}/transfer`));
    expect(del.status).toBe(204);
    const [o, i] = [await get(A, out), await get(A, into)];
    expect([o.transfer, i.transfer]).toEqual([null, null]);
    expect(o.categoryId).toBe(groceries); // as before
    expect(i.categoryId).toBeNull(); // uncategorized, as before
  });

  it('deleting one leg leaves the other a plain transaction again', async () => {
    const m = month();
    const a1 = await account(A, 'Del 1');
    const a2 = await account(A, 'Del 2');
    const out = await txn(A, a1, -4200, `${m}-03`);
    const into = await txn(A, a2, 4200, `${m}-03`);
    expect((await get(A, into)).transfer).not.toBeNull();
    await A.request('DELETE', url(`/transactions/${out}`));
    const i = await get(A, into);
    expect(i.transfer).toBeNull();
    expect(i.categoryId).toBeNull();
  });

  it('imports link transfers to existing transactions, and undo unlinks them', async () => {
    const m = month();
    const card = await account(A, 'Card');
    const checking = await account(A, 'Import checking');
    const payment = await txn(A, card, 30000, `${m}-14`);
    const start = await A.post(url('/imports'), {
      format: 'csv',
      filename: 'checking.csv',
      accounts: [{ key: 'file', accountId: checking }],
    });
    const batchId = start.body.data.batches[0].batchId as string;
    const rows = await A.post(url(`/imports/${batchId}/rows`), {
      transactions: [
        { line: 2, date: `${m}-13`, amountMinor: -30000, description: 'CARD PAYMENT' },
        { line: 3, date: `${m}-13`, amountMinor: -1234, description: 'COFFEE' },
      ],
    });
    expect(rows.status, JSON.stringify(rows.body)).toBe(200);
    expect(rows.body.data.transfersLinked).toBe(1);
    expect((await get(A, payment)).transfer?.account?.id).toBe(checking);

    await A.post(url(`/imports/${batchId}/revert`));
    expect((await get(A, payment)).transfer).toBeNull();
  });

  it('shows the other side of a transfer into a private account as its owner, not the account (F1)', async () => {
    const m = month();
    const shared = await account(B, 'Bea checking');
    const hidden = await account(B, 'Bea private savings', 'private');
    const out = await txn(B, shared, -12000, `${m}-20`);
    await txn(B, hidden, 12000, `${m}-20`);
    // Bea sees both sides.
    expect((await get(B, out)).transfer?.account?.name).toBe('Bea private savings');
    // Ada sees the checking side and who's on the other end, not the account or transaction.
    const seen = await get(A, out);
    expect(seen.transfer).toEqual({ transactionId: null, account: null, ownerIds: [bea] });
    expect(JSON.stringify(seen)).not.toContain('private savings');
    // And can't unlink it: she owns neither side.
    expect((await A.request('DELETE', url(`/transactions/${out}/transfer`))).status).toBe(403);
  });

  it('counts the review queue and lists it oldest first', async () => {
    const reviewer = new TestClient(app);
    await reviewer.post('/api/v1/auth/signup', {
      email: 'rev@transfers.test',
      password: 'transfers test password',
      displayName: 'Rev',
    });
    const home = (
      await reviewer.post('/api/v1/households', {
        name: 'Queue',
        baseCurrency: 'USD',
        timezone: 'UTC',
      })
    ).body.data.id as string;
    const base = `/api/v1/households/${home}`;
    const acct = (await reviewer.post(`${base}/accounts`, { name: 'Q', type: 'depository' })).body
      .data.id as string;
    const start = await reviewer.post(`${base}/imports`, {
      format: 'csv',
      filename: 'q.csv',
      accounts: [{ key: 'file', accountId: acct }],
    });
    await reviewer.post(`${base}/imports/${start.body.data.batches[0].batchId}/rows`, {
      transactions: [
        { line: 2, date: '2026-05-02', amountMinor: -100, description: 'SECOND' },
        { line: 3, date: '2026-05-01', amountMinor: -200, description: 'FIRST' },
        { line: 4, date: '2026-05-03', amountMinor: -300, description: 'THIRD' },
      ],
    });
    expect((await reviewer.get(`${base}/transactions/review-count`)).body.data).toEqual({
      count: 3,
    });
    const page = await reviewer.get(
      `${base}/transactions?review=needs_review&order=oldest&limit=2`,
    );
    expect(page.body.data.map((t: Transaction) => t.displayName)).toEqual(['FIRST', 'SECOND']);
    const next = await reviewer.get(
      `${base}/transactions?review=needs_review&order=oldest&limit=2&cursor=${page.body.meta.nextCursor}`,
    );
    expect(next.body.data.map((t: Transaction) => t.displayName)).toEqual(['THIRD']);

    await reviewer.request('PATCH', `${base}/transactions`, {
      ids: [page.body.data[0].id],
      changes: { reviewStatus: 'reviewed' },
    });
    expect((await reviewer.get(`${base}/transactions/review-count`)).body.data.count).toBe(2);
  });
});
