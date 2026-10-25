// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Possible duplicates (#80, the bank connections walkthrough D7): what the review shows of a
 * synced transaction the worker held, and what "Same transaction" and "Different" do. Holds are
 * made directly here; how sync makes them is the worker's sync.test.ts. Who may see and decide
 * them is TXN-13 in permissions.test.ts.
 */

type Res = Awaited<ReturnType<TestClient['request']>>;
const ok = (r: Res) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
const refused = (r: Res, status: number, code?: string) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body.code).toBe(code);
};

let tdb: TestDatabase;
let app: NestFastifyApplication;
let db: pg.Client;
let hh = '';
let A: TestClient;
let checking = '';
let connectionId = '';
const url = (p = '') => `/api/v1/households/${hh}${p}`;

let n = 0;
/** One of yours in checking, as an import or by hand would have put it there. */
const mine = async (amountMinor: number, date: string, displayName = 'Lunch') => {
  const r = await A.post(url('/transactions'), {
    accountId: checking,
    amountMinor,
    date,
    displayName,
  });
  ok(r);
  return r.body.data.id as string;
};
/** The bank's copy, held as possibly one of `candidates`. */
const hold = async (amountMinor: number, date: string, candidates: string[], name = 'LUNCH SPOT') =>
  (
    await db.query(
      `INSERT INTO sync_holds (id, household_id, connection_id, account_id, provider_transaction_id,
         amount_minor, currency, posted_date, authorized_date, original_description, display_name,
         candidate_ids)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'USD', $6, $6, $7, $8, $9::uuid[])
       RETURNING id`,
      [
        hh,
        connectionId,
        checking,
        `bank-${++n}`,
        amountMinor,
        date,
        name.toUpperCase(),
        name,
        candidates,
      ],
    )
  ).rows[0].id as string;
const review = async () => {
  const r = await A.get(url('/transactions/possible-duplicates'));
  ok(r);
  return r.body.data as any[];
};
const decide = (id: string, body: unknown) =>
  A.post(url(`/transactions/possible-duplicates/${id}`), body);
const transaction = async (id: string) =>
  (
    await db.query(
      `SELECT provider_transaction_id, source, review_status, category_id, display_name,
              amount_minor::int AS amount, posted_date::text AS date
       FROM transactions WHERE id = $1`,
      [id],
    )
  ).rows[0];
const history = async (id: string) =>
  ((await A.get(url(`/transactions/${id}/history`))).body.data as any[]).map(
    (e) => `${e.action} by ${e.actor.label}`,
  );

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
  db = new pg.Client({ connectionString: tdb.ownerUrl });
  await db.connect();
  A = new TestClient(app);
  await A.post('/api/v1/auth/signup', {
    email: 'alex@duplicates.test',
    password: 'duplicates test Password1!',
    displayName: 'Alex',
  });
  const created = (
    await A.post('/api/v1/households', { name: 'Riveras', baseCurrency: 'USD', timezone: 'UTC' })
  ).body.data;
  hh = created.id;
  checking = (await A.post(url('/accounts'), { name: 'Checking', type: 'depository' })).body.data
    .id;
  connectionId = crypto.randomUUID();
  await db.query(
    `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status)
     VALUES ($1, $2, $3, 'plaid', 'item-duplicates', 'ok')`,
    [connectionId, hh, created.you.memberId],
  );
  await db.query('UPDATE accounts SET connection_id = $1 WHERE id = $2', [connectionId, checking]);
}, 180_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await tdb?.stop();
});

describe('possible duplicates (#80, D7)', () => {
  it('lists the bank’s copy beside the ones it may be, and counts it in the review', async () => {
    const before = (await A.get(url('/transactions/review-count'))).body.data;
    const near = await mine(-1_550, '2026-10-06');
    const nearer = await mine(-1_550, '2026-10-07', 'Lunch again');
    const id = await hold(-1_550, '2026-10-07', [nearer, near]);
    const listed = (await review()).find((d) => d.id === id);
    expect(listed).toMatchObject({
      account: { id: checking, name: 'Checking' },
      bank: {
        date: '2026-10-07',
        amountMinor: -1_550,
        currency: 'USD',
        displayName: 'LUNCH SPOT',
        originalDescription: 'LUNCH SPOT',
      },
    });
    expect(listed.candidates.map((c: { id: string }) => c.id)).toEqual([nearer, near]);
    expect(listed.candidates[0]).toMatchObject({
      date: '2026-10-07',
      displayName: 'Lunch again',
      account: { id: checking, name: 'Checking' },
    });
    const after = (await A.get(url('/transactions/review-count'))).body.data;
    expect(after.duplicates).toBe(before.duplicates + 1);
    expect(after.count).toBe(before.count + 1);
    // Nothing of it is in the ledger meanwhile.
    expect(
      (
        await db.query('SELECT 1 FROM transactions WHERE provider_transaction_id = $1', [
          `bank-${n}`,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('"Same transaction" keeps yours, with the bank’s id, and says so in its history', async () => {
    const yours = await mine(-2_000, '2026-10-08', 'Books');
    const groceries = (
      await db.query(`SELECT id FROM categories WHERE household_id = $1 AND name = 'Groceries'`, [
        hh,
      ])
    ).rows[0].id as string;
    ok(
      await A.request(
        'PATCH',
        url(`/transactions/${yours}`),
        { categoryId: groceries },
        {
          headers: {
            'if-match': `"v${(await A.get(url(`/transactions/${yours}`))).body.data.version}"`,
          },
        },
      ),
    );
    const id = await hold(-2_000, '2026-10-09', [yours], 'BOOKSHOP');
    const r = await decide(id, { decision: 'same', transactionId: yours });
    ok(r);
    expect(r.body.data).toEqual({ transactionId: yours });
    expect(await transaction(yours)).toMatchObject({
      provider_transaction_id: `bank-${n}`,
      source: 'manual',
      category_id: groceries,
      display_name: 'Books',
      date: '2026-10-08',
    });
    expect((await review()).map((d) => d.id)).not.toContain(id);
    expect(await history(yours)).toContain('transaction.matched_to_bank by Alex');
    // Decided already.
    refused(await decide(id, { decision: 'different' }), 404);
  });

  it('"Different" adds the bank’s, needing review, as sync would have', async () => {
    const yours = await mine(-900, '2026-10-10', 'Parking');
    const id = await hold(-900, '2026-10-11', [yours], 'CITY PARKING');
    const r = await decide(id, { decision: 'different' });
    ok(r);
    const added = r.body.data.transactionId as string;
    expect(await transaction(added)).toMatchObject({
      provider_transaction_id: `bank-${n}`,
      source: 'provider',
      review_status: 'needs_review',
      display_name: 'CITY PARKING',
      amount: -900,
      date: '2026-10-11',
    });
    expect(await transaction(yours)).toMatchObject({ provider_transaction_id: null });
    expect(await history(added)).toEqual(['transaction.added_from_bank by Alex']);
    // It counts now: in the account's balance like any other.
    const listedIds = (
      await A.get(url(`/transactions?accounts=${checking}&limit=200`))
    ).body.data.map((t: { id: string }) => t.id);
    expect(listedIds).toContain(added);
  });

  it('refuses one that isn’t a candidate, and one that can’t be matched any more', async () => {
    const yours = await mine(-300, '2026-10-12', 'Snack');
    const other = await mine(-300, '2026-10-12', 'Other snack');
    const first = await hold(-300, '2026-10-12', [yours]);
    const second = await hold(-300, '2026-10-12', [yours]);
    refused(
      await decide(first, { decision: 'same', transactionId: other }),
      422,
      'not_a_candidate',
    );
    ok(await decide(first, { decision: 'same', transactionId: yours }));
    // The other copy can't be yours too: it's listed with nothing left to match, and refused.
    expect((await review()).find((d) => d.id === second).candidates).toEqual([]);
    refused(
      await decide(second, { decision: 'same', transactionId: yours }),
      409,
      'candidate_gone',
    );
    ok(await decide(second, { decision: 'different' }));
  });

  it('answers 404 for a hold that isn’t there', async () =>
    refused(await decide(crypto.randomUUID(), { decision: 'different' }), 404));
});
