// SPDX-License-Identifier: AGPL-3.0-or-later
import { ProviderRegistry } from '@fiscus/aggregation';
import {
  type FakeScript,
  FakeAggregationProvider,
  RIVERA,
  riveraAccounts,
  riveraBalances,
  riveraLiabilities,
  type ScriptedPage,
} from '@fiscus/aggregation/testing';
import type { ProviderSecret, ProviderTransaction, SyncPage, SyncRequest } from '@fiscus/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_JOB_HANDLERS } from '../runner/handlers.js';
import { JobHandlers } from '../runner/jobs.js';
import { Runner } from '../runner/runner.js';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';

/**
 * Sync (#80) against Postgres, logged in as the real fiscus_worker role, with the fake provider:
 * what lands in the ledger from a sync's pages, what the bank may change and remove, and how a
 * sync that's interrupted writes nothing and picks up again without adding or losing anything.
 */

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const DAY_MS = 86_400_000;
const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * DAY_MS).toISOString().slice(0, 10);

/** A posted USD transaction on the day it was authorized. */
const txn = (
  id: string,
  account: string,
  amountMinor: number,
  date: string,
  fields: Partial<ProviderTransaction> = {},
): ProviderTransaction => ({
  providerTransactionId: id,
  providerAccountId: account,
  amountMinor,
  currency: 'USD',
  pending: false,
  postedDate: date,
  authorizedDate: date,
  description: `SHOP ${id.toUpperCase()}`,
  ...fields,
});

const pages = (list: ProviderTransaction[], size: number): ScriptedPage[] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => ({
    added: list.slice(i * size, (i + 1) * size),
  }));

/** The Riveras' bank, scripted as the test needs it. */
const fake = (updates: ScriptedPage[][], script: Partial<FakeScript> = {}) =>
  new FakeAggregationProvider({
    id: 'plaid',
    mode: 'delta',
    accounts: riveraAccounts(),
    balances: riveraBalances(),
    liabilities: riveraLiabilities(),
    updates,
    ...script,
  });

const requests = (p: FakeAggregationProvider) =>
  p.calls.flatMap((c) => (c.method === 'sync' ? [c.request] : []));

describe('sync (#80)', { timeout: 60_000 }, () => {
  let h: WorkerHarness;

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 300_000);
  afterAll(() => h?.close(), 60_000);

  // Each test has its own household; earlier ones' connections aren't due any more.
  beforeEach(async () => {
    await h.owner.query('UPDATE connections SET next_sync_at = NULL');
  });

  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await h.owner.query(text, params)).rows as T[];

  const run = async (provider: FakeAggregationProvider) => {
    const runner = new Runner(
      {
        db: h.worker.db,
        crypto: h.crypto,
        providers: new ProviderRegistry([provider]),
        handlers: new JobHandlers(DEFAULT_JOB_HANDLERS),
        logger: quiet,
      },
      { random: () => 0 },
    );
    await runner.pass();
    await runner.idle();
  };

  interface Bank {
    householdId: string;
    memberId: string;
    connectionId: string;
    checking: string;
    savings: string;
    visa: string;
  }

  /** A household whose owner connected the Riveras' checking, savings and card (not old savings). */
  async function bank(opts: { syncFrom?: string; ownerMemberId?: string } = {}): Promise<Bank> {
    const { householdId, memberId } = await h.household();
    const owner = opts.ownerMemberId ?? memberId;
    const connectionId = await h.connection({ householdId, ownerMemberId: owner });
    const link = (providerAccountId: string, name: string, type = 'depository') =>
      h.account({
        householdId,
        owners: [owner],
        connectionId,
        providerAccountId,
        name,
        type,
        syncFrom: opts.syncFrom ?? null,
      });
    return {
      householdId,
      memberId,
      connectionId,
      checking: await link(RIVERA.checking, 'Checking'),
      savings: await link(RIVERA.savings, 'Savings'),
      visa: await link(RIVERA.visa, 'Visa', 'credit'),
    };
  }

  const category = async (householdId: string, name: string) =>
    (
      await sql<{ id: string }>('SELECT id FROM categories WHERE household_id = $1 AND name = $2', [
        householdId,
        name,
      ])
    )[0]!.id;

  const byProviderId = async (householdId: string) =>
    new Map(
      (
        await sql<{
          provider_transaction_id: string;
          id: string;
          account_id: string;
          amount_minor: string;
          posted_date: string | null;
          date_override: string | null;
          display_name: string;
          original_description: string;
          category_id: string | null;
          review_status: string;
          source: string;
          deleted_at: Date | null;
          transfer_group_id: string | null;
        }>(
          `SELECT provider_transaction_id, id, account_id, amount_minor, posted_date::text,
                  date_override::text, display_name, original_description, category_id,
                  review_status, source, deleted_at, transfer_group_id
           FROM transactions WHERE household_id = $1 AND provider_transaction_id IS NOT NULL`,
          [householdId],
        )
      ).map((r) => [r.provider_transaction_id, { ...r, amount_minor: Number(r.amount_minor) }]),
    );

  /** Activity entries of `action`, with the transactions each is linked to. */
  const events = async (householdId: string, action: string) =>
    sql<{
      account_id: string | null;
      actor_kind: string;
      actor_member_id: string | null;
      metadata: Record<string, unknown>;
      ids: string[];
    }>(
      `SELECT e.account_id, e.actor_kind, e.actor_member_id, e.metadata,
              coalesce(array_agg(l.transaction_id::text) FILTER (WHERE l.transaction_id IS NOT NULL),
                       '{}') AS ids
       FROM audit_events e
       LEFT JOIN activity_transactions l ON l.household_id = e.scope_id AND l.seq = e.seq
       WHERE e.household_id = $1 AND e.action = $2
       GROUP BY e.seq, e.account_id, e.actor_kind, e.actor_member_id, e.metadata
       ORDER BY e.seq`,
      [householdId, action],
    );

  const connection = async (id: string) =>
    (
      await sql<{ status: string; sync_cursor: string | null; historical_complete: boolean }>(
        'SELECT status, sync_cursor, historical_complete FROM connections WHERE id = $1',
        [id],
      )
    )[0]!;

  it('lands a first sync of 3 accounts × 500 transactions once each, with rules and transfers', async () => {
    const b = await bank();
    const coffee = await category(b.householdId, 'Coffee');
    await sql(
      `INSERT INTO rules (id, household_id, name, position, conditions, actions, author_member_id)
       VALUES (uuidv7(), $1, 'Coffee', 1, $2, $3, $4)`,
      [
        b.householdId,
        { description: { op: 'contains', value: 'coffee' } },
        { categoryId: coffee },
        b.memberId,
      ],
    );
    // 20 transfers from checking to savings, their two sides pages apart; every other amount
    // has no opposite anywhere.
    const outs = Array.from({ length: 20 }, (_, i) =>
      txn(`out-${i}`, RIVERA.checking, -(100_000 + i), day(i * 20), {
        description: 'ONLINE TRANSFER TO SAVINGS',
      }),
    );
    const ins = Array.from({ length: 20 }, (_, i) =>
      txn(`in-${i}`, RIVERA.savings, 100_000 + i, day(i * 20), {
        description: 'ONLINE TRANSFER FROM CHECKING',
      }),
    );
    const spending = (
      [
        [RIVERA.checking, 480, 1_000],
        [RIVERA.savings, 480, 2_000],
        [RIVERA.visa, 500, 3_000],
      ] as const
    ).flatMap(([account, n, base]) =>
      Array.from({ length: n }, (_, i) =>
        txn(`${account}-${i}`, account, -(base + i), day(i % 600), {
          ...(i % 10 === 0 && { description: 'CORNER COFFEE #12', merchantName: 'Corner Coffee' }),
        }),
      ),
    );
    const update = pages([...outs, ...spending, ...ins], 300);
    update.at(-1)!.historicalComplete = true;
    const provider = fake([update]);

    await run(provider);

    const [counts] = await sql(
      `SELECT count(*)::int AS rows,
              count(DISTINCT (account_id, provider_transaction_id))::int AS distinct,
              count(*) FILTER (WHERE source = 'provider' AND review_status = 'needs_review'
                               AND deleted_at IS NULL)::int AS fresh,
              count(DISTINCT transfer_group_id)::int AS transfers,
              count(*) FILTER (WHERE category_id = $2)::int AS coffee
       FROM transactions WHERE household_id = $1`,
      [b.householdId, coffee],
    );
    expect(counts).toEqual({ rows: 1500, distinct: 1500, fresh: 1500, transfers: 20, coffee: 146 });
    // Each transfer is the pair it should be.
    const rows = await byProviderId(b.householdId);
    for (let i = 0; i < 20; i++) {
      expect(rows.get(`out-${i}`)!.transfer_group_id).not.toBeNull();
      expect(rows.get(`out-${i}`)!.transfer_group_id).toBe(rows.get(`in-${i}`)!.transfer_group_id);
    }
    expect(rows.get(`${RIVERA.visa}-10`)).toMatchObject({
      display_name: 'Corner Coffee',
      original_description: 'CORNER COFFEE #12',
    });

    // One entry per account, as the system for the connection's owner; every transaction in
    // exactly one of them.
    const added = await events(b.householdId, 'sync.transactions_added');
    expect(added.length).toBe(3);
    for (const e of added) {
      expect(e).toMatchObject({ actor_kind: 'system', actor_member_id: b.memberId });
      expect(e.metadata.count).toBe(e.ids.length);
    }
    const ids = added.flatMap((e) => e.ids);
    expect(new Set(ids).size).toBe(1500);
    expect(ids.length).toBe(1500);
    expect((await events(b.householdId, 'transaction.rules_applied')).length).toBeGreaterThan(0);

    expect(requests(provider).map((r) => r.cursor)).toEqual([
      null,
      'fake:0:1',
      'fake:0:2',
      'fake:0:3',
      'fake:0:4',
    ]);
    expect(await connection(b.connectionId)).toEqual({
      status: 'ok',
      sync_cursor: 'fake:1:0',
      historical_complete: true,
    });
    // The five pages were applied as one: a single entry for the sync, with counts only.
    const applied = await events(b.householdId, 'sync.applied');
    expect(applied).toEqual([
      expect.objectContaining({
        actor_kind: 'system',
        metadata: {
          mode: 'delta',
          pages: 5,
          restarts: 0,
          added: 1500,
          matched: 0,
          updated: 0,
          posted: 0,
          removed: 0,
          skipped: 0,
          balances: 3,
          historicalComplete: true,
        },
      }),
    ]);
    // The bank's balances for the three tracked accounts, and the card's statement details.
    expect(
      await sql(
        `SELECT a.name, s.balance_minor::int AS balance FROM balance_snapshots s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.household_id = $1 AND s.source = 'provider' ORDER BY a.name`,
        [b.householdId],
      ),
    ).toEqual([
      { name: 'Checking', balance: 651_240 },
      { name: 'Savings', balance: 3_125_000 },
      { name: 'Visa', balance: -180_722 },
    ]);
    expect(
      await sql('SELECT account_id, apr_bps FROM account_liabilities WHERE household_id = $1', [
        b.householdId,
      ]),
    ).toEqual([{ account_id: b.visa, apr_bps: 2149 }]);
  });

  it('adds and loses nothing when pages run again, or restart after mutation_during_pagination', async () => {
    const b = await bank();
    const list = Array.from({ length: 150 }, (_, i) =>
      txn(`t-${i}`, [RIVERA.checking, RIVERA.savings, RIVERA.visa][i % 3]!, -(500 + i), day(i)),
    );
    const provider = fake([pages(list, 50)], {
      errors: [{ onSync: 2, kind: 'mutation_during_pagination' }],
    });
    // What's in the ledger, and the stored cursor, each time a page is asked for.
    const seen: { rows: number; cursor: string | null }[] = [];
    const sync = provider.sync.bind(provider);
    provider.sync = async (secret, request) => {
      const [now] = await sql<{ rows: number; cursor: string | null }>(
        `SELECT (SELECT count(*)::int FROM transactions WHERE household_id = $1) AS rows,
                (SELECT sync_cursor FROM connections WHERE id = $2) AS cursor`,
        [b.householdId, b.connectionId],
      );
      seen.push(now!);
      return sync(secret, request);
    };
    await run(provider);
    // Nothing was written while it paged, before the restart or after it.
    expect(seen).toEqual(Array.from({ length: 6 }, () => ({ rows: 0, cursor: null })));
    // The third page failed: it starts over from where this run began.
    expect(requests(provider).map((r) => r.cursor)).toEqual([
      null,
      'fake:0:1',
      'fake:0:2',
      null,
      'fake:0:1',
      'fake:0:2',
    ]);
    const count = async () =>
      (
        await sql<{ n: number; live: number }>(
          `SELECT count(*)::int AS n, count(*) FILTER (WHERE deleted_at IS NULL)::int AS live
           FROM transactions WHERE household_id = $1`,
          [b.householdId],
        )
      )[0];
    expect(await count()).toEqual({ n: 150, live: 150 });
    expect(await connection(b.connectionId)).toMatchObject({
      status: 'ok',
      sync_cursor: 'fake:1:0',
    });

    // Every page again, from the start: nothing new, and nothing recorded as arriving.
    const before = (await events(b.householdId, 'sync.transactions_added')).length;
    await sql('UPDATE connections SET sync_cursor = NULL WHERE id = $1', [b.connectionId]);
    await h.due(b.connectionId);
    await run(provider);
    expect(await count()).toEqual({ n: 150, live: 150 });
    expect((await events(b.householdId, 'sync.transactions_added')).length).toBe(before);
  });

  it('writes nothing, and keeps the cursor, when any page can’t be applied', async () => {
    const b = await bank();
    const provider = fake([
      [
        { added: [txn('ok-1', RIVERA.checking, -100, '2026-10-01')] },
        // Not a date: the sync's transaction rolls back, the pages either side of it too.
        { added: [txn('bad-1', RIVERA.checking, -200, '2026-02-30')] },
        { added: [txn('ok-2', RIVERA.checking, -300, '2026-10-02')] },
      ],
    ]);
    await run(provider);
    expect(await connection(b.connectionId)).toMatchObject({
      status: 'error',
      sync_cursor: null,
    });
    expect([...(await byProviderId(b.householdId)).keys()]).toEqual([]);
    expect(await events(b.householdId, 'sync.applied')).toEqual([]);
    // The next run asks again from where the last one began.
    await h.due(b.connectionId);
    await run(provider);
    expect(requests(provider).map((r) => r.cursor)).toEqual([
      null,
      'fake:0:1',
      'fake:0:2',
      null,
      'fake:0:1',
      'fake:0:2',
    ]);
  });

  it('lets the bank change what it owns, never what a person set, and never undelete', async () => {
    const b = await bank();
    const dinner = txn('dinner', RIVERA.visa, -5_200, '2026-10-05', {
      authorizedDate: '2026-10-04',
      description: "LUCIA'S TRATTORIA",
      merchantName: "Lucia's Trattoria",
    });
    const groceries = txn('groceries', RIVERA.visa, -8_743, '2026-10-03');
    const coffee = txn('coffee', RIVERA.visa, -450, '2026-10-05');
    const bottle = txn('bottle', RIVERA.checking, -650, '2026-10-06', {
      description: 'SQ *BLUE BOTTLE',
    });
    const provider = fake([
      [{ added: [dinner, groceries, coffee, bottle] }],
      [
        {
          added: [groceries],
          modified: [
            { ...dinner, amountMinor: -6_100, postedDate: '2026-10-06' },
            { ...groceries, amountMinor: -9_000 },
            { ...bottle, description: 'SQ *BLUE BOTTLE COFFEE' },
          ],
          removed: [{ providerTransactionId: 'coffee', providerAccountId: RIVERA.visa }],
        },
      ],
    ]);
    await run(provider);
    let rows = await byProviderId(b.householdId);
    expect(rows.get('bottle')!.display_name).toBe('Blue Bottle');

    // A person categorizes, renames and moves the dinner, and deletes the groceries.
    const restaurants = await category(b.householdId, 'Restaurants');
    await sql(
      `UPDATE transactions SET category_id = $2, display_name = 'Date night',
         date_override = '2026-10-08', review_status = 'reviewed', version = version + 1,
         field_versions = '{"categoryId": 2, "displayName": 2, "dateOverride": 2, "reviewStatus": 2}'
       WHERE id = $1`,
      [rows.get('dinner')!.id, restaurants],
    );
    await sql('UPDATE transactions SET deleted_at = now() WHERE id = $1', [
      rows.get('groceries')!.id,
    ]);

    provider.release();
    await h.due(b.connectionId);
    await run(provider);
    rows = await byProviderId(b.householdId);
    expect(rows.get('dinner')).toMatchObject({
      amount_minor: -6_100,
      posted_date: '2026-10-06',
      date_override: '2026-10-08',
      category_id: restaurants,
      display_name: 'Date night',
      review_status: 'reviewed',
      deleted_at: null,
    });
    expect(rows.get('groceries')!.deleted_at).not.toBeNull();
    expect(rows.get('groceries')!.amount_minor).toBe(-8_743);
    expect(rows.get('coffee')!.deleted_at).not.toBeNull();
    // A name nobody set follows the bank's text.
    expect(rows.get('bottle')).toMatchObject({
      display_name: 'Blue Bottle Coffee',
      original_description: 'SQ *BLUE BOTTLE COFFEE',
    });
    expect(
      (
        await sql('SELECT count(*)::int AS n FROM transactions WHERE household_id = $1', [
          b.householdId,
        ])
      )[0],
    ).toEqual({ n: 4 });

    const updated = await events(b.householdId, 'transaction.provider_updated');
    expect(updated.map((e) => e.ids)).toEqual([[rows.get('dinner')!.id], [rows.get('bottle')!.id]]);
    expect(updated[0]!.metadata.fields).toEqual(['amountMinor', 'date']);
    expect(updated[0]).toMatchObject({ actor_kind: 'system', actor_member_id: b.memberId });
    const removed = await events(b.householdId, 'transaction.provider_removed');
    expect(removed.map((e) => [e.ids, e.metadata.kept])).toEqual([
      [[rows.get('coffee')!.id], false],
    ]);
  });

  it('skips what came before an account’s sync_from, and attaches an exact single match', async () => {
    const b = await bank({ syncFrom: '2026-10-01' });
    const {
      rows: [tag],
    } = await h.owner.query(
      `INSERT INTO tags (id, household_id, name, color) VALUES (uuidv7(), $1, 'Home', '#000') RETURNING id`,
      [b.householdId],
    );
    const rent = await category(b.householdId, 'Rent or mortgage');
    const imported = async (amountMinor: number, date: string, extra = '') =>
      (
        await sql<{ id: string }>(
          `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, posted_date,
             authorized_date, original_description, display_name, source ${extra ? ', category_id, review_status, field_versions' : ''})
           VALUES (uuidv7(), $1, $2, $3, 'USD', $4, $4, 'FROM A FILE', 'From a file', 'import'
             ${extra ? `, '${extra}', 'reviewed', '{"categoryId": 1, "attribution": 1}'` : ''})
           RETURNING id`,
          [b.householdId, b.checking, amountMinor, date],
        )
      )[0]!.id;
    const rentId = await imported(-185_000, '2026-10-01', rent);
    await sql(
      'INSERT INTO transaction_tags (transaction_id, tag_id, household_id) VALUES ($1, $2, $3)',
      [rentId, tag.id, b.householdId],
    );
    await sql(
      `INSERT INTO transaction_attributions (transaction_id, member_id, household_id, share_bps)
       VALUES ($1, $2, $3, 10000)`,
      [rentId, b.memberId, b.householdId],
    );
    // Two the same: which one the bank's is isn't clear. One a day off: near, not exact.
    await imported(-450, '2026-10-07');
    await imported(-450, '2026-10-07');
    await imported(-3_874, '2026-10-13');
    await imported(-1_200, '2026-10-10');

    const provider = fake([
      [
        {
          added: [
            txn('payroll', RIVERA.checking, 312_500, '2026-09-30'),
            txn('rent', RIVERA.checking, -185_000, '2026-10-01', {
              description: 'OAKVIEW PROPERTIES RENT',
            }),
            txn('coffee', RIVERA.checking, -450, '2026-10-07'),
            txn('fuel', RIVERA.checking, -3_874, '2026-10-14'),
            // Pending: never attached, since its bank removes it once it posts.
            txn('hold', RIVERA.checking, -1_200, '2026-10-10', {
              pending: true,
              postedDate: undefined,
            }),
          ],
        },
      ],
    ]);
    await run(provider);
    expect(requests(provider)[0]).toEqual({
      cursor: null,
      since: '2026-10-01',
      timeZone: expect.any(String),
    } satisfies SyncRequest);

    const rows = await byProviderId(b.householdId);
    expect([...rows.keys()].sort()).toEqual(['coffee', 'fuel', 'hold', 'rent']);
    expect(rows.get('rent')).toMatchObject({
      id: rentId,
      source: 'import',
      category_id: rent,
      review_status: 'reviewed',
      display_name: 'From a file',
    });
    expect(
      await sql('SELECT tag_id FROM transaction_tags WHERE transaction_id = $1', [rentId]),
    ).toEqual([{ tag_id: tag.id }]);
    expect(
      await sql('SELECT member_id FROM transaction_attributions WHERE transaction_id = $1', [
        rentId,
      ]),
    ).toEqual([{ member_id: b.memberId }]);
    for (const id of ['coffee', 'fuel', 'hold']) expect(rows.get(id)!.source).toBe('provider');
    expect(
      (
        await sql('SELECT count(*)::int AS n FROM transactions WHERE account_id = $1', [b.checking])
      )[0],
    ).toEqual({ n: 8 });
    expect((await events(b.householdId, 'sync.transactions_matched')).map((e) => e.ids)).toEqual([
      [rentId],
    ]);
  });

  it("links transfers only where the connection's owner could", async () => {
    const { householdId, memberId: ada } = await h.household();
    const bea = await h.member(householdId, 'Bea');
    const connectionId = await h.connection({ householdId, ownerMemberId: ada });
    const checking = await h.account({
      householdId,
      owners: [ada],
      connectionId,
      providerAccountId: RIVERA.checking,
    });
    const adaSavings = await h.account({ householdId, owners: [ada], name: 'Ada savings' });
    const beaPrivate = await h.account({
      householdId,
      owners: [bea],
      name: 'Bea private',
      visibility: 'private',
    });
    const beaShared = await h.account({ householdId, owners: [bea], name: 'Bea shared' });
    const deposit = async (accountId: string, amountMinor: number, date: string) =>
      (
        await sql<{ id: string }>(
          `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, posted_date,
             authorized_date, original_description, display_name, source)
           VALUES (uuidv7(), $1, $2, $3, 'USD', $4, $4, 'DEPOSIT', 'Deposit', 'manual') RETURNING id`,
          [householdId, accountId, amountMinor, date],
        )
      )[0]!.id;
    const toAda = await deposit(adaSavings, 30_000, '2026-10-12');
    const toBea = await deposit(beaPrivate, 50_000, '2026-10-12');
    const toBeaShared = await deposit(beaShared, 60_000, '2026-10-12');
    // Ada sees only her own savings' side: unambiguous for her, as it is here.
    const toAdaToo = await deposit(adaSavings, 70_000, '2026-10-15');
    await deposit(beaPrivate, 70_000, '2026-10-15');

    await run(
      fake([
        [
          {
            added: [
              txn('to-ada', RIVERA.checking, -30_000, '2026-10-12'),
              txn('to-bea', RIVERA.checking, -50_000, '2026-10-12'),
              txn('to-bea-shared', RIVERA.checking, -60_000, '2026-10-12'),
              txn('to-ada-too', RIVERA.checking, -70_000, '2026-10-15'),
            ],
          },
        ],
      ]),
    );
    const rows = await byProviderId(householdId);
    const group = async (id: string) =>
      (
        await sql<{ g: string | null }>(
          'SELECT transfer_group_id AS g FROM transactions WHERE id = $1',
          [id],
        )
      )[0]!.g;
    expect(rows.get('to-ada')!.transfer_group_id).not.toBeNull();
    expect(await group(toAda)).toBe(rows.get('to-ada')!.transfer_group_id);
    expect(rows.get('to-ada-too')!.transfer_group_id).not.toBeNull();
    expect(await group(toAdaToo)).toBe(rows.get('to-ada-too')!.transfer_group_id);
    for (const id of ['to-bea', 'to-bea-shared'])
      expect(rows.get(id)!.transfer_group_id).toBeNull();
    expect(await group(toBea)).toBeNull();
    expect(await group(toBeaShared)).toBeNull();
    expect(rows.get('to-ada')!.account_id).toBe(checking);
  });

  it('drops the provider’s rows a window left out, for the accounts it lists only', async () => {
    const b = await bank();
    /** SimpleFIN-like; the second time, the bank doesn't return the card at all. */
    class Windowed extends FakeAggregationProvider {
      withoutVisa = false;
      override async sync(secret: ProviderSecret, request: SyncRequest): Promise<SyncPage> {
        const page = await super.sync(secret, request);
        if (!this.withoutVisa) return page;
        return {
          ...page,
          added: page.added.filter((t) => t.providerAccountId !== RIVERA.visa),
          window: {
            ...page.window!,
            providerAccountIds: page.window!.providerAccountIds.filter((p) => p !== RIVERA.visa),
          },
        };
      }
    }
    // An imported transaction the bank's copy attaches to (D7): yours first, so it stays.
    const [mine] = await sql<{ id: string }>(
      `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, posted_date,
         authorized_date, original_description, display_name, source)
       VALUES (uuidv7(), $1, $2, -999, 'USD', '2026-10-05', '2026-10-05', 'FILE', 'File', 'import')
       RETURNING id`,
      [b.householdId, b.checking],
    );
    const yours = mine!.id;
    const provider = new Windowed({
      id: 'plaid',
      mode: 'window',
      accounts: riveraAccounts(),
      updates: [
        [
          {
            added: [
              txn('a', RIVERA.checking, -100, '2026-10-01'),
              txn('b', RIVERA.checking, -200, '2026-10-02'),
              txn('c', RIVERA.visa, -300, '2026-10-03'),
              txn('d', RIVERA.visa, -400, '2026-10-04'),
              txn('x', RIVERA.checking, -999, '2026-10-05'),
            ],
          },
        ],
        [
          {
            removed: ['b', 'd', 'x'].map((id) => ({
              providerTransactionId: id,
              providerAccountId: id === 'd' ? RIVERA.visa : RIVERA.checking,
            })),
          },
        ],
      ],
    });
    await run(provider);
    let rows = await byProviderId(b.householdId);
    expect([...rows.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'x']);
    expect(rows.get('x')!.id).toBe(yours);

    provider.release();
    provider.withoutVisa = true;
    await h.due(b.connectionId);
    await run(provider);
    rows = await byProviderId(b.householdId);
    const live = [...rows.values()]
      .filter((r) => !r.deleted_at)
      .map((r) => r.provider_transaction_id);
    expect(live.sort()).toEqual(['a', 'c', 'd']);
    expect(rows.get('b')!.deleted_at).not.toBeNull();
    // Yours lets go of the bank's id, and stays.
    expect(rows.has('x')).toBe(false);
    expect(await sql('SELECT deleted_at, source FROM transactions WHERE id = $1', [yours])).toEqual(
      [{ deleted_at: null, source: 'import' }],
    );
    const removed = await events(b.householdId, 'transaction.provider_removed');
    expect(removed.map((e) => e.metadata.kept).sort()).toEqual([false, true]);
    // A window sync has no cursor to keep.
    expect((await connection(b.connectionId)).sync_cursor).toBeNull();
  });

  describe('when it fails', () => {
    const status = async (id: string) =>
      (
        await sql<{ status: string; code: string | null; next: number | null }>(
          `SELECT status, last_error_code AS code,
                  round(extract(epoch FROM next_sync_at - now()) / 60)::int AS next
           FROM connections WHERE id = $1`,
          [id],
        )
      )[0];

    it('maps provider errors to the connection’s status', async () => {
      for (const [kind, providerCode, expected] of [
        ['login_required', 'ITEM_LOGIN_REQUIRED', 'login_required'],
        ['consent_expired', 'PENDING_EXPIRATION', 'login_required'],
        ['institution_down', 'INSTITUTION_DOWN', 'error'],
        ['rate_limited', 'RATE_LIMIT_EXCEEDED', 'error'],
      ] as const) {
        const b = await bank();
        await run(fake([[{}]], { errors: [{ onSync: 0, kind, providerCode }] }));
        expect(await status(b.connectionId)).toMatchObject({
          status: expected,
          code: providerCode,
        });
        if (expected === 'error') expect((await status(b.connectionId))!.next).toBe(1);
        await sql('UPDATE connections SET next_sync_at = NULL');
      }
    });

    it('gives up on mutation_during_pagination after a few restarts', async () => {
      const b = await bank();
      const provider = fake([[{}]], {
        errors: Array.from({ length: 4 }, (_, n) => ({
          onSync: n,
          kind: 'mutation_during_pagination' as const,
          providerCode: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
        })),
      });
      await run(provider);
      expect(await status(b.connectionId)).toMatchObject({
        status: 'error',
        code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
      });
      expect(requests(provider)).toHaveLength(4);
    });

    it('skips a connection whose owner has left', async () => {
      const { householdId } = await h.household();
      const sam = await h.member(householdId, 'Sam');
      const connectionId = await h.connection({ householdId, ownerMemberId: sam });
      await sql('UPDATE household_members SET left_at = now() WHERE id = $1', [sam]);
      const provider = fake([[{}]]);
      await run(provider);
      expect(await status(connectionId)).toMatchObject({ status: 'error', code: 'owner_left' });
      expect(provider.calls).toEqual([]);
    });

    it('stops when another run moved the cursor meanwhile', async () => {
      const b = await bank();
      const provider = fake([
        [
          { added: [txn('one', RIVERA.checking, -100, '2026-10-01')] },
          { added: [txn('two', RIVERA.checking, -200, '2026-10-02')] },
        ],
      ]);
      const sync = provider.sync.bind(provider);
      provider.sync = async (secret, request) => {
        // As if a run whose lease ran out committed its sync in between.
        if (request.cursor !== null) {
          await sql(`UPDATE connections SET sync_cursor = 'fake:0:9' WHERE id = $1`, [
            b.connectionId,
          ]);
        }
        return sync(secret, request);
      };
      await run(provider);
      expect(await status(b.connectionId)).toMatchObject({
        status: 'error',
        code: 'sync_conflict',
      });
      expect([...(await byProviderId(b.householdId)).keys()]).toEqual([]);
    });

    it('writes nothing when the connection is disconnected while it pages', async () => {
      const b = await bank();
      const provider = fake([
        [
          { added: [txn('one', RIVERA.checking, -100, '2026-10-01')] },
          { added: [txn('two', RIVERA.checking, -200, '2026-10-02')] },
        ],
      ]);
      const sync = provider.sync.bind(provider);
      provider.sync = async (secret, request) => {
        if (request.cursor !== null) {
          await sql(`UPDATE connections SET status = 'disconnected' WHERE id = $1`, [
            b.connectionId,
          ]);
        }
        return sync(secret, request);
      };
      await run(provider);
      expect(await connection(b.connectionId)).toMatchObject({
        status: 'disconnected',
        sync_cursor: null,
      });
      expect([...(await byProviderId(b.householdId)).keys()]).toEqual([]);
      expect(await events(b.householdId, 'sync.applied')).toEqual([]);
    });
  });
});
