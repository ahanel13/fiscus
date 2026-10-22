// SPDX-License-Identifier: AGPL-3.0-or-later
import { createDb, type DbHandle, systemContext, withContext } from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { ProviderBalance, ProviderLiability } from '@fiscus/domain';
import { writeProviderBalances, writeProviderLiabilities } from '@fiscus/ledger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Provider balances and card details (#86): what a sync writes, through `@fiscus/ledger` as the
 * worker calls it (#80), and what the api shows of it. Who sees card details across members is in
 * the cross-member suite.
 */
describe('provider balances and card details', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client;
  let worker: DbHandle;
  let A: TestClient;
  let hh: string;
  let memberA: string;
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const sql = async (text: string, params: unknown[] = []) =>
    (await owner.query(text, params)).rows;

  const account = async (body: Record<string, unknown>) => {
    const r = await A.post(url('/accounts'), { name: 'Acct', type: 'depository', ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const txn = async (accountId: string, date: string, amountMinor: number) => {
    const r = await A.post(url('/transactions'), {
      accountId,
      date,
      amountMinor,
      displayName: 'Item',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  const history = async (accountId: string) =>
    Object.fromEntries(
      (await A.get(url(`/accounts/${accountId}/balances?from=2025-01-01`))).body.data.map(
        (b: { asOf: string; amountMinor: number; source: string }) => [
          b.asOf,
          `${b.amountMinor} ${b.source}`,
        ],
      ),
    );
  /** A connection, with the accounts linked to it under the given provider account ids. */
  const connect = async (links: Record<string, string>) => {
    const id = crypto.randomUUID();
    await sql(
      `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status)
       VALUES ($1, $2, $3, 'plaid', $4, 'ok')`,
      [id, hh, memberA, `item-${id}`],
    );
    for (const [providerAccountId, accountId] of Object.entries(links)) {
      await sql('UPDATE accounts SET connection_id = $1, provider_account_id = $2 WHERE id = $3', [
        id,
        providerAccountId,
        accountId,
      ]);
    }
    return id;
  };
  const balance = (fields: Partial<ProviderBalance> & { asOf: string }): ProviderBalance => ({
    providerAccountId: 'acc-1',
    currency: 'USD',
    currentMinor: 0,
    ...fields,
  });
  /** As the worker: system context, logged in as fiscus_worker. */
  const sync = (fn: Parameters<typeof withContext>[2]) =>
    withContext(worker.db, systemContext(hh), fn);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    worker = createDb(tdb.workerUrl, { max: 1 });
    A = new TestClient(app);
    await A.post('/api/v1/auth/signup', {
      email: 'ada@balances.test',
      password: 'balances test Password1!',
      displayName: 'Ada',
    });
    // West of UTC, so a balance reported early in the UTC day is the household's day before.
    const h = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'America/Los_Angeles',
      })
    ).body.data;
    hh = h.id;
    memberA = h.you.memberId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await worker?.close();
    await owner?.end();
    await tdb?.stop();
  });

  it('keeps an account’s history from before it was linked (D5)', async () => {
    const acct = await account({ name: 'Imported checking' });
    await txn(acct, '2026-03-01', 50_000);
    await txn(acct, '2026-03-05', -2_000);
    await txn(acct, '2026-03-09', -1_000);
    const before = { '2026-03-01': '50000 computed', '2026-03-05': '48000 computed' };
    expect(await history(acct)).toEqual({ ...before, '2026-03-09': '47000 computed' });

    const connection = await connect({ 'acc-1': acct });
    await sync((tx) =>
      writeProviderBalances(tx, connection, [
        balance({ currentMinor: 46_500, asOf: '2026-03-09T20:00:00Z' }),
      ]),
    );
    // The bank's balance wins from its day on; everything before stays as it was.
    expect(await history(acct)).toEqual({ ...before, '2026-03-09': '46500 provider' });

    // Editing it later (here, a transaction recorded by hand) recomputes, and still keeps it.
    // Transactions after the bank's balance don't move it: it carries forward until the next sync.
    await txn(acct, '2026-03-03', -500);
    await txn(acct, '2026-03-12', -700);
    expect(await history(acct)).toEqual({
      '2026-03-01': '50000 computed',
      '2026-03-03': '49500 computed',
      '2026-03-05': '47500 computed',
      '2026-03-09': '46500 provider',
    });

    // Synced transactions before the first reported balance don't rewrite the history either.
    await sql(
      `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, posted_date,
         authorized_date, original_description, display_name, source, provider_transaction_id)
       VALUES (gen_random_uuid(), $1, $2, -9999, 'USD', '2026-03-07', '2026-03-07', 'Overlap', 'Overlap', 'provider', 'p-1')`,
      [hh, acct],
    );
    await txn(acct, '2026-03-02', 1);
    expect((await history(acct))['2026-03-05']).toBe('47501 computed');
    expect((await history(acct))['2026-03-07']).toBeUndefined();

    // Disconnected, it follows its transactions again, from the bank's last balance (D14).
    await sql('UPDATE accounts SET connection_id = NULL WHERE id = $1', [acct]);
    await txn(acct, '2026-03-14', -300);
    expect(await history(acct)).toMatchObject({
      '2026-03-09': '46500 provider',
      '2026-03-12': '45800 computed',
      '2026-03-14': '45500 computed',
    });
  });

  it('writes one balance per account per day, in the household’s time zone', async () => {
    const card = await account({ name: 'Visa', type: 'credit' });
    const other = await account({ name: 'Not linked' });
    const connection = await connect({ 'card-1': card });
    const first = await sync((tx) =>
      writeProviderBalances(tx, connection, [
        // 05:00 UTC on the 20th is 22:00 on the 19th in Los Angeles.
        balance({
          providerAccountId: 'card-1',
          currentMinor: -120_000,
          availableMinor: 380_000,
          creditLimitMinor: 500_000,
          asOf: '2026-10-20T05:00:00Z',
        }),
        // Not tracked here, or in another currency: left out.
        balance({ providerAccountId: 'unknown', currentMinor: 1, asOf: '2026-10-19' }),
        balance({
          providerAccountId: 'card-1',
          currency: 'EUR',
          currentMinor: 1,
          asOf: '2026-10-19',
        }),
      ]),
    );
    expect(first).toEqual({ written: 1, skipped: 2 });
    const points = async () =>
      (await A.get(url(`/accounts/${card}/balances?from=2026-10-01`))).body.data;
    expect(await points()).toEqual([
      {
        asOf: '2026-10-19',
        amountMinor: -120_000,
        availableMinor: 380_000,
        creditLimitMinor: 500_000,
        source: 'provider',
      },
    ]);
    // A later sync that day replaces it, including what it no longer reports.
    await sync((tx) =>
      writeProviderBalances(tx, connection, [
        balance({
          providerAccountId: 'card-1',
          currentMinor: -125_000,
          asOf: '2026-10-19T23:00:00-07:00',
        }),
      ]),
    );
    expect(await points()).toEqual([
      {
        asOf: '2026-10-19',
        amountMinor: -125_000,
        availableMinor: null,
        creditLimitMinor: null,
        source: 'provider',
      },
    ]);
    // A date with no time is the household's day as it is; nothing is dated after today.
    await sync((tx) =>
      writeProviderBalances(tx, connection, [
        balance({ providerAccountId: 'card-1', currentMinor: -126_000, asOf: '2026-10-20' }),
        balance({
          providerAccountId: 'card-1',
          currentMinor: -127_000,
          asOf: '2999-01-01T00:00:00Z',
        }),
      ]),
    );
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
      new Date(),
    );
    expect((await points()).map((p: { asOf: string }) => p.asOf)).toEqual(
      [...new Set(['2026-10-19', '2026-10-20', today])].sort(),
    );
    expect((await points()).at(-1).amountMinor).toBe(-127_000);
    expect(await history(other)).toEqual({});
  });

  it('counts the bank’s balance in net worth, carried forward like any other (ADR 0011)', async () => {
    const savings = await account({ name: 'Savings', includeInNetWorth: true });
    const connection = await connect({ 'sav-1': savings });
    const worth = async () =>
      (await A.get(url('/net-worth?lens=all&from=2026-01-01&to=2026-01-31'))).body.data;
    const before = await worth();
    await sync((tx) =>
      writeProviderBalances(tx, connection, [
        balance({ providerAccountId: 'sav-1', currentMinor: 1_000_000, asOf: '2026-01-10' }),
      ]),
    );
    const after = await worth();
    const at = (w: { series: { date: string; netWorthMinor: number }[] }, date: string) =>
      w.series.find((p) => p.date === date)!.netWorthMinor;
    expect(at(after, '2026-01-09') - at(before, '2026-01-09')).toBe(0);
    expect(at(after, '2026-01-10') - at(before, '2026-01-10')).toBe(1_000_000);
    expect(at(after, '2026-01-31') - at(before, '2026-01-31')).toBe(1_000_000);
  });

  it('dates a connected account’s balance by the bank’s last report (D12)', async () => {
    const acct = await account({ name: 'Broken checking' });
    const connection = await connect({ 'chk-1': acct });
    await sync((tx) =>
      writeProviderBalances(tx, connection, [
        balance({ providerAccountId: 'chk-1', currentMinor: 75_000, asOf: '2026-09-18' }),
      ]),
    );
    // The connection breaks; a balance entered by hand later doesn't make it look fresh.
    await sql(`UPDATE connections SET status = 'login_required' WHERE id = $1`, [connection]);
    expect(
      (
        await A.request('PUT', url(`/accounts/${acct}/balances/2026-10-01`), {
          amountMinor: 80_000,
        })
      ).status,
    ).toBe(200);
    const shown = async () => (await A.get(url(`/accounts/${acct}`))).body.data.balance;
    expect(await shown()).toEqual({ amountMinor: 75_000, asOf: '2026-09-18' });
    const listed = (await A.get(url('/accounts'))).body.data.find(
      (a: { id: string }) => a.id === acct,
    );
    expect(listed.balance).toEqual({ amountMinor: 75_000, asOf: '2026-09-18' });
    // Once it's not connected, the latest balance is the latest of any kind.
    await sql('UPDATE accounts SET connection_id = NULL WHERE id = $1', [acct]);
    expect(await shown()).toEqual({ amountMinor: 80_000, asOf: '2026-10-01' });
  });

  describe('card details', () => {
    const liability = (fields: Partial<ProviderLiability>): ProviderLiability => ({
      providerAccountId: 'visa-1',
      kind: 'credit',
      currency: 'USD',
      ...fields,
    });

    it('stores them for credit and loan accounts, and replaces them on the next sync', async () => {
      const visa = await account({ name: 'Visa', type: 'credit' });
      const loan = await account({ name: 'Car loan', type: 'loan' });
      const checking = await account({ name: 'Checking' });
      const connection = await connect({ 'visa-1': visa, 'loan-1': loan, 'chk-2': checking });
      const result = await sync((tx) =>
        writeProviderLiabilities(tx, connection, [
          liability({
            aprBps: 2149,
            lastStatementBalanceMinor: -142_310,
            lastStatementDate: '2026-09-28',
            minimumPaymentMinor: 3_500,
            nextPaymentDueDate: '2026-10-25',
          }),
          liability({ providerAccountId: 'loan-1', kind: 'student', aprBps: 549 }),
          liability({ providerAccountId: 'chk-2', aprBps: 1 }),
          liability({ providerAccountId: 'nobody', aprBps: 1 }),
        ]),
      );
      expect(result).toEqual({ written: 2, skipped: 2 });
      const details = async (id: string) =>
        (await A.get(url(`/accounts/${id}`))).body.data.liabilities;
      expect(await details(visa)).toEqual({
        aprBps: 2149,
        minimumPaymentMinor: 3_500,
        nextDueDate: '2026-10-25',
        lastStatementBalanceMinor: -142_310,
        lastStatementDate: '2026-09-28',
        updatedAt: expect.any(String),
      });
      expect(await details(loan)).toMatchObject({ aprBps: 549, nextDueDate: null });
      // None reported (as with SimpleFIN): null, without error.
      expect(await details(checking)).toBeNull();

      await sync((tx) => writeProviderLiabilities(tx, connection, [liability({ aprBps: 2299 })]));
      expect(await details(visa)).toMatchObject({ aprBps: 2299, minimumPaymentMinor: null });
    });
  });
});
