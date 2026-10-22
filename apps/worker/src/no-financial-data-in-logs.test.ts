// SPDX-License-Identifier: AGPL-3.0-or-later
import { ProviderRegistry } from '@fiscus/aggregation';
import { FakeAggregationProvider } from '@fiscus/aggregation/testing';
import {
  ProviderError,
  type ProviderAccount,
  type ProviderBalance,
  type SyncPage,
  type SyncRequest,
} from '@fiscus/domain';
import type { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Runner } from './runner/runner.js';
import { startWorkerHarness, until, type WorkerHarness } from './testing/harness.js';
import { WorkerModule } from './worker.module.js';

/**
 * No financial data in the worker's logs (ADR 0014 §2.3, #308), the worker's side of
 * apps/api/src/no-financial-data-in-logs.test.ts. The worker runs with every log level captured,
 * and stdout and stderr too, while its runner (#81) syncs and ends connections whose secrets,
 * accounts and balances are recognizable, including failures whose messages carry them. Only
 * connection ids and codes may appear.
 */
describe('no financial data in the worker logs (#308)', () => {
  const NAME = 'QZXV';
  const BALANCE = 8675309; // $86,753.09
  const ACCESS_TOKEN = `access-production-${NAME}-5ecret`;
  const SECRETS = [
    NAME.toLowerCase(),
    ACCESS_TOKEN.toLowerCase(),
    String(BALANCE),
    '86753.09',
    '86,753.09',
  ];

  const captured: string[] = [];
  const record = (...args: unknown[]) =>
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  const logger: LoggerService = {
    log: record,
    error: record,
    warn: record,
    debug: record,
    verbose: record,
    fatal: record,
  };
  const writes = { stdout: process.stdout.write, stderr: process.stderr.write };
  let h: WorkerHarness;

  beforeAll(async () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const original = writes[stream];
      process[stream].write = ((chunk: unknown, ...rest: never[]) => {
        captured.push(String(chunk));
        return original.call(process[stream], chunk as string, ...rest);
      }) as typeof process.stdout.write;
    }
    h = await startWorkerHarness();
  }, 300_000);

  afterAll(async () => {
    process.stdout.write = writes.stdout;
    process.stderr.write = writes.stderr;
    await h?.close();
  }, 60_000);

  /** The fake, answering with the values, and failing with them in its messages. */
  class LeakyProvider extends FakeAggregationProvider {
    constructor() {
      const accounts: ProviderAccount[] = [
        {
          providerAccountId: `acct-${NAME}`,
          name: `Checking ${NAME}`,
          type: 'depository',
          currency: 'USD',
          mask: '4410',
        },
      ];
      const balances: ProviderBalance[] = [
        {
          providerAccountId: `acct-${NAME}`,
          currency: 'USD',
          currentMinor: BALANCE,
          asOf: '2026-10-21',
        },
      ];
      super({
        id: 'plaid',
        mode: 'delta',
        secret: ACCESS_TOKEN,
        accounts,
        balances,
        updates: [
          [
            {
              added: [
                {
                  providerTransactionId: `txn-${NAME}`,
                  providerAccountId: `acct-${NAME}`,
                  amountMinor: -BALANCE,
                  currency: 'USD',
                  pending: false,
                  postedDate: '2026-10-20',
                  authorizedDate: '2026-10-20',
                  description: `PAYMENT TO ${NAME}`,
                  merchantName: NAME,
                },
              ],
            },
          ],
        ],
      });
    }

    override async sync(secret: string, request: SyncRequest): Promise<SyncPage> {
      if (secret.endsWith('-provider-error')) {
        throw new ProviderError('institution_down', {
          providerCode: 'INSTITUTION_DOWN',
          providerMessage: `Checking ${NAME} at ${secret}: balance ${BALANCE}`,
        });
      }
      if (secret.endsWith('-bug')) {
        throw new TypeError(`Cannot read ${secret} of Checking ${NAME} (${BALANCE})`);
      }
      return super.sync(ACCESS_TOKEN, request);
    }

    override async remove(secret: string): Promise<void> {
      if (secret.endsWith('-remove-fails')) {
        throw new Error(`remove failed for ${secret}: balance ${BALANCE}`);
      }
    }
  }

  it('logs connection ids and codes, never secrets, names or amounts', async () => {
    const ids = [
      await h.connection({ secret: ACCESS_TOKEN }),
      await h.connection({ secret: `${ACCESS_TOKEN}-provider-error` }),
      await h.connection({ secret: `${ACCESS_TOKEN}-bug` }),
      await h.connection({ provider: 'simplefin', secret: ACCESS_TOKEN }),
      await h.connection({
        status: 'disconnected',
        disconnectRequested: true,
        secret: ACCESS_TOKEN,
      }),
      await h.connection({
        status: 'disconnected',
        disconnectRequested: true,
        secret: `${ACCESS_TOKEN}-remove-fails`,
      }),
    ];
    // Synced into an account, so ingest, rules, transfers and balances all run.
    await h.account({
      householdId: h.householdId,
      owners: [h.memberId],
      name: `Checking ${NAME}`,
      connectionId: ids[0],
      providerAccountId: `acct-${NAME}`,
    });
    const app = await NestFactory.createApplicationContext(
      WorkerModule.forRoot({
        db: h.worker.db,
        crypto: h.crypto,
        providers: new ProviderRegistry([new LeakyProvider()]),
        options: { pollMs: 60_000, concurrency: 10 },
      }),
      { logger },
    );
    const runner = app.get(Runner);
    await until(() => runner.status().lastPassAt !== null, 30_000);
    await runner.idle();
    await app.close();

    // The sync did ingest: what it wrote is in the ledger, not the logs.
    const { rows } = await h.owner.query(
      'SELECT count(*)::int AS n FROM transactions WHERE provider_transaction_id = $1',
      [`txn-${NAME}`],
    );
    expect(rows).toEqual([{ n: 1 }]);
    const text = captured.join('\n');
    // What was logged, so the capture works: ids, outcomes, and codes.
    expect(
      ids.filter((id) => !text.includes(id)),
      text,
    ).toEqual([]);
    expect(text).toContain(`sync ${ids[0]}: ok`);
    expect(text).toContain(`remove ${ids[4]}: done`);
    expect(text).toContain('INSTITUTION_DOWN');
    expect(text).toContain('provider_unavailable');
    expect(text).toContain('TypeError');
    for (const secret of SECRETS) {
      expect(text.toLowerCase(), `"${secret}" appeared in the logs`).not.toContain(secret);
    }
  }, 60_000);
});
