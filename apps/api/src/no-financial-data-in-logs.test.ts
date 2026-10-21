// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import { createDb, saveConnectionSecret, withContext } from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { LoggerService } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TransactionsService } from './ledger/transactions.service.js';
import { runImport } from './testing/imports.js';
import { createTestApp, TestClient } from './testing/test-app.js';

/**
 * No financial data in logs, errors, or metrics (ADR 0014 §2.3, #308). The app runs with every
 * log level captured, and stdout and stderr too, while it handles recognizable values the way a
 * person would: an account and its balance, transactions and their notes, a search, an import,
 * refused requests, a bank connection and its secret (#78), and a server error whose message holds
 * the values, as a failed query's does. None of the values may appear in what was captured.
 */
describe('no financial data in logs (#308)', () => {
  // Distinctive, and not hex, so no id or timestamp matches them by chance.
  const NAME = 'QZXV';
  const AMOUNT = -8675309; // $86,753.09
  const BALANCE = 5551212; // $55,512.12
  const IMPORTED = -2718281; // $27,182.81
  /** A bank connection's access token: never in a response, a log, or activity (#78). */
  const ACCESS_TOKEN = `access-production-${NAME}-5ecret`;
  const SECRETS = [
    NAME.toLowerCase(),
    ...[AMOUNT, BALANCE, IMPORTED].flatMap((minor) => {
      const major = (Math.abs(minor) / 100).toFixed(2);
      return [String(Math.abs(minor)), major, Number(major).toLocaleString('en-US')];
    }),
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

  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let hh = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;

  beforeAll(async () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const original = writes[stream];
      process[stream].write = ((chunk: unknown, ...rest: never[]) => {
        captured.push(String(chunk));
        return original.call(process[stream], chunk as string, ...rest);
      }) as typeof process.stdout.write;
    }
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' }, logger);
  }, 180_000);

  afterAll(async () => {
    process.stdout.write = writes.stdout;
    process.stderr.write = writes.stderr;
    await app?.close();
    await tdb?.stop();
  });

  it('handles accounts, transactions, notes, searches, imports, and errors without logging them', async () => {
    A = new TestClient(app);
    await A.post('/api/v1/auth/signup', {
      email: 'logs@logs.test',
      password: 'logs test Password1!',
      displayName: `Ada ${NAME}`,
    });
    const created = (
      await A.post('/api/v1/households', {
        name: `Home ${NAME}`,
        baseCurrency: 'USD',
        timezone: 'UTC',
      })
    ).body.data;
    hh = created.id;
    const account = await A.post(url('/accounts'), {
      name: `Checking ${NAME}`,
      type: 'depository',
      openingBalance: { amountMinor: BALANCE, asOf: '2026-01-01' },
      notes: `Account note ${NAME}`,
    });
    expect(account.status).toBe(201);
    const accountId = account.body.data.id as string;

    const txn = await A.post(url('/transactions'), {
      accountId,
      date: '2026-02-01',
      amountMinor: AMOUNT,
      displayName: `Coffee ${NAME}`,
    });
    expect(txn.status).toBe(201);
    const id = txn.body.data.id as string;
    await A.request('PUT', url(`/transactions/${id}/notes/shared`), { body: `Shared ${NAME}` });
    await A.request('PUT', url(`/transactions/${id}/notes/mine`), { body: `Mine ${NAME}` });
    expect((await A.get(url(`/transactions?q=${NAME}`))).body.data).toHaveLength(1);

    const imported = await runImport(A, url(), {
      format: 'csv',
      filename: `bank ${NAME}.csv`,
      accounts: [{ key: 'file', accountId }],
      transactions: [
        {
          line: 2,
          account: 'file',
          date: '2026-02-03',
          amountMinor: IMPORTED,
          description: `GROCER ${NAME}`,
        },
      ],
    });
    expect(imported.added).toBe(1);

    // A bank connection with its secret (made by the link flow in #79; here, as its owner would),
    // listed and disconnected.
    const userId = (await A.get('/api/v1/me')).body.data.id as string;
    const connectionId = crypto.randomUUID();
    const db = createDb(tdb.appUrl);
    try {
      await withContext(
        db.db,
        { householdId: hh, memberId: created.you.memberId, userId, system: false },
        async (tx) => {
          await tx.execute(
            sql`INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status)
                VALUES (${connectionId}, ${hh}, ${created.you.memberId}, 'plaid', ${`item-${NAME}`}, 'ok')`,
          );
          await tx.execute(
            sql`UPDATE accounts SET connection_id = ${connectionId} WHERE id = ${accountId}`,
          );
          await saveConnectionSecret(tx, app.get(FieldCrypto), hh, connectionId, ACCESS_TOKEN);
        },
      );
    } finally {
      await db.close();
    }
    const responses = [
      await A.get(url('/connections')),
      await A.delete(url(`/connections/${connectionId}`)),
      await A.get(url('/activity?limit=200')),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 204, 200]);
    expect(responses[0]!.body.data).toHaveLength(1);
    expect(
      responses[2]!.body.data.some(
        (e: { action: string }) => e.action === 'connection.disconnected',
      ),
    ).toBe(true);
    for (const r of responses) expect(JSON.stringify(r.body ?? '')).not.toContain(ACCESS_TOKEN);

    // Refused: a change without If-Match, and a body that doesn't validate.
    expect(
      (await A.request('PATCH', url(`/transactions/${id}`), { displayName: `Renamed ${NAME}` }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await A.post(url('/transactions'), { accountId, amountMinor: AMOUNT, displayName: NAME }))
        .status,
    ).toBe(422);

    // A server error carrying the values, as a failed query's message and cause do.
    const cause = Object.assign(new Error(`Key (display_name)=(Coffee ${NAME}) already exists.`), {
      code: '23505',
      constraint: 'transactions_example_key',
      detail: `Key (display_name)=(Coffee ${NAME}) already exists.`,
    });
    const failed = new Error(
      `Failed query: select ... where display_name ilike $1\nparams: %${NAME}%,${AMOUNT}`,
      { cause },
    );
    failed.name = 'DrizzleQueryError';
    vi.spyOn(app.get(TransactionsService), 'list').mockRejectedValueOnce(failed);
    expect((await A.get(url(`/transactions?q=${NAME}`))).status).toBe(500);

    const text = captured.join('\n');
    // The error was logged, so the capture works: by route pattern, class, and code.
    expect(text).toContain('GET /api/v1/households/:householdId/transactions');
    expect(text).toContain('DrizzleQueryError');
    expect(text).toContain('code=23505');
    expect(text).not.toContain(ACCESS_TOKEN);
    for (const secret of SECRETS) {
      expect(text.toLowerCase(), `"${secret}" appeared in the logs`).not.toContain(secret);
    }
  });
});
