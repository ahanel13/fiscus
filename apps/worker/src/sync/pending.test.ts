// SPDX-License-Identifier: AGPL-3.0-or-later
import { ProviderRegistry } from '@fiscus/aggregation';
import {
  type FakeScript,
  FakeAggregationProvider,
  RIVERA,
  riveraAccounts,
  type ScriptedPage,
} from '@fiscus/aggregation/testing';
import type { ProviderTransaction } from '@fiscus/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_JOB_HANDLERS } from '../runner/handlers.js';
import { JobHandlers } from '../runner/jobs.js';
import { Runner } from '../runner/runner.js';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';

/**
 * Pending → posted (#88, #47) against Postgres, as the real fiscus_worker role, with the fake
 * provider: a pending transaction you edited becomes the posted one, whatever order the bank
 * says so in, and for a provider without pending links (SimpleFIN) only when it's certain.
 */

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const posted = (
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

/** Pending: authorized on `date`, not posted yet. */
const pending = (
  id: string,
  account: string,
  amountMinor: number,
  date: string,
  fields: Partial<ProviderTransaction> = {},
): ProviderTransaction => {
  const t = posted(id, account, amountMinor, date, { pending: true, ...fields });
  delete t.postedDate;
  return t;
};

const removed = (id: string, account: string) => ({
  providerTransactionId: id,
  providerAccountId: account,
});

const fake = (updates: ScriptedPage[][], script: Partial<FakeScript> = {}) =>
  new FakeAggregationProvider({
    id: 'plaid',
    mode: 'delta',
    accounts: riveraAccounts(),
    updates,
    ...script,
  });

// The dinner: pending for $52.00 on Oct 4, posted on Oct 6 for $61.00 with the tip.
const DINNER = { description: "LUCIA'S TRATTORIA", merchantName: "Lucia's Trattoria" };
const dinnerPending = pending('dinner-pending', RIVERA.visa, -5_200, '2026-10-04', DINNER);
const dinnerPosted = posted('dinner', RIVERA.visa, -6_100, '2026-10-06', {
  ...DINNER,
  authorizedDate: '2026-10-04',
  pendingTransactionId: 'dinner-pending',
});
const dinnerRemoved = removed('dinner-pending', RIVERA.visa);

describe('pending → posted (#88)', { timeout: 60_000 }, () => {
  let h: WorkerHarness;

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 300_000);
  afterAll(() => h?.close(), 60_000);

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

  async function bank(): Promise<Bank> {
    const { householdId, memberId } = await h.household();
    const connectionId = await h.connection({ householdId, ownerMemberId: memberId });
    const link = (providerAccountId: string, name: string, type = 'depository') =>
      h.account({ householdId, owners: [memberId], connectionId, providerAccountId, name, type });
    return {
      householdId,
      memberId,
      connectionId,
      checking: await link(RIVERA.checking, 'Checking'),
      savings: await link(RIVERA.savings, 'Savings'),
      visa: await link(RIVERA.visa, 'Visa', 'credit'),
    };
  }

  /** Each sync after the first sees the next update. */
  const syncAgain = async (b: Bank, provider: FakeAggregationProvider) => {
    provider.release();
    await h.due(b.connectionId);
    await run(provider);
  };

  const category = async (householdId: string, name: string) =>
    (
      await sql<{ id: string }>('SELECT id FROM categories WHERE household_id = $1 AND name = $2', [
        householdId,
        name,
      ])
    )[0]!.id;

  interface TxnRow {
    id: string;
    account_id: string;
    provider_transaction_id: string | null;
    provider_pending_id: string | null;
    pending: boolean;
    amount_minor: number;
    posted_date: string | null;
    authorized_date: string;
    date_override: string | null;
    display_name: string;
    category_id: string | null;
    review_status: string;
    deleted_at: Date | null;
    provider_removed_at: Date | null;
    transfer_group_id: string | null;
  }

  /** Every transaction in the household, deleted ones too. */
  const rows = async (householdId: string) =>
    (
      await sql<TxnRow>(
        `SELECT id, account_id, provider_transaction_id, provider_pending_id, pending,
                amount_minor::int, posted_date::text, authorized_date::text, date_override::text,
                display_name, category_id, review_status, deleted_at, provider_removed_at,
                transfer_group_id
         FROM transactions WHERE household_id = $1 ORDER BY id`,
        [householdId],
      )
    ).map((r) => ({ ...r, amount_minor: Number(r.amount_minor) }));
  const live = async (householdId: string) =>
    (await rows(householdId)).filter((r) => r.deleted_at === null);
  const byProviderId = async (householdId: string, id: string) =>
    (await rows(householdId)).find((r) => r.provider_transaction_id === id);

  const noteContext = (householdId: string, transactionId: string, author: string | null) => ({
    householdId,
    table: 'transaction_notes',
    column: 'body_enc',
    rowId: `${transactionId}:${author ?? 'shared'}`,
  });
  const addNote = async (b: Bank, transactionId: string, author: string | null, body: string) =>
    sql(
      `INSERT INTO transaction_notes (id, household_id, transaction_id, author_member_id, body_enc,
         updated_by_member_id)
       VALUES (uuidv7(), $1, $2, $3, $4, $5)`,
      [
        b.householdId,
        transactionId,
        author,
        await h.crypto.encrypt(noteContext(b.householdId, transactionId, author), body),
        b.memberId,
      ],
    );
  /** A transaction's notes, read as their authors would. */
  const notes = async (b: Bank, transactionId: string) =>
    Promise.all(
      (
        await sql<{ author_member_id: string | null; body_enc: Buffer }>(
          `SELECT author_member_id, body_enc FROM transaction_notes WHERE transaction_id = $1
           ORDER BY author_member_id NULLS FIRST`,
          [transactionId],
        )
      ).map(async (n) => ({
        author: n.author_member_id,
        body: await h.crypto.decrypt(
          noteContext(b.householdId, transactionId, n.author_member_id),
          n.body_enc,
        ),
      })),
    );
  const tags = async (transactionId: string) =>
    (
      await sql<{ name: string }>(
        `SELECT g.name FROM transaction_tags t JOIN tags g ON g.id = t.tag_id
         WHERE t.transaction_id = $1 ORDER BY g.name`,
        [transactionId],
      )
    ).map((t) => t.name);
  const tag = async (b: Bank, transactionId: string, name: string) => {
    await sql(
      `INSERT INTO tags (id, household_id, name, color) VALUES (uuidv7(), $1, $2, '#000')
       ON CONFLICT DO NOTHING`,
      [b.householdId, name],
    );
    const [t] = await sql<{ id: string }>(
      'SELECT id FROM tags WHERE household_id = $1 AND name = $2',
      [b.householdId, name],
    );
    await sql(
      'INSERT INTO transaction_tags (transaction_id, tag_id, household_id) VALUES ($1, $2, $3)',
      [transactionId, t!.id, b.householdId],
    );
  };

  /** The activity entries a transaction's history is made of, oldest first. */
  const history = async (b: Bank, transactionId: string) =>
    sql<{ seq: string; action: string; metadata: Record<string, unknown>; actor_kind: string }>(
      `SELECT e.seq, e.action, e.metadata, e.actor_kind FROM activity_transactions l
       JOIN audit_events e ON e.scope_id = l.household_id AND e.seq = l.seq
       WHERE l.household_id = $1 AND l.transaction_id = $2 ORDER BY l.seq`,
      [b.householdId, transactionId],
    );
  const changes = async (b: Bank, seq: string) => {
    const [e] = await sql<{ changes_enc: Buffer }>(
      'SELECT changes_enc FROM audit_events WHERE scope_id = $1 AND seq = $2',
      [b.householdId, seq],
    );
    return JSON.parse(
      await h.crypto.decrypt(
        {
          householdId: b.householdId,
          table: 'audit_events',
          column: 'changes_enc',
          rowId: `${b.householdId}:${seq}`,
        },
        e!.changes_enc,
      ),
    ) as { before: Record<string, unknown>; after: Record<string, unknown> };
  };

  /** Everything a person can do to a transaction, done to the pending dinner. */
  async function editDinner(b: Bank, id: string) {
    const restaurants = await category(b.householdId, 'Restaurants');
    const bea = await h.member(b.householdId, 'Bea');
    await sql(
      `UPDATE transactions SET category_id = $2, display_name = 'Date night',
         date_override = '2026-10-08', review_status = 'reviewed', version = version + 1,
         field_versions = '{"categoryId": 2, "displayName": 2, "date": 2, "reviewStatus": 2,
                            "tagIds": 2, "attribution": 2}'
       WHERE id = $1`,
      [id, restaurants],
    );
    await tag(b, id, 'Anniversary');
    await addNote(b, id, null, 'Our anniversary');
    await addNote(b, id, b.memberId, 'Mine: book again next year');
    await sql(
      `INSERT INTO transaction_attributions (transaction_id, member_id, household_id, share_bps)
       VALUES ($1, $2, $4, 5000), ($1, $3, $4, 5000)`,
      [id, b.memberId, bea, b.householdId],
    );
    return { restaurants, bea };
  }

  async function expectDinnerKept(
    b: Bank,
    id: string,
    edits: { restaurants: string; bea: string },
    /** Other transactions the bank sent meanwhile, by provider id. */
    others: string[] = [],
  ) {
    const kept = (await live(b.householdId)).filter(
      (r) => !others.includes(r.provider_transaction_id ?? ''),
    );
    expect(kept).toEqual([
      expect.objectContaining({
        id,
        provider_transaction_id: 'dinner',
        provider_pending_id: 'dinner-pending',
        pending: false,
        // The bank's.
        amount_minor: -6_100,
        posted_date: '2026-10-06',
        authorized_date: '2026-10-04',
        // Yours.
        date_override: '2026-10-08',
        display_name: 'Date night',
        category_id: edits.restaurants,
        review_status: 'reviewed',
        provider_removed_at: null,
      }),
    ]);
    expect(await tags(id)).toEqual(['Anniversary']);
    expect(await notes(b, id)).toEqual([
      { author: null, body: 'Our anniversary' },
      { author: b.memberId, body: 'Mine: book again next year' },
    ]);
    expect(
      await sql(
        `SELECT member_id, share_bps FROM transaction_attributions WHERE transaction_id = $1
         ORDER BY share_bps, member_id`,
        [id],
      ),
    ).toEqual(
      expect.arrayContaining([
        { member_id: b.memberId, share_bps: 5000 },
        { member_id: edits.bea, share_bps: 5000 },
      ]),
    );
  }

  describe('with the bank’s pending link (Plaid)', () => {
    const orders: [string, ScriptedPage[][], string[]][] = [
      [
        'posted and removed on one page',
        [[{ added: [dinnerPosted], removed: [dinnerRemoved] }]],
        ['sync.transactions_added', 'transaction.posted'],
      ],
      [
        'posted, then removed on the next page',
        [[{ added: [dinnerPosted] }, { removed: [dinnerRemoved] }]],
        ['sync.transactions_added', 'transaction.posted'],
      ],
      [
        // A sync's pages are applied together: the removal never lands on its own.
        'removed, then posted on the next page',
        [[{ removed: [dinnerRemoved] }, { added: [dinnerPosted] }]],
        ['sync.transactions_added', 'transaction.posted'],
      ],
      [
        'posted in one sync, removed in the next',
        [[{ added: [dinnerPosted] }], [{ removed: [dinnerRemoved] }]],
        ['sync.transactions_added', 'transaction.posted'],
      ],
      [
        'removed in one sync, posted in the next',
        [[{ removed: [dinnerRemoved] }], [{ added: [dinnerPosted] }]],
        ['sync.transactions_added', 'transaction.provider_removed', 'transaction.posted'],
      ],
    ];

    it.each(orders)('keeps every edit when it’s %s', async (_order, updates, life) => {
      const b = await bank();
      const provider = fake([[{ added: [dinnerPending] }], ...updates]);
      await run(provider);
      const [dinner] = await live(b.householdId);
      expect(dinner).toMatchObject({ pending: true, amount_minor: -5_200, posted_date: null });
      const edits = await editDinner(b, dinner!.id);

      for (let i = 0; i < updates.length; i++) await syncAgain(b, provider);

      await expectDinnerKept(b, dinner!.id, edits);
      // One transaction, with nothing left over from its pending days.
      expect(await rows(b.householdId)).toHaveLength(1);
      // Its whole life, the bank's part as the system's, for the connection's owner.
      const entries = await history(b, dinner!.id);
      expect(entries.map((e) => e.action)).toEqual(life);
      const post = entries.at(-1)!;
      expect(post).toMatchObject({
        actor_kind: 'system',
        metadata: { fields: ['amountMinor', 'date'] },
      });
      expect(await changes(b, post.seq)).toMatchObject({
        before: {
          amountMinor: -5_200,
          date: '2026-10-04',
          postedDate: null,
          authorizedDate: '2026-10-04',
        },
        after: {
          amountMinor: -6_100,
          date: '2026-10-06',
          postedDate: '2026-10-06',
          authorizedDate: '2026-10-04',
        },
      });
      // Rules didn't run on it again, and nothing else wrote to it.
      expect(
        (
          await sql(
            `SELECT count(*)::int AS n FROM audit_events
             WHERE scope_id = $1 AND action IN ('transaction.rules_applied', 'sync.transactions_added')`,
            [b.householdId],
          )
        )[0],
      ).toEqual({ n: 1 });
    });

    it('keeps every edit when the removal and the posted one are pages apart, through a restart', async () => {
      const b = await bank();
      const coffee = posted('coffee', RIVERA.checking, -450, '2026-10-05');
      const provider = fake(
        [
          [{ added: [dinnerPending] }],
          [{ removed: [dinnerRemoved] }, { added: [coffee] }, { added: [dinnerPosted] }],
        ],
        // The data changes as the third page is asked for: the sync starts over.
        { errors: [{ onSync: 3, kind: 'mutation_during_pagination' }] },
      );
      await run(provider);
      const [dinner] = await live(b.householdId);
      const edits = await editDinner(b, dinner!.id);
      const cursor = async () =>
        (
          await sql<{ sync_cursor: string }>('SELECT sync_cursor FROM connections WHERE id = $1', [
            b.connectionId,
          ])
        )[0]!.sync_cursor;
      const before = await cursor();
      // While it pages, before the restart and after it, nothing has changed here.
      const seen: unknown[] = [];
      const sync = provider.sync.bind(provider);
      provider.sync = async (secret, request) => {
        seen.push({ rows: await rows(b.householdId), cursor: await cursor() });
        return sync(secret, request);
      };
      const start = { rows: await rows(b.householdId), cursor: before };
      await syncAgain(b, provider);
      expect(seen).toEqual(Array.from({ length: 6 }, () => start));

      expect(
        provider.calls.flatMap((c) => (c.method === 'sync' ? [c.request.cursor] : [])),
      ).toEqual([null, before, 'fake:1:1', 'fake:1:2', before, 'fake:1:1', 'fake:1:2']);
      expect(await cursor()).toBe('fake:2:0');
      expect(await byProviderId(b.householdId, 'coffee')).toMatchObject({ deleted_at: null });
      await expectDinnerKept(b, dinner!.id, edits, ['coffee']);
      // Never removed: it posted in the same sync as its removal.
      expect((await history(b, dinner!.id)).map((e) => e.action)).toEqual([
        'sync.transactions_added',
        'transaction.posted',
      ]);
    });

    it('doesn’t bring back a pending transaction a person deleted, in either order', async () => {
      for (const updates of [
        [[{ added: [dinnerPosted], removed: [dinnerRemoved] }]],
        [[{ removed: [dinnerRemoved] }], [{ added: [dinnerPosted] }]],
      ] satisfies ScriptedPage[][][]) {
        const b = await bank();
        const provider = fake([
          [{ added: [dinnerPending] }],
          ...updates,
          // The bank changes it after it posted: still nothing here.
          [{ modified: [{ ...dinnerPosted, amountMinor: -6_300 }] }],
        ]);
        await run(provider);
        const [dinner] = await live(b.householdId);
        await sql('UPDATE transactions SET deleted_at = now() WHERE id = $1', [dinner!.id]);
        for (let i = 0; i <= updates.length; i++) await syncAgain(b, provider);

        expect(await live(b.householdId)).toEqual([]);
        // It holds the posted id, deleted, so the posted one can't arrive on its own.
        expect(await rows(b.householdId)).toEqual([
          expect.objectContaining({ id: dinner!.id, provider_transaction_id: 'dinner' }),
        ]);
      }
    });

    it('doesn’t add a pending transaction again once it has posted', async () => {
      const b = await bank();
      // Plaid sends the pending one again after its posted one (a sync run from the start).
      const provider = fake([
        [{ added: [dinnerPending] }],
        [{ added: [dinnerPosted], removed: [dinnerRemoved] }],
        [{ added: [dinnerPending] }],
        [{ added: [dinnerPending, dinnerPosted] }],
      ]);
      await run(provider);
      for (let i = 0; i < 3; i++) await syncAgain(b, provider);
      expect(await rows(b.householdId)).toEqual([
        expect.objectContaining({ provider_transaction_id: 'dinner', pending: false }),
      ]);
    });

    it('merges a posted transaction that came in on its own first', async () => {
      const b = await bank();
      const { pendingTransactionId: _, ...unlinked } = dinnerPosted;
      const provider = fake([
        [{ added: [dinnerPending] }],
        // The posted one arrives without its link, and the pending one is still listed.
        [{ added: [unlinked] }],
        // Then the bank says which pending one it replaced.
        [{ modified: [dinnerPosted], removed: [dinnerRemoved] }],
      ]);
      await run(provider);
      const [dinner] = await live(b.householdId);
      const edits = await editDinner(b, dinner!.id);
      await syncAgain(b, provider);
      const copy = (await byProviderId(b.householdId, 'dinner'))!;
      expect(await live(b.householdId)).toHaveLength(2);
      // Someone tags the copy and writes on it: that moves too.
      await tag(b, copy.id, 'Date');
      await sql('DELETE FROM transaction_notes WHERE transaction_id = $1', [dinner!.id]);
      await addNote(b, dinner!.id, b.memberId, 'Mine: book again next year');
      await addNote(b, copy.id, null, 'Our anniversary');

      await syncAgain(b, provider);
      await expect(tags(dinner!.id)).resolves.toEqual(['Anniversary', 'Date']);
      await sql('DELETE FROM transaction_tags WHERE transaction_id = $1', [dinner!.id]);
      await tag(b, dinner!.id, 'Anniversary');
      await expectDinnerKept(b, dinner!.id, edits);
      expect((await rows(b.householdId)).find((r) => r.id === copy.id)).toMatchObject({
        provider_transaction_id: null,
        deleted_at: expect.any(Date),
      });
      // The copy's history is part of the pending one's now; the merge is in both.
      const entries = await history(b, dinner!.id);
      expect(entries.map((e) => e.action)).toEqual([
        'sync.transactions_added',
        'sync.transactions_added',
        'transaction.posted',
      ]);
      expect(entries.at(-1)!.metadata).toMatchObject({ merged: true });
      expect((await history(b, copy.id)).map((e) => e.action)).toEqual([
        'sync.transactions_added',
        'transaction.posted',
      ]);
    });

    it('links a transfer once its pending side posts, without running rules again', async () => {
      const b = await bank();
      const out = pending('p-xfer', RIVERA.checking, -30_000, '2026-10-12', {
        description: 'ONLINE TRANSFER TO SAVINGS',
      });
      const provider = fake([
        [{ added: [out] }],
        [
          {
            added: [
              posted('xfer', RIVERA.checking, -31_000, '2026-10-13', {
                description: 'ONLINE TRANSFER TO SAVINGS',
                authorizedDate: '2026-10-12',
                pendingTransactionId: 'p-xfer',
              }),
            ],
            removed: [removed('p-xfer', RIVERA.checking)],
          },
        ],
      ]);
      await run(provider);
      const [p] = await live(b.householdId);
      // Its other side: entered by hand, for the amount it posts at.
      const [deposit] = await sql<{ id: string }>(
        `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, posted_date,
           authorized_date, original_description, display_name, source)
         VALUES (uuidv7(), $1, $2, 31000, 'USD', '2026-10-13', '2026-10-13', 'DEPOSIT', 'Deposit',
           'manual') RETURNING id`,
        [b.householdId, b.savings],
      );
      // A rule that, had it run again, would have categorized it out of being a transfer.
      await sql(
        `INSERT INTO rules (id, household_id, name, position, conditions, actions, author_member_id)
         VALUES (uuidv7(), $1, 'Coffee', 1, $2, $3, $4)`,
        [
          b.householdId,
          { description: { op: 'contains', value: 'transfer' } },
          { categoryId: await category(b.householdId, 'Coffee') },
          b.memberId,
        ],
      );
      expect(p!.transfer_group_id).toBeNull();

      await syncAgain(b, provider);
      const after = (await live(b.householdId)).find((r) => r.id === p!.id)!;
      expect(after).toMatchObject({ provider_transaction_id: 'xfer', amount_minor: -31_000 });
      expect(after.transfer_group_id).not.toBeNull();
      const [other] = await sql<{ g: string }>(
        'SELECT transfer_group_id AS g FROM transactions WHERE id = $1',
        [deposit!.id],
      );
      expect(other!.g).toBe(after.transfer_group_id);
      expect((await history(b, p!.id)).map((e) => e.action)).toEqual([
        'sync.transactions_added',
        'transaction.posted',
        'transaction.transfer_linked',
      ]);
    });

    it('lists pending transactions, a $0 hold included, as live ones', async () => {
      const b = await bank();
      await run(
        fake([
          [
            {
              added: [
                pending('hold', RIVERA.visa, 0, '2026-10-10', { description: 'HOTEL CHECK' }),
                pending('fuel', RIVERA.visa, -4_000, '2026-10-10'),
              ],
            },
          ],
        ]),
      );
      // What the list and the balances read: live, unsplit rows, pending or not.
      expect(
        await sql(
          `SELECT provider_transaction_id AS id, amount_minor::int AS amount, pending
           FROM transactions
           WHERE household_id = $1 AND deleted_at IS NULL AND has_splits = false
           ORDER BY amount_minor`,
          [b.householdId],
        ),
      ).toEqual([
        { id: 'fuel', amount: -4_000, pending: true },
        { id: 'hold', amount: 0, pending: true },
      ]);
    });
  });

  describe('without links (SimpleFIN)', () => {
    const windowed = (updates: ScriptedPage[][]) => fake(updates, { mode: 'window' });

    it('promotes the one posted match, and leaves the uncertain ones apart', async () => {
      const b = await bank();
      const coffee = pending('p-coffee', RIVERA.checking, -450, '2026-10-10');
      const gas = pending('p-gas', RIVERA.checking, -2_500, '2026-10-11');
      const twins = ['p-a', 'p-b'].map((id) => pending(id, RIVERA.savings, -300, '2026-10-11'));
      const lone = pending('p-lone', RIVERA.savings, -999, '2026-10-11');
      const tip = pending('p-dinner', RIVERA.visa, -5_200, '2026-10-04', DINNER);
      const provider = windowed([
        [{ added: [coffee, gas, ...twins, lone, tip] }],
        [
          {
            removed: [coffee, ...twins, lone, tip].map((t) =>
              removed(t.providerTransactionId, t.providerAccountId),
            ),
            added: [
              // Unique: same account and amount, two days later.
              posted('s-coffee', RIVERA.checking, -450, '2026-10-12'),
              // Posted while its pending one is still listed: settled next time.
              posted('s-gas', RIVERA.checking, -2_500, '2026-10-12'),
              // Two pending, two posted: which is which isn't clear.
              posted('s-a', RIVERA.savings, -300, '2026-10-13'),
              posted('s-b', RIVERA.savings, -300, '2026-10-13'),
              // One pending, two posted that could each be it.
              posted('s-lone-1', RIVERA.savings, -999, '2026-10-12'),
              posted('s-lone-2', RIVERA.savings, -999, '2026-10-13'),
              // With the tip, it no longer matches.
              posted('s-dinner', RIVERA.visa, -6_100, '2026-10-06', DINNER),
            ],
          },
        ],
        [{ removed: [removed('p-gas', RIVERA.checking)] }],
      ]);
      expect(provider.capabilities.pendingLinks).toBe(false);
      await run(provider);
      const restaurants = await category(b.householdId, 'Restaurants');
      const coffeeShops = await category(b.householdId, 'Coffee');
      const edit = async (id: string, categoryId: string, note: string) => {
        const row = (await byProviderId(b.householdId, id))!;
        await sql(
          `UPDATE transactions SET category_id = $2, field_versions = '{"categoryId": 2}'
           WHERE id = $1`,
          [row.id, categoryId],
        );
        await addNote(b, row.id, null, note);
        return row.id;
      };
      const coffeeId = await edit('p-coffee', coffeeShops, 'Met Sam');
      const gasId = await edit('p-gas', await category(b.householdId, 'Gas'), 'Road trip');
      const tipId = await edit('p-dinner', restaurants, 'Our anniversary');

      await syncAgain(b, provider);
      expect(await byProviderId(b.householdId, 's-coffee')).toMatchObject({
        id: coffeeId,
        provider_pending_id: 'p-coffee',
        pending: false,
        posted_date: '2026-10-12',
        category_id: coffeeShops,
      });
      expect(await notes(b, coffeeId)).toEqual([{ author: null, body: 'Met Sam' }]);
      // Nothing lost or counted twice: the uncertain pending ones are gone, their posted ones
      // stand alone.
      const now = await live(b.householdId);
      expect(now.map((r) => r.provider_transaction_id).sort()).toEqual([
        'p-gas',
        's-a',
        's-b',
        's-coffee',
        's-dinner',
        's-gas',
        's-lone-1',
        's-lone-2',
      ]);
      expect(now.find((r) => r.provider_transaction_id === 's-dinner')).toMatchObject({
        category_id: null,
      });
      // The tip's pending one, with its edits, was dropped as the bank removed it.
      expect((await rows(b.householdId)).find((r) => r.id === tipId)).toMatchObject({
        deleted_at: expect.any(Date),
        provider_removed_at: expect.any(Date),
      });

      // Its pending one leaves the window: the posted one that came in meanwhile is it.
      const gasCopy = (await byProviderId(b.householdId, 's-gas'))!.id;
      await syncAgain(b, provider);
      expect(await byProviderId(b.householdId, 's-gas')).toMatchObject({
        id: gasId,
        provider_pending_id: 'p-gas',
        deleted_at: null,
        pending: false,
      });
      expect(await notes(b, gasId)).toEqual([{ author: null, body: 'Road trip' }]);
      expect((await rows(b.householdId)).find((r) => r.id === gasCopy)).toMatchObject({
        provider_transaction_id: null,
        deleted_at: expect.any(Date),
      });
      expect((await live(b.householdId)).length).toBe(7);
      expect((await history(b, coffeeId)).map((e) => e.action)).toEqual([
        'sync.transactions_added',
        'transaction.posted',
      ]);
    });
  });
});
