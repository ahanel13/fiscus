// SPDX-License-Identifier: AGPL-3.0-or-later
import { plaidProviderSource, ProviderRegistry } from '@fiscus/aggregation';
import {
  type ConformanceScenario,
  type FakePlaid,
  RIVERA,
  riveraScenario,
  startFakePlaid,
} from '@fiscus/aggregation/testing';
import { randomUUID } from 'node:crypto';
import { savePlaidKeySet, systemContext, withContext } from '@fiscus/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_JOB_HANDLERS } from '../runner/handlers.js';
import { JobHandlers } from '../runner/jobs.js';
import { Runner } from '../runner/runner.js';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';

/**
 * A confirmed Plaid connection, synced end to end by the runner through the Plaid adapter (#82)
 * against the fake Plaid server: Plaid's format and sign in, Fiscus's ledger out, with the keys
 * the connection was made with.
 */

const COFFEE_PENDING = 'txn-coffee-1005-pending';
const COFFEE = 'txn-coffee-1005';

/**
 * The Riveras' bank, with the coffee's posting split over two pages of one sync: the posted
 * transaction on the first, the pending one's removal on the second (TXN-004).
 */
function splitPostingScenario(): ConformanceScenario {
  const scenario = riveraScenario();
  const [page] = scenario.updates[1]!;
  scenario.updates[1] = [
    { added: page!.added ?? [], modified: page!.modified ?? [] },
    { removed: page!.removed ?? [], historicalComplete: true },
  ];
  return scenario;
}

/** Checking and savings only: no card or loan, so nothing for /liabilities/get (LIAB-008). */
function depositoryOnlyScenario(): ConformanceScenario {
  const scenario = riveraScenario();
  const keep = new Set<string>([RIVERA.checking, RIVERA.savings]);
  scenario.accounts = scenario.accounts.filter((a) => keep.has(a.providerAccountId));
  scenario.balances = scenario.balances.filter((b) => keep.has(b.providerAccountId));
  scenario.liabilities = [];
  scenario.updates = scenario.updates.map((update) =>
    update.map((p) => ({
      ...p,
      added: (p.added ?? []).filter((t) => keep.has(t.providerAccountId)),
      modified: (p.modified ?? []).filter((t) => keep.has(t.providerAccountId)),
      removed: (p.removed ?? []).filter((t) => keep.has(t.providerAccountId)),
    })),
  );
  return scenario;
}

describe('Plaid sync, end to end (#82)', { timeout: 60_000 }, () => {
  let h: WorkerHarness;
  let fake: FakePlaid | undefined;
  let logs: string[];

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 300_000);
  afterAll(() => h?.close(), 60_000);
  beforeEach(async () => {
    logs = [];
    await h.owner.query('UPDATE connections SET next_sync_at = NULL');
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await h.owner.query(text, params)).rows as T[];

  const logger = {
    log: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };

  /** One runner pass with the worker's own registry, pointed at the fake (sandbox only). */
  const run = async (f: FakePlaid) => {
    const runner = new Runner(
      {
        db: h.worker.db,
        crypto: h.crypto,
        providers: new ProviderRegistry([
          plaidProviderSource({
            clientId: f.clientId,
            secret: f.secret,
            env: 'sandbox',
            apiBaseUrl: f.url,
          }),
        ]),
        handlers: new JobHandlers(DEFAULT_JOB_HANDLERS),
        logger,
      },
      { random: () => 0 },
    );
    await runner.pass();
    await runner.idle();
  };

  /** A household whose owner confirmed the bank's accounts (`provider_account_id` set). */
  async function connect(
    f: FakePlaid,
    accounts: [providerAccountId: string, type: string][],
    stamp: { providerEnv?: string; providerClientId?: string } = {},
  ) {
    const { householdId, memberId } = await h.household();
    const connectionId = await h.connection({
      householdId,
      ownerMemberId: memberId,
      provider: 'plaid',
      secret: f.accessToken,
      providerEnv: stamp.providerEnv ?? 'sandbox',
      providerClientId: stamp.providerClientId ?? f.clientId,
    });
    const ids: Record<string, string> = {};
    for (const [providerAccountId, type] of accounts) {
      ids[providerAccountId] = await h.account({
        householdId,
        owners: [memberId],
        connectionId,
        providerAccountId,
        type,
        name: providerAccountId,
      });
    }
    return { householdId, connectionId, ids };
  }

  const transactions = (householdId: string) =>
    sql<{
      id: string;
      account_id: string;
      provider_transaction_id: string | null;
      provider_pending_id: string | null;
      pending: boolean;
      amount_minor: string;
      original_description: string;
      deleted_at: Date | null;
    }>(
      `SELECT id, account_id, provider_transaction_id, provider_pending_id, pending, amount_minor,
              original_description, deleted_at
       FROM transactions WHERE household_id = $1`,
      [householdId],
    );

  const paths = (f: FakePlaid) => f.requests.map((r) => r.path);

  it('syncs transactions, balances and card details, and posts a pending one across pages', async () => {
    fake = await startFakePlaid({ scenario: splitPostingScenario() });
    const b = await connect(fake, [
      [RIVERA.checking, 'depository'],
      [RIVERA.savings, 'depository'],
      [RIVERA.visa, 'credit'],
    ]);

    await run(fake);
    expect(await h.row(b.connectionId)).toMatchObject({ status: 'ok', lastErrorCode: null });
    expect(paths(fake)).toEqual([
      '/transactions/sync',
      '/transactions/sync',
      '/accounts/get',
      // Card details: the Item has a card, so /liabilities/get is called (LIAB-008).
      '/accounts/get',
      '/liabilities/get',
    ]);

    const first = new Map(
      (await transactions(b.householdId)).map((t) => [t.provider_transaction_id, t]),
    );
    expect(first.size).toBe(6);
    // Plaid's positive amounts are money out: Fiscus's negative (TXN-005).
    expect(Number(first.get('txn-rent-1001')?.amount_minor)).toBe(-185_000);
    expect(Number(first.get('txn-payroll-0930')?.amount_minor)).toBe(312_500);
    expect(first.get('txn-rent-1001')?.original_description).toBe('OAKVIEW PROPERTIES RENT');
    const pendingCoffee = first.get(COFFEE_PENDING)!;
    expect(pendingCoffee).toMatchObject({ pending: true, deleted_at: null });

    // Balances, in Fiscus's sign: the card's balance owed is negative.
    const balances = await sql<{ account_id: string; balance_minor: string; source: string }>(
      `SELECT account_id, balance_minor, source FROM balance_snapshots
       WHERE household_id = $1 AND source = 'provider'`,
      [b.householdId],
    );
    expect(
      Object.fromEntries(balances.map((r) => [r.account_id, Number(r.balance_minor)])),
    ).toEqual({
      [b.ids[RIVERA.checking]!]: 651_240,
      [b.ids[RIVERA.savings]!]: 3_125_000,
      [b.ids[RIVERA.visa]!]: -180_722,
    });

    const [card] = await sql<Record<string, unknown>>(
      `SELECT apr_bps, minimum_payment_minor, next_due_date::text, last_statement_balance_minor,
              last_statement_date::text
       FROM account_liabilities WHERE account_id = $1`,
      [b.ids[RIVERA.visa]],
    );
    expect(card).toMatchObject({
      apr_bps: 2149,
      next_due_date: '2026-10-25',
      last_statement_date: '2026-09-28',
    });
    expect(Number(card!.minimum_payment_minor)).toBe(3_500);
    expect(Number(card!.last_statement_balance_minor)).toBe(-142_310);

    const [before] = await sql<{ sync_cursor: string; historical_complete: boolean }>(
      'SELECT sync_cursor, historical_complete FROM connections WHERE id = $1',
      [b.connectionId],
    );
    expect(before).toEqual({ sync_cursor: 'cursor-2', historical_complete: false });

    // The coffee posts: the posted one on one page, the pending one's removal on the next.
    fake.release();
    await h.due(b.connectionId);
    await run(fake);
    expect(await h.row(b.connectionId)).toMatchObject({ status: 'ok', lastErrorCode: null });

    const after = await transactions(b.householdId);
    const coffee = after.filter((t) =>
      [COFFEE, COFFEE_PENDING].includes(t.provider_transaction_id ?? ''),
    );
    // One transaction: the pending one became the posted one, in place.
    expect(coffee).toEqual([
      expect.objectContaining({
        id: pendingCoffee.id,
        provider_transaction_id: COFFEE,
        provider_pending_id: COFFEE_PENDING,
        pending: false,
        deleted_at: null,
      }),
    ]);
    const dinner = after.find((t) => t.provider_transaction_id === 'txn-dinner-1004');
    expect(Number(dinner?.amount_minor)).toBe(-6_100);
    expect(after.filter((t) => t.deleted_at === null)).toHaveLength(8);
    const [done] = await sql<{ sync_cursor: string; historical_complete: boolean }>(
      'SELECT sync_cursor, historical_complete FROM connections WHERE id = $1',
      [b.connectionId],
    );
    expect(done).toEqual({ sync_cursor: 'cursor-4', historical_complete: true });

    // Every sync request asked for 500 at a time, pinned PFC v2 and the bank's own text.
    for (const r of fake.requests.filter((r) => r.path === '/transactions/sync')) {
      expect(JSON.parse(r.body)).toMatchObject({
        count: 500,
        options: { include_original_description: true, personal_finance_category_version: 'v2' },
      });
    }
    // No token or key in any log line.
    for (const line of logs) {
      expect(line).not.toContain(fake.accessToken);
      expect(line).not.toContain(fake.secret);
    }
  });

  it('never calls /liabilities/get for an Item without a card or loan', async () => {
    fake = await startFakePlaid({ scenario: depositoryOnlyScenario() });
    const b = await connect(fake, [
      [RIVERA.checking, 'depository'],
      [RIVERA.savings, 'depository'],
    ]);
    await run(fake);
    expect(await h.row(b.connectionId)).toMatchObject({ status: 'ok', lastErrorCode: null });
    expect(paths(fake)).not.toContain('/liabilities/get');
    expect(paths(fake).filter((p) => p === '/accounts/get')).toHaveLength(2);
    const rows = await transactions(b.householdId);
    expect(rows.map((t) => t.provider_transaction_id).sort()).toEqual([
      'txn-dividend-0930',
      'txn-payroll-0930',
      'txn-rent-1001',
    ]);
    const [{ count }] = (await sql<{ count: string }>(
      `SELECT count(*) FROM balance_snapshots WHERE household_id = $1 AND source = 'provider'`,
      [b.householdId],
    )) as [{ count: string }];
    expect(Number(count)).toBe(2);
    const liabilities = await sql('SELECT 1 FROM account_liabilities WHERE household_id = $1', [
      b.householdId,
    ]);
    expect(liabilities).toEqual([]);
  });

  it('asks the owner to sign in again on ITEM_LOGIN_REQUIRED, logging Plaid’s request id only', async () => {
    fake = await startFakePlaid();
    const b = await connect(fake, [[RIVERA.checking, 'depository']]);
    fake.failNext('/transactions/sync', {
      error_type: 'ITEM_ERROR',
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: 'Alex Rivera must sign in at Harbor Credit Union',
    });
    await run(fake);
    expect(await h.row(b.connectionId)).toMatchObject({
      status: 'login_required',
      lastErrorCode: 'ITEM_LOGIN_REQUIRED',
    });
    expect(await transactions(b.householdId)).toEqual([]);
    const failed = logs.find((l) => l.includes('failed (ITEM_LOGIN_REQUIRED'));
    expect(failed).toMatch(/request req-\d+\)/);
    expect(logs.join('\n')).not.toContain('Harbor');
  });

  it('backs off, without writing anything, while Plaid’s product isn’t ready', async () => {
    fake = await startFakePlaid();
    const b = await connect(fake, [[RIVERA.checking, 'depository']]);
    fake.failNext('/transactions/sync', {
      error_type: 'ITEM_ERROR',
      error_code: 'PRODUCT_NOT_READY',
    });
    await run(fake);
    expect(await h.row(b.connectionId)).toMatchObject({
      status: 'error',
      lastErrorCode: 'PRODUCT_NOT_READY',
      consecutiveFailures: 1,
      nextInMinutes: 1,
    });
    await h.due(b.connectionId);
    await run(fake);
    expect(await h.row(b.connectionId)).toMatchObject({ status: 'ok', lastErrorCode: null });
  });

  it('refuses a connection made with other Plaid keys, without calling Plaid', async () => {
    fake = await startFakePlaid();
    const other = await connect(fake, [[RIVERA.checking, 'depository']], {
      providerClientId: 'another-plaid-account',
    });
    await run(fake);
    expect(await h.row(other.connectionId)).toMatchObject({
      status: 'error',
      lastErrorCode: 'credentials_changed',
    });
    expect(fake.requests).toEqual([]);
  });

  it("syncs with the household's own keys, and shreds replaced ones once their last bank ends (#83)", async () => {
    const HOUSEHOLD = { clientId: 'household-client-id-7731', secret: 'household-secret' };
    fake = await startFakePlaid({ otherKeys: [HOUSEHOLD] });
    const { householdId, memberId } = await h.household();
    const setId = randomUUID();
    await withContext(h.worker.db, systemContext(householdId), (tx) =>
      savePlaidKeySet(tx, h.crypto, {
        id: setId,
        householdId,
        createdByMemberId: memberId,
        ...HOUSEHOLD,
        env: 'sandbox',
      }),
    );
    const connectionId = await h.connection({
      householdId,
      ownerMemberId: memberId,
      secret: fake.accessToken,
      providerEnv: 'sandbox',
      providerClientId: HOUSEHOLD.clientId,
      credentialSetId: setId,
    });
    await h.account({
      householdId,
      owners: [memberId],
      connectionId,
      providerAccountId: RIVERA.checking,
      name: 'Checking',
    });
    await run(fake);
    expect(await h.row(connectionId)).toMatchObject({ status: 'ok', lastErrorCode: null });
    const clients = new Set(fake.requests.map((r) => JSON.parse(r.body).client_id));
    expect([...clients]).toEqual([HOUSEHOLD.clientId]);
    expect((await transactions(householdId)).length).toBeGreaterThan(0);

    // Replaced since (revoked, still needed), then the bank is disconnected: ending it at Plaid
    // uses the old keys, and then nothing needs them, so their secret goes.
    await h.owner.query('UPDATE aggregation_credentials SET revoked_at = now() WHERE id = $1', [
      setId,
    ]);
    await h.owner.query(
      `UPDATE connections SET status = 'disconnected', disconnect_requested = true WHERE id = $1`,
      [connectionId],
    );
    await h.due(connectionId);
    await run(fake);
    expect(paths(fake).at(-1)).toBe('/item/remove');
    expect(
      await sql('SELECT length(secret_enc) AS n FROM aggregation_credentials WHERE id = $1', [
        setId,
      ]),
    ).toEqual([{ n: 0 }]);
  });

  it("fails as household_keys_unavailable when the household's keys are gone", async () => {
    fake = await startFakePlaid();
    const { householdId, memberId } = await h.household();
    const setId = randomUUID();
    await h.owner.query(
      `INSERT INTO aggregation_credentials (id, household_id, provider, client_id, secret_enc, env, revoked_at)
       VALUES ($1, $2, 'plaid', 'gone', ''::bytea, 'sandbox', now())`,
      [setId, householdId],
    );
    const connectionId = await h.connection({
      householdId,
      ownerMemberId: memberId,
      providerEnv: 'sandbox',
      providerClientId: 'gone',
      credentialSetId: setId,
    });
    await run(fake);
    expect(await h.row(connectionId)).toMatchObject({
      status: 'error',
      lastErrorCode: 'household_keys_unavailable',
    });
    expect(fake.requests).toEqual([]);
  });

  it('ends a disconnected connection at Plaid with /item/remove, then drops its token', async () => {
    fake = await startFakePlaid();
    const b = await connect(fake, [[RIVERA.checking, 'depository']]);
    await h.owner.query(
      `UPDATE connections SET status = 'disconnected', disconnect_requested = true WHERE id = $1`,
      [b.connectionId],
    );
    await run(fake);
    expect(paths(fake)).toEqual(['/item/remove']);
    expect(await h.row(b.connectionId)).toMatchObject({
      disconnectRequested: false,
      hasSecret: false,
    });
  });
});
