// SPDX-License-Identifier: AGPL-3.0-or-later
import { ProviderRegistry, SimpleFinProvider } from '@fiscus/aggregation';
import { type FakeSimpleFin, RIVERA, startFakeSimpleFin } from '@fiscus/aggregation/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_JOB_HANDLERS } from '../runner/handlers.js';
import { JobHandlers } from '../runner/jobs.js';
import { Runner } from '../runner/runner.js';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';

/**
 * A confirmed SimpleFIN connection, synced end to end by the runner through the SimpleFIN adapter
 * (#91) against the fake Bridge: SimpleFIN's format in, Fiscus's ledger out, a window per sync,
 * and the Bridge's 6-hour schedule.
 */

describe('SimpleFIN sync, end to end (#91)', { timeout: 60_000 }, () => {
  let h: WorkerHarness;
  let fake: FakeSimpleFin | undefined;
  const logs: string[] = [];

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 300_000);
  afterAll(() => h?.close(), 60_000);
  beforeEach(async () => {
    logs.length = 0;
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

  const run = async (f: FakeSimpleFin) => {
    const runner = new Runner(
      {
        db: h.worker.db,
        crypto: h.crypto,
        providers: new ProviderRegistry([
          new SimpleFinProvider({ allowedHosts: [f.host], allowHttp: true }),
        ]),
        handlers: new JobHandlers(DEFAULT_JOB_HANDLERS),
        logger,
      },
      { random: () => 0 },
    );
    await runner.pass();
    await runner.idle();
  };

  async function connect(f: FakeSimpleFin, accounts: [string, string][]) {
    const { householdId, memberId } = await h.household();
    const connectionId = await h.connection({
      householdId,
      ownerMemberId: memberId,
      provider: 'simplefin',
      secret: f.accessUrl,
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
      provider_transaction_id: string | null;
      pending: boolean;
      amount_minor: string;
      posted_date: string | null;
      deleted_at: Date | null;
    }>(
      `SELECT provider_transaction_id, pending, amount_minor, posted_date::text, deleted_at
       FROM transactions WHERE household_id = $1`,
      [householdId],
    );

  it('syncs a window of transactions and balances, then a pending one posting, 6 hours apart', async () => {
    fake = await startFakeSimpleFin();
    const b = await connect(fake, [
      [RIVERA.checking, 'depository'],
      [RIVERA.savings, 'depository'],
      [RIVERA.visa, 'credit'],
    ]);

    await run(fake);
    expect(await h.row(b.connectionId)).toMatchObject({
      status: 'ok',
      lastErrorCode: null,
      // The Bridge's daily budget: never sooner than 6 hours.
      nextInMinutes: 360,
    });
    const [first] = fake.requests.filter((r) => r.path === '/simplefin/accounts');
    expect(first!.query.get('pending')).toBe('1');
    expect(first!.query.get('version')).toBe('2');

    const rows = new Map(
      (await transactions(b.householdId)).map((t) => [t.provider_transaction_id, t]),
    );
    expect(rows.size).toBe(6);
    // SimpleFIN's sign is Fiscus's: money in is positive.
    expect(Number(rows.get('txn-payroll-0930')?.amount_minor)).toBe(312_500);
    expect(Number(rows.get('txn-rent-1001')?.amount_minor)).toBe(-185_000);
    expect(rows.get('txn-coffee-1005-pending')).toMatchObject({ pending: true, posted_date: null });

    const balances = await sql<{ account_id: string; balance_minor: string }>(
      `SELECT account_id, balance_minor FROM balance_snapshots
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

    // The coffee posts under a new id; the pending one disappears from the Bridge's window.
    fake.release();
    await h.owner.query('UPDATE connections SET next_sync_at = now() WHERE id = $1', [
      b.connectionId,
    ]);
    await run(fake);
    const [, second] = fake.requests.filter((r) => r.path === '/simplefin/accounts');
    // A fortnight before the latest transaction, less a day for time zones: not 90 days again.
    const latest = Date.parse('2026-10-05T00:00:00Z') / 1000;
    expect(Number(second!.query.get('start-date'))).toBe(latest - 15 * 86_400);

    const after = await transactions(b.householdId);
    const live = after.filter((t) => !t.deleted_at);
    const coffee = live.filter((t) => Number(t.amount_minor) === -450);
    // One coffee, posted: the pending row became it, so edits stay (#88's same-amount match).
    expect(coffee).toHaveLength(1);
    expect(coffee[0]).toMatchObject({ pending: false, provider_transaction_id: 'txn-coffee-1005' });
    expect(logs.join('\n')).not.toContain('rivera-bridge-password');
  });

  it('fails a revoked token as needing its owner, and doesn’t poll it', async () => {
    fake = await startFakeSimpleFin();
    const b = await connect(fake, [[RIVERA.checking, 'depository']]);
    fake.failNext({ status: 403, body: 'Revoked, Alex Rivera' });
    await run(fake);
    expect(await h.row(b.connectionId)).toMatchObject({
      status: 'login_required',
      lastErrorCode: 'SIMPLEFIN_ACCESS_REVOKED',
    });
    expect(logs.join('\n')).not.toContain('Alex');
  });
});
