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
        password: 'transfers test Password1!',
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
    // A week apart: outside the window, which is 3 business days.
    await txn(A, a1, -900, `${m}-15`);
    expect((await get(A, await txn(A, a2, 900, `${m}-22`))).transfer).toBeNull();
    // The same account.
    await txn(A, a1, -1000, `${m}-20`);
    expect((await get(A, await txn(A, a1, 1000, `${m}-20`))).transfer).toBeNull();
  });

  it('counts business days: Friday to Wednesday links, a week apart doesn’t', async () => {
    const m = month();
    const friday = [...Array(7).keys()]
      .map((d) => `${m}-${String(d + 1).padStart(2, '0')}`)
      .find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 5)!;
    const plus = (days: number) =>
      new Date(Date.parse(friday) + days * 86_400_000).toISOString().slice(0, 10);
    const a1 = await account(A, 'Bank one');
    const a2 = await account(A, 'Bank two');
    const out = await txn(A, a1, -6100, friday);
    const into = await txn(A, a2, 6100, plus(5)); // Wednesday
    expect((await get(A, out)).transfer?.transactionId).toBe(into);
    await txn(A, a1, -6200, friday);
    expect((await get(A, await txn(A, a2, 6200, plus(6)))).transfer).toBeNull(); // Thursday
  });

  it('reviews transfers: suggested pairs, link all, and ones with no other side', async () => {
    // A household of its own: the review covers all of its history.
    const home = (
      await A.post('/api/v1/households', { name: 'Review', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id as string;
    const base = `/api/v1/households/${home}`;
    const acct = async (name: string) =>
      (await A.post(`${base}/accounts`, { name, type: 'depository' })).body.data.id as string;
    const groups = (await A.get(`${base}/categories`)).body.data as CategoryGroup[];
    const transfer = groups
      .flatMap((g) => g.categories)
      .find((c) => c.systemKey === 'transfer')!.id;
    const add = async (accountId: string, amountMinor: number, date: string, transferCat = false) =>
      (
        await A.post(`${base}/transactions`, {
          accountId,
          amountMinor,
          date,
          displayName: 'Move',
          ...(transferCat ? { categoryId: transfer } : {}),
        })
      ).body.data.id as string;
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const checking = await acct('Checking');
    const savings = await acct('Savings');
    const card = await acct('Card');

    // Two possible other sides: suggested, not unique. (Ins first, so entry doesn't link them.)
    const s1 = await add(savings, 50000, day(-40));
    const c1 = await add(card, 50000, day(-40));
    const out1 = await add(checking, -50000, day(-41), true);
    // Eight days apart: past auto-linking, suggested and unique.
    const s2 = await add(savings, 70000, day(-22));
    const out2 = await add(checking, -70000, day(-30), true);
    // Nothing on the other side, a month old: unmatched. Two days old: maybe in transit.
    const lonely = await add(checking, -90000, day(-30), true);
    await add(checking, -95000, day(-2), true);

    const review = (await A.get(`${base}/transactions/transfer-review`)).body.data as {
      suggested: { transaction: Transaction; candidates: Transaction[]; unique: boolean }[];
      unmatched: Transaction[];
      counts: Record<string, number>;
    };
    expect(
      review.suggested.map((x) => [
        x.transaction.id,
        x.candidates.map((c) => c.id).sort(),
        x.unique,
      ]),
    ).toEqual([
      [out2, [s2], true],
      [out1, [s1, c1].sort(), false],
    ]);
    expect(review.unmatched.map((t) => t.id)).toEqual([lonely]);
    expect((await A.get(`${base}/transactions/review-count`)).body.data.transfers).toBe(3);

    const linked = await A.post(`${base}/transactions/transfer-review/link-all`);
    expect(linked.body.data).toEqual({ linked: 1 });
    expect(
      ((await A.get(`${base}/transactions/${out2}`)).body.data as Transaction).transfer
        ?.transactionId,
    ).toBe(s2);

    // "The other account isn't in Fiscus": not asked again.
    const v = (await A.get(`${base}/transactions/${lonely}`)).body.data.version as number;
    await A.request(
      'PATCH',
      `${base}/transactions/${lonely}`,
      { transferExternal: true },
      { headers: { 'if-match': `"v${v}"` } },
    );
    const after = (await A.get(`${base}/transactions/transfer-review`)).body.data;
    expect(after.unmatched).toEqual([]);
    expect(after.counts).toEqual({ suggested: 1, unmatched: 0, unique: 0 });
  });

  it('a "transfer to" rule records the other side, links further apart, and waits for it', async () => {
    const home = (
      await A.post('/api/v1/households', { name: 'Rules', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id as string;
    const base = `/api/v1/households/${home}`;
    const acct = async (name: string, extra: Record<string, unknown> = {}) =>
      (await A.post(`${base}/accounts`, { name, type: 'depository', ...extra })).body.data
        .id as string;
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const one = async (id: string) =>
      (await A.get(`${base}/transactions/${id}`)).body.data as Transaction;
    const importRows = async (accountId: string, rows: Record<string, unknown>[]) => {
      const start = await A.post(`${base}/imports`, {
        format: 'csv',
        filename: 'rules.csv',
        accounts: [{ key: 'file', accountId }],
      });
      const batchId = start.body.data.batches[0].batchId as string;
      const r = await A.post(`${base}/imports/${batchId}/rows`, {
        transactions: rows.map((row, i) => ({ line: i + 2, ...row })),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const list = (await A.get(`${base}/transactions?accounts=${accountId}&range=all_time`)).body
        .data as Transaction[];
      return { batchId, list };
    };
    const rule = (description: string, transferTo: Record<string, unknown>) =>
      A.post(`${base}/rules`, {
        conditions: { description: { op: 'contains', value: description }, direction: 'out' },
        actions: { transferTo },
      });
    const checking = await acct('Checking');
    const loan = await acct('Student loan', { type: 'loan' });
    const savings = await acct('Savings');
    const ally = await acct('Ally');

    // Recorded in the manual loan account, linked, and undone with its import.
    expect(
      (await rule('mohela', { accountId: loan, withinDays: 5, recordIfMissing: true })).status,
    ).toBe(201);
    const mohela = await importRows(checking, [
      { date: day(-20), amountMinor: -30000, description: 'MOHELA PAYMENT' },
    ]);
    const paid = mohela.list.find((t) => t.originalDescription === 'MOHELA PAYMENT')!;
    expect(paid.transfer?.account?.name).toBe('Student loan');
    const onLoan = await one(paid.transfer!.transactionId!);
    expect([onLoan.amountMinor, onLoan.date, onLoan.account?.id]).toEqual([30000, day(-20), loan]);
    await A.post(`${base}/imports/${mohela.batchId}/revert`);
    expect((await A.get(`${base}/transactions/${onLoan.id}`)).status).toBe(404);

    // Eight days apart, beyond the usual window: the rule's 10 days link it.
    const arrived = await A.post(`${base}/transactions`, {
      accountId: savings,
      amountMinor: 5000,
      date: day(-30),
      displayName: 'Deposit',
    });
    expect((await rule('vanguard', { accountId: savings, withinDays: 10 })).status).toBe(201);
    const vg = await importRows(checking, [
      { date: day(-38), amountMinor: -5000, description: 'VANGUARD XFER' },
    ]);
    const out = vg.list.find((t) => t.originalDescription === 'VANGUARD XFER')!;
    expect(out.transfer?.transactionId).toBe(arrived.body.data.id);

    // Not there yet: it waits, out of spending, and links when the other side lands.
    expect((await rule('ally', { accountId: ally, withinDays: 10 })).status).toBe(201);
    const al = await importRows(checking, [
      { date: day(-2), amountMinor: -6000, description: 'ALLY BANK XFER' },
    ]);
    const waiting = al.list.find((t) => t.originalDescription === 'ALLY BANK XFER')!;
    expect(waiting.transfer).toBeNull();
    const groups = (await A.get(`${base}/categories`)).body.data as CategoryGroup[];
    const transferCat = groups
      .flatMap((g) => g.categories)
      .find((c) => c.systemKey === 'transfer')!;
    expect(waiting.categoryId).toBe(transferCat.id);
    const landed = await A.post(`${base}/transactions`, {
      accountId: ally,
      amountMinor: 6000,
      date: day(0),
      displayName: 'From checking',
      categoryId: groups.flatMap((g) => g.categories).find((c) => c.name === 'Groceries')!.id,
    });
    expect((await one(waiting.id)).transfer?.transactionId).toBe(landed.body.data.id);

    // A rule's transfer goes to an account you own, and records only into one that can take it.
    const valued = await acct('House', { type: 'property', balanceMode: 'value' });
    expect(
      (await rule('x', { accountId: valued, withinDays: 5, recordIfMissing: true })).body.code,
    ).toBe('cannot_record');
    const beas = (await B.post(url('/accounts'), { name: 'Bea’s', type: 'depository' })).body.data
      .id as string;
    const refused = await A.post(url('/rules'), {
      conditions: { direction: 'out' },
      actions: { transferTo: { accountId: beas } },
    });
    expect(refused.body.code).toBe('invalid_account');
  });

  it('pairs identical transfers in step (round-ups), on arrival and in the review', async () => {
    const home = (
      await A.post('/api/v1/households', { name: 'Vaults', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id as string;
    const base = `/api/v1/households/${home}`;
    const acct = async (name: string) =>
      (await A.post(`${base}/accounts`, { name, type: 'depository' })).body.data.id as string;
    const add = async (accountId: string, amountMinor: number, date: string) =>
      (
        await A.post(`${base}/transactions`, {
          accountId,
          amountMinor,
          date,
          displayName: 'Round Up Transfer',
        })
      ).body.data.id as string;
    const one = async (id: string) =>
      (await A.get(`${base}/transactions/${id}`)).body.data as Transaction;
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const checking = await acct('Checking');
    const vault = await acct('Vacation');

    // Two round-ups out, then two in, the same day: once the second lands, both pairs link.
    const outs = [await add(checking, -75, day(-30)), await add(checking, -75, day(-30))];
    const firstIn = await add(vault, 75, day(-30));
    expect((await one(firstIn)).transfer).toBeNull(); // one in, two out: not yet
    const secondIn = await add(vault, 75, day(-30));
    const linked = await Promise.all([...outs, firstIn, secondIn].map(one));
    expect(linked.every((t) => t.transfer !== null)).toBe(true);
    expect(new Set(linked.slice(0, 2).map((t) => t.transfer!.transactionId))).toEqual(
      new Set([firstIn, secondIn]),
    );

    // Six days apart (past automatic linking): the review suggests them as identical, and
    // "Link all" pairs them. Three out and two in stays for a person.
    const lateOuts = [await add(checking, -40, day(-20)), await add(checking, -40, day(-20))];
    await add(vault, 40, day(-14));
    await add(vault, 40, day(-14));
    const groups = (await A.get(`${base}/categories`)).body.data as CategoryGroup[];
    const transferCat = groups
      .flatMap((g) => g.categories)
      .find((c) => c.systemKey === 'transfer')!;
    for (const id of lateOuts) {
      const v = (await one(id)).version;
      await A.request(
        'PATCH',
        `${base}/transactions/${id}`,
        { categoryId: transferCat.id },
        { headers: { 'if-match': `"v${v}"` } },
      );
    }
    const review = (await A.get(`${base}/transactions/transfer-review`)).body.data as {
      suggested: { transaction: Transaction; reason: string; unique: boolean }[];
    };
    expect(
      review.suggested
        .filter((x) => lateOuts.includes(x.transaction.id))
        .map((x) => [x.reason, x.unique]),
    ).toEqual([
      ['identical', true],
      ['identical', true],
    ]);
    expect((await A.post(`${base}/transactions/transfer-review/link-all`)).body.data).toEqual({
      linked: 2,
    });
    expect((await Promise.all(lateOuts.map(one))).every((t) => t.transfer !== null)).toBe(true);
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

  it('linking one of two possible pairs by hand links the other, now clear', async () => {
    const m = month();
    const checking = await account(A, 'Settle checking');
    const travel = await account(A, 'Settle travel');
    const house = await account(A, 'Settle house');
    const t = { categoryId: transferCat };
    // $500 into the roof vault twice, one from each: either deposit could be either one's.
    const fromTravel = await txn(A, travel, -50000, `${m}-03`, t);
    const fromChecking = await txn(A, checking, -50000, `${m}-03`, t);
    const in1 = await txn(A, house, 50000, `${m}-03`, t);
    const in2 = await txn(A, house, 50000, `${m}-03`, t);
    expect((await get(A, in1)).transfer).toBeNull();

    const r = await A.post(url(`/transactions/${fromTravel}/transfer`), { transactionId: in1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await get(A, fromChecking)).transfer?.transactionId).toBe(in2);
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
    // The preview names the transfer it will link, reading only.
    const preview = await A.post(url('/imports/preview'), {
      format: 'csv',
      filename: 'checking.csv',
      accounts: [{ key: 'file', accountId: checking }],
      transactions: [
        {
          line: 2,
          account: 'file',
          date: `${m}-13`,
          amountMinor: -30000,
          description: 'CARD PAYMENT',
        },
        { line: 3, account: 'file', date: `${m}-13`, amountMinor: -1234, description: 'COFFEE' },
      ],
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.transfers).toEqual([
      {
        line: 2,
        account: 'file',
        date: `${m}-13`,
        amountMinor: -30000,
        other: { line: null, accountName: 'Card', date: `${m}-14` },
      },
    ]);
    expect(preview.body.data.totals.transfers).toBe(1);
    expect((await get(A, payment)).transfer).toBeNull();
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

  it('previews transfers within a file between two new accounts, from the money-out side', async () => {
    const m = month();
    const r = await A.post(url('/imports/preview'), {
      format: 'monarch',
      filename: 'Transactions.csv',
      accounts: [
        { key: 'Joint', create: { name: 'Joint', type: 'depository' } },
        { key: 'Vacation fund', create: { name: 'Vacation fund', type: 'depository' } },
      ],
      transactions: [
        {
          line: 2,
          account: 'Vacation fund',
          date: `${m}-02`,
          amountMinor: 20000,
          description: 'From joint',
          category: 'Transfer',
        },
        {
          line: 3,
          account: 'Joint',
          date: `${m}-01`,
          amountMinor: -20000,
          description: 'To vacation',
          category: 'Transfer',
        },
        // Groceries and a refund of the same amount: not a transfer.
        {
          line: 4,
          account: 'Joint',
          date: `${m}-05`,
          amountMinor: -4000,
          description: 'Store',
          category: 'Groceries',
        },
        {
          line: 5,
          account: 'Vacation fund',
          date: `${m}-05`,
          amountMinor: 4000,
          description: 'Refund',
          category: 'Groceries',
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.transfers).toEqual([
      {
        line: 3,
        account: 'Joint',
        date: `${m}-01`,
        amountMinor: -20000,
        other: { line: 2, accountName: 'Vacation fund', date: `${m}-02` },
      },
    ]);
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
      password: 'transfers test Password1!',
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
      transactions: 3,
      transfers: 0,
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
