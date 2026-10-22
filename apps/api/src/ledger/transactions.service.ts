// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import {
  accountOwners,
  accounts,
  categories,
  type Executor,
  householdMembers,
  households,
  tags,
  transactionAttributions,
  transactionNotes,
  transactions,
  transactionTags,
} from '@fiscus/db';
import {
  accessLevels,
  businessDaysApart,
  detectAround,
  detectTransfers,
  type HouseholdRanges,
  householdRanges,
  linkable,
  linkTransfers,
  recomputeBalances,
  SUGGEST_WINDOW_DAYS,
  TRANSFER_WINDOW_BUSINESS_DAYS,
  transactionDate,
  transferCategories,
  transferReview,
  type TransferReviewIds,
  unlinkTransfers,
} from '@fiscus/ledger';
import { planVersionedPatch } from '@fiscus/domain';
import type {
  AccessLevel,
  AttributionInput,
  BulkUpdateResult,
  bulkUpdateTransactionsSchema,
  createTransactionSchema,
  linkTransferPairsSchema,
  linkTransferSchema,
  LinkTransfersResult,
  unlinkTransferGroupsSchema,
  moveTransactionsSchema,
  NameCleanup,
  NameCleanupPreview,
  setSplitsSchema,
  RangeMeta,
  ReviewCount,
  Transaction,
  TransferCounterpart,
  TransferReview,
  TransferReviewTransaction,
  transactionsQuerySchema,
  TransactionSort,
  undoNameCleanupSchema,
  updateTransactionSchema,
} from '@fiscus/shared';
import { cleanMerchantName } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { type HouseholdActivity, HouseholdScope } from '../households/household-scope.js';
import { resolveParams } from '../ranges/household-ranges.js';
import { spendingLensFilter } from '../visibility/visibility-scope.js';

type Row = typeof transactions.$inferSelect;
type Query = z.infer<typeof transactionsQuerySchema>;
type CreateInput = z.infer<typeof createTransactionSchema>;
type UpdateInput = z.infer<typeof updateTransactionSchema>;
type BulkInput = z.infer<typeof bulkUpdateTransactionsSchema>;
type MoveInput = z.infer<typeof moveTransactionsSchema>;
type SplitsInput = z.infer<typeof setSplitsSchema>;
type LinkInput = z.infer<typeof linkTransferSchema>;
type LinkPairsInput = z.infer<typeof linkTransferPairsSchema>;
type LinkRefusal = LinkTransfersResult['refused'][number]['code'];

/** A link by hand refused, as the problem it answers (all but `forbidden` and `not_found`). */
const LINK_PROBLEMS: Record<Exclude<LinkRefusal, 'forbidden' | 'not_found'>, () => Problem> = {
  already_linked: () =>
    new Problem(
      409,
      'already_linked',
      'Already part of a transfer',
      'Unlink it first, then link it again.',
    ),
  not_editable: () =>
    new Problem(
      422,
      'not_editable',
      'Split or pending transactions can’t be linked',
      'Remove the split first.',
    ),
  same_account: () => new Problem(422, 'same_account', 'A transfer goes between two accounts'),
  not_opposite: () =>
    new Problem(
      422,
      'not_opposite',
      'The two sides don’t match',
      'A transfer is money out of one account and the same amount into another.',
    ),
};

/** What the caller may see and do, computed once per request. */
interface Access {
  /** Viewers may read only (permissions §2). */
  viewer: boolean;
  /** Which date transactions count on (#69), and the household's range settings. */
  dateBasis: 'posted' | 'authorized';
  ranges: HouseholdRanges;
  levels: Map<string, AccessLevel>;
  /** transaction id → payers, for purchases attributed to the caller (F1). */
  attributedPayers: Map<string, string[]>;
}

interface Permissions {
  categorize: boolean;
  edit: boolean;
  attribute: boolean;
  writeSharedNote: boolean;
  transfer: boolean;
}

const ZERO_PERMISSIONS: Permissions = {
  categorize: false,
  edit: false,
  attribute: false,
  writeSharedNote: false,
  transfer: false,
};

const forbidden = (detail: string) => problems.forbidden(detail);

/** How a note is bound for encryption: to its household, row, and author (also used by imports). */
export const transactionNoteContext = (
  householdId: string,
  transactionId: string,
  author: string | null,
) => ({
  householdId,
  table: 'transaction_notes',
  column: 'body_enc',
  rowId: `${transactionId}:${author ?? 'shared'}`,
});

/**
 * Records fields a person set, in the next version. `field_versions` is both the edit-conflict
 * record (first save wins per field) and how rules know not to touch a field (imports.md §3).
 */
export const markPersonSet = (fields: string[]) =>
  sql`${transactions.fieldVersions} || jsonb_build_object(${sql.join(
    fields.map((f) => sql`${f}::text, ${transactions.version} + 1`),
    sql`, `,
  )})`;

/** Equal shares in basis points; the first member takes the remainder. */
function equalShares(count: number): number[] {
  const base = Math.floor(10000 / count);
  return Array.from({ length: count }, (_, i) => (i === 0 ? 10000 - base * (count - 1) : base));
}

const encodeCursor = (date: string, id: string) =>
  Buffer.from(JSON.stringify([date, id])).toString('base64url');

const invalidCursor = () =>
  new Problem(422, 'invalid_cursor', 'Invalid page cursor', 'Start again from the first page.');

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);

function decodeCursor(cursor: string): [string, string] {
  try {
    const [date, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown[];
    if (isDate(date) && isId(id)) return [date, id];
  } catch {
    // fall through
  }
  throw invalidCursor();
}

/** Sorted by another column (#351), a page ends at its sort value, then its date and id. */
type SortedCursor = [sort: TransactionSort, key: string | number, date: string, id: string];

const encodeSortedCursor = (...c: SortedCursor) =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeSortedCursor(cursor: string, sort: TransactionSort): SortedCursor {
  try {
    const [s, key, date, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown[];
    const keyOk = sort === 'amount' ? Number.isSafeInteger(key) : typeof key === 'string';
    if (s === sort && keyOk && isDate(date) && isId(id)) {
      return [sort, key as string | number, date, id];
    }
  } catch {
    // fall through
  }
  throw invalidCursor();
}

/** Escapes LIKE wildcards in search text. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

@Injectable()
export class TransactionsService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────────────────────

  async list(
    ctx: HouseholdContext,
    q: Query,
  ): Promise<{ data: Transaction[]; nextCursor: string | null; range: RangeMeta | null }> {
    return this.scope.run(ctx, async (tx) => {
      const access = await this.#access(tx, ctx);
      const dateColumn = transactionDate(access.dateBasis);
      const earliest = q.range === 'all_time' ? await this.#earliest(tx, dateColumn) : undefined;
      const resolved = resolveParams(q, access.ranges, earliest);
      const from = resolved?.range.from ?? q.from;
      const to = resolved?.range.to ?? q.to;
      const where: (SQL | undefined)[] = [
        eq(transactions.householdId, ctx.householdId),
        isNull(transactions.deletedAt),
        // Split parents are represented by their parts, so totals and lists agree.
        eq(transactions.hasSplits, false),
        q.accounts ? inArray(transactions.accountId, q.accounts) : undefined,
        q.categories ? inArray(transactions.categoryId, q.categories) : undefined,
        q.tags
          ? sql`EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = ${transactions.id}
                        AND tt.tag_id = ANY(${sql.param(q.tags)}::uuid[]))`
          : undefined,
        from ? gte(dateColumn, from) : undefined,
        to ? lte(dateColumn, to) : undefined,
        q.q
          ? or(
              ilike(transactions.displayName, `%${likeEscape(q.q)}%`),
              ilike(transactions.originalDescription, `%${likeEscape(q.q)}%`),
            )
          : undefined,
        q.minAmount !== undefined ? gte(transactions.amountMinor, q.minAmount) : undefined,
        q.maxAmount !== undefined ? lte(transactions.amountMinor, q.maxAmount) : undefined,
        q.review ? eq(transactions.reviewStatus, q.review) : undefined,
        q.includeExcluded === 'false' ? eq(transactions.excluded, false) : undefined,
        await spendingLensFilter(tx, ctx, q.lens),
      ];
      if (q.sort !== 'date') {
        const sorted = await this.#sortedPage(tx, ctx, access, q, where, dateColumn);
        return {
          data: await this.#present(tx, ctx, access, sorted.page),
          nextCursor: sorted.nextCursor,
          range: resolved?.meta ?? null,
        };
      }
      const oldest = (q.direction ?? (q.order === 'oldest' ? 'asc' : 'desc')) === 'asc';
      if (q.cursor) {
        const [date, id] = decodeCursor(q.cursor);
        where.push(
          oldest
            ? sql`(${dateColumn}, ${transactions.id}) > (${date}::date, ${id}::uuid)`
            : sql`(${dateColumn}, ${transactions.id}) < (${date}::date, ${id}::uuid)`,
        );
      }
      const direction = oldest ? asc : desc;
      const rows = await tx
        .select()
        .from(transactions)
        .where(and(...where))
        .orderBy(direction(dateColumn), direction(transactions.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        data: await this.#present(tx, ctx, access, page),
        nextCursor:
          rows.length > q.limit
            ? encodeCursor(
                access.dateBasis === 'authorized'
                  ? page.at(-1)!.effectiveAuthorizedDate
                  : page.at(-1)!.effectiveDate,
                page.at(-1)!.id,
              )
            : null,
        range: resolved?.meta ?? null,
      };
    });
  }

  /**
   * How many transactions wait in your review queue (#44): needing review, in accounts where you
   * can categorize. The navigation shows it as a badge.
   */
  async reviewCount(ctx: HouseholdContext): Promise<ReviewCount> {
    return this.scope.run(ctx, async (tx) => {
      const none = { count: 0, transactions: 0, transfers: 0 };
      if (ctx.role === 'viewer') return none;
      const access = await this.#access(tx, ctx);
      const accountIds = [...access.levels]
        .filter(([, l]) => l === 'owner' || l === 'full')
        .map(([id]) => id);
      if (accountIds.length === 0) return none;
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(transactions)
        .where(
          and(
            eq(transactions.reviewStatus, 'needs_review'),
            isNull(transactions.deletedAt),
            eq(transactions.hasSplits, false),
            inArray(transactions.accountId, accountIds),
          ),
        );
      const review = await this.#transferReview(tx, access);
      const transfers = review.suggested.size + review.unmatched.length;
      const count = row?.count ?? 0;
      return { count: count + transfers, transactions: count, transfers };
    });
  }

  /**
   * The transfer review (transfers.md §2): suggested pairs to link, and transfers with no other
   * side, in accounts you own. Worked out on request.
   */
  async transferReview(ctx: HouseholdContext): Promise<TransferReview> {
    return this.scope.run(ctx, async (tx) => {
      const access = await this.#access(tx, ctx);
      const review = await this.#transferReview(tx, access);
      // Enough for a large import's review (#332); the page groups them by account.
      const suggested = [...review.suggested].slice(0, 1000);
      const unmatched = review.unmatched.slice(0, 1000);
      const rivalsOf = (out: string) => review.rivals.get(out) ?? [];
      const ids = [
        ...new Set([
          ...suggested.flat(2),
          ...suggested.flatMap(([out]) => rivalsOf(out)),
          ...unmatched,
        ]),
      ];
      const rows = ids.length
        ? await tx.select().from(transactions).where(inArray(transactions.id, ids))
        : [];
      // Only what a row shows: a large review is about a thousand of them (#332).
      const shown = new Map(
        (await this.#present(tx, ctx, access, rows)).map((t) => [
          t.id,
          {
            id: t.id,
            date: t.date,
            amountMinor: t.amountMinor,
            currency: t.currency,
            displayName: t.displayName,
            categoryId: t.categoryId,
            // Accounts you own, so always named.
            account: { id: t.account!.id, name: t.account!.name },
            version: t.version,
          } satisfies TransferReviewTransaction,
        ]),
      );
      const unique = new Set(review.unique.map(([out]) => out.id));
      return {
        suggested: suggested.map(([out, intos]) => {
          const transaction = shown.get(out)!;
          const candidates = intos.map((id) => shown.get(id)!);
          const rivals = rivalsOf(out).map((id) => shown.get(id)!);
          const reason = review.identical.has(out)
            ? ('identical' as const)
            : candidates.length > 1
              ? ('several' as const)
              : rivals.length
                ? ('rivals' as const)
                : businessDaysApart(transaction.date, candidates[0]!.date) >
                    TRANSFER_WINDOW_BUSINESS_DAYS
                  ? ('far_apart' as const)
                  : ('one_match' as const);
          return { transaction, candidates, rivals, unique: unique.has(out), reason };
        }),
        unmatched: unmatched.map((id) => shown.get(id)!),
        counts: {
          suggested: review.suggested.size,
          unmatched: review.unmatched.length,
          unique: review.unique.length,
        },
      };
    });
  }

  /** "Link all": every suggested pair with exactly one candidate either way (TXN-08). */
  async linkAllTransfers(ctx: HouseholdContext): Promise<{ linked: number; groups: string[] }> {
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      if (access.viewer) throw forbidden('Viewers can’t link transfers.');
      const review = await this.#transferReview(tx, access);
      const groups = await linkTransfers(
        tx,
        activity,
        review.unique,
        await transferCategories(tx),
        false,
      );
      return { linked: review.unique.length, groups };
    });
  }

  /**
   * Possible other legs for linking a transfer by hand: the opposite amount in another account
   * you own, closest date first. Wider than detection's window, since a person is choosing.
   */
  async transferCandidates(ctx: HouseholdContext, id: string): Promise<Transaction[]> {
    return this.scope.run(ctx, async (tx) => {
      const access = await this.#access(tx, ctx);
      const row = await this.#visible(tx, id);
      if (!this.#permissions(row, access).transfer || !linkable(row)) return [];
      const owned = [...access.levels]
        .filter(([accountId, l]) => l === 'owner' && accountId !== row.accountId)
        .map(([accountId]) => accountId);
      if (owned.length === 0) return [];
      const days = SUGGEST_WINDOW_DAYS;
      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(
            inArray(transactions.accountId, owned),
            eq(transactions.amountMinor, -row.amountMinor),
            eq(transactions.currency, row.currency),
            isNull(transactions.transferGroupId),
            isNull(transactions.deletedAt),
            isNull(transactions.parentId),
            eq(transactions.hasSplits, false),
            eq(transactions.pending, false),
            sql`${transactions.effectiveDate} BETWEEN ${row.effectiveDate}::date - ${days}::int
                AND ${row.effectiveDate}::date + ${days}::int`,
          ),
        )
        .orderBy(
          sql`abs(${transactions.effectiveDate} - ${row.effectiveDate}::date)`,
          asc(transactions.id),
        )
        .limit(10);
      return this.#present(tx, ctx, access, rows);
    });
  }

  async get(ctx: HouseholdContext, id: string): Promise<Transaction> {
    return this.scope.run(ctx, async (tx) => {
      const access = await this.#access(tx, ctx);
      const row = await this.#visible(tx, id);
      return (await this.#present(tx, ctx, access, [row]))[0]!;
    });
  }

  // ── Writes ───────────────────────────────────────────────────────────────────────────────

  /** TXN-02: owners of the account add manual transactions. */
  async create(ctx: HouseholdContext, input: CreateInput): Promise<Transaction> {
    const id = uuidv7();
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const level = access.levels.get(input.accountId);
      if (level !== 'owner') {
        throw level
          ? forbidden('Only the account’s owners can add transactions.')
          : problems.notFound();
      }
      const [account] = await tx
        .select({ currency: accounts.currency })
        .from(accounts)
        .where(eq(accounts.id, input.accountId));
      await this.#checkCategory(tx, input.categoryId ?? null);
      await this.#checkTags(tx, input.tagIds ?? []);
      await tx.insert(transactions).values({
        id,
        householdId: ctx.householdId,
        accountId: input.accountId,
        amountMinor: input.amountMinor,
        currency: account!.currency,
        authorizedDate: input.date,
        postedDate: input.date,
        originalDescription: input.displayName,
        displayName: input.displayName,
        categoryId: input.categoryId ?? null,
        reviewStatus: 'reviewed', // you entered it yourself
        source: 'manual',
        // You chose these: rules leave them alone.
        fieldVersions: Object.fromEntries(
          [
            'displayName',
            ...(input.categoryId ? ['categoryId'] : []),
            ...(input.tagIds?.length ? ['tagIds'] : []),
            ...(input.attribution?.length ? ['attribution'] : []),
          ].map((f) => [f, 1]),
        ),
      });
      if (input.tagIds?.length) {
        await tx.insert(transactionTags).values(
          input.tagIds.map((tagId) => ({
            transactionId: id,
            tagId,
            householdId: ctx.householdId,
          })),
        );
      }
      if (input.attribution?.length) {
        await this.#writeAttribution(tx, ctx, id, input.attribution);
      }
      await recomputeBalances(tx, input.accountId);
      // Recorded first, so its history starts with being added and the link comes after.
      await activity.record({
        action: 'transaction.created',
        targetType: 'transaction',
        targetId: id,
        accountId: input.accountId,
        transactionIds: [id],
        changes: {
          after: {
            amountMinor: input.amountMinor,
            date: input.date,
            displayName: input.displayName,
          },
        },
      });
      // A transfer you entered by hand finds its other leg as an import's would (#40).
      await detectTransfers(tx, activity, [id], access.levels);
      const row = await this.#visible(tx, id);
      return (await this.#present(tx, ctx, await this.#access(tx, ctx), [row]))[0]!;
    });
  }

  /**
   * Edits, checked field by field (TXN-03/04/05, #281): categorizing needs owner or full
   * access; amount, date, exclusion, and business need ownership. First save wins per field.
   */
  async update(
    ctx: HouseholdContext,
    id: string,
    baseVersion: number,
    patch: UpdateInput,
  ): Promise<Transaction> {
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const row = await this.#visible(tx, id, true);
      const can = this.#permissions(row, access);
      const needsEdit = ['amountMinor', 'date', 'excluded', 'isBusiness'].some((f) => f in patch);
      const needsCategorize = [
        'displayName',
        'categoryId',
        'reviewStatus',
        'tagIds',
        'transferExternal',
      ].some((f) => f in patch);
      if ((needsEdit && !can.edit) || (needsCategorize && !can.categorize)) {
        throw forbidden(
          needsEdit
            ? 'Only the account’s owners can change the amount, date, or exclusion.'
            : 'You can view this transaction but not categorize it.',
        );
      }
      if (patch.amountMinor !== undefined && row.source !== 'manual') {
        throw new Problem(
          422,
          'not_editable',
          'The bank’s amount can’t be changed',
          'Split the transaction instead, or add an adjustment.',
        );
      }
      if (patch.date === null && row.source === 'manual') {
        throw new Problem(422, 'date_required', 'A manual transaction needs a date');
      }

      const currentTags = await this.#tagIds(tx, [id]);
      const tagKey = (ids: string[]) => [...ids].sort().join(',');
      const current = {
        displayName: row.displayName,
        amountMinor: row.amountMinor,
        date: row.source === 'manual' ? row.authorizedDate : row.dateOverride,
        categoryId: row.categoryId,
        reviewStatus: row.reviewStatus,
        excluded: row.excluded,
        isBusiness: row.isBusiness,
        tagIds: tagKey(currentTags.get(id) ?? []),
        transferExternal: row.transferExternal,
      };
      const { tagIds, ...rest } = patch;
      // Deciding the category is usually the review (the household can turn this off).
      if (
        rest.categoryId !== undefined &&
        rest.categoryId !== row.categoryId &&
        rest.reviewStatus === undefined &&
        row.reviewStatus === 'needs_review' &&
        (await this.#categorizeMarksReviewed(tx, ctx))
      ) {
        rest.reviewStatus = 'reviewed';
      }
      const plan = planVersionedPatch(
        current,
        { version: row.version, fieldVersions: row.fieldVersions },
        baseVersion,
        { ...rest, ...(tagIds ? { tagIds: tagKey(tagIds) } : {}) },
      );
      if (!plan.ok) {
        throw new Problem(
          409,
          'edit_conflict',
          'Someone else changed this first',
          'Reload to see their changes, then apply yours again if still needed.',
          undefined,
          {},
          { conflicts: plan.conflicts },
        );
      }
      const changes = plan.changes;
      const changed = Object.keys(changes);
      if (changed.length === 0) return (await this.#present(tx, ctx, access, [row]))[0]!;

      if (changes.categoryId !== undefined)
        await this.#checkCategory(tx, changes.categoryId ?? null);
      const { tagIds: newTags, date, ...columns } = changes;
      const dateColumns =
        date === undefined
          ? {}
          : row.source === 'manual'
            ? { authorizedDate: date!, postedDate: date! }
            : { dateOverride: date ?? null };
      await tx
        .update(transactions)
        .set({
          ...columns,
          ...dateColumns,
          version: plan.next.version,
          fieldVersions: plan.next.fieldVersions,
        })
        .where(and(eq(transactions.id, id), eq(transactions.version, row.version)));
      if (newTags !== undefined) {
        const ids = (newTags as string).split(',').filter(Boolean);
        await this.#checkTags(tx, ids);
        await tx.delete(transactionTags).where(eq(transactionTags.transactionId, id));
        if (ids.length) {
          await tx
            .insert(transactionTags)
            .values(
              ids.map((tagId) => ({ transactionId: id, tagId, householdId: ctx.householdId })),
            );
        }
      }
      if (changes.amountMinor !== undefined || date !== undefined) {
        await recomputeBalances(tx, row.accountId);
      }
      await activity.record({
        action: 'transaction.updated',
        targetType: 'transaction',
        targetId: id,
        accountId: row.accountId,
        transactionIds: [id],
        metadata: { fields: changed },
        changes: {
          before: Object.fromEntries(changed.map((k) => [k, current[k as keyof typeof current]])),
          after: changes,
        },
      });
      return (await this.#present(tx, ctx, access, [await this.#visible(tx, id)]))[0]!;
    });
  }

  /** TXN-02: owners delete (a soft delete; manual transactions are purged after 30 days). */
  async remove(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const row = await this.#visible(tx, id, true);
      if (!this.#permissions(row, access).edit)
        throw forbidden('Only the account’s owners can delete it.');
      if (row.parentId) {
        throw new Problem(409, 'split_part', 'Delete the whole transaction, or remove the split');
      }
      const now = new Date();
      const removed = await tx
        .update(transactions)
        .set({ deletedAt: now, version: row.version + 1 })
        .where(or(eq(transactions.id, id), eq(transactions.parentId, id)))
        .returning({ id: transactions.id });
      // The other leg of a transfer stands alone again.
      if (row.transferGroupId) {
        await unlinkTransfers(tx, activity, [row.transferGroupId], 'deleted');
      }
      await recomputeBalances(tx, row.accountId);
      await activity.record({
        action: 'transaction.deleted',
        targetType: 'transaction',
        targetId: id,
        accountId: row.accountId,
        transactionIds: removed.map((r) => r.id),
      });
    });
  }

  /** Bulk categorize, review, tag, or exclude. Each row is allowed or refused on its own. */
  async bulkUpdate(ctx: HouseholdContext, input: BulkInput): Promise<BulkUpdateResult> {
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const { changes } = input;
      if (changes.categoryId !== undefined) await this.#checkCategory(tx, changes.categoryId);
      await this.#checkTags(tx, [...(changes.addTagIds ?? []), ...(changes.removeTagIds ?? [])]);
      const rows = await tx
        .select()
        .from(transactions)
        .where(and(inArray(transactions.id, input.ids), isNull(transactions.deletedAt)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const result: BulkUpdateResult = { updated: [], refused: [] };
      const byAccount = new Map<string, string[]>();
      for (const id of input.ids) {
        const row = byId.get(id);
        if (!row) {
          result.refused.push({ id, code: 'not_found' });
          continue;
        }
        const can = this.#permissions(row, access);
        const needsEdit = changes.excluded !== undefined;
        if (!can.categorize || (needsEdit && !can.edit)) {
          result.refused.push({ id, code: 'forbidden' });
          continue;
        }
        if (row.hasSplits && changes.categoryId !== undefined) {
          result.refused.push({ id, code: 'not_editable' }); // categorize the parts instead
          continue;
        }
        result.updated.push(id);
        byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), id]);
      }
      if (result.updated.length === 0) return result;

      const marksReviewed =
        changes.categoryId !== undefined &&
        !changes.reviewStatus &&
        (await this.#categorizeMarksReviewed(tx, ctx));
      const columns = {
        ...(changes.categoryId !== undefined ? { categoryId: changes.categoryId } : {}),
        ...(changes.reviewStatus ? { reviewStatus: changes.reviewStatus } : {}),
        ...(marksReviewed ? { reviewStatus: 'reviewed' as const } : {}),
        ...(changes.excluded !== undefined ? { excluded: changes.excluded } : {}),
        ...(changes.transferExternal !== undefined
          ? { transferExternal: changes.transferExternal }
          : {}),
      };
      if (Object.keys(columns).length) {
        await tx
          .update(transactions)
          .set({
            ...columns,
            fieldVersions: markPersonSet(Object.keys(columns)),
            version: sql`${transactions.version} + 1`,
          })
          .where(inArray(transactions.id, result.updated));
      }
      if (changes.addTagIds?.length || changes.removeTagIds?.length) {
        await tx
          .update(transactions)
          .set({
            fieldVersions: markPersonSet(['tagIds']),
            version: sql`${transactions.version} + 1`,
          })
          .where(inArray(transactions.id, result.updated));
      }
      if (changes.removeTagIds?.length) {
        await tx
          .delete(transactionTags)
          .where(
            and(
              inArray(transactionTags.transactionId, result.updated),
              inArray(transactionTags.tagId, changes.removeTagIds),
            ),
          );
      }
      if (changes.addTagIds?.length) {
        await tx
          .insert(transactionTags)
          .values(
            result.updated.flatMap((transactionId) =>
              changes.addTagIds!.map((tagId) => ({
                transactionId,
                tagId,
                householdId: ctx.householdId,
              })),
            ),
          )
          .onConflictDoNothing();
      }
      // One event per account, so each is visible only to members who can see that account.
      for (const [accountId, ids] of byAccount) {
        await activity.record({
          action: 'transaction.bulk_updated',
          targetType: 'account',
          targetId: accountId,
          accountId,
          metadata: { count: ids.length, fields: Object.keys(changes) },
          transactionIds: ids,
          changes: {
            after: { ids, ...changes, ...(marksReviewed ? { reviewStatus: 'reviewed' } : {}) },
          },
        });
      }
      return result;
    });
  }

  /**
   * #42: names that are still the bank's text (no person or rule renamed them), and the cleaner
   * name for each, among transactions you can categorize. The original description stays as is.
   */
  async #nameCleanups(tx: Executor, access: Access) {
    const rows = await tx
      .select()
      .from(transactions)
      .where(
        and(
          isNull(transactions.deletedAt),
          isNull(transactions.parentId),
          sql`${transactions.displayName} = ${transactions.originalDescription}`,
        ),
      )
      .orderBy(desc(transactions.effectiveDate), desc(transactions.id));
    return (
      rows
        // Typed in by hand, the name is a person's own, whatever it looks like.
        .filter(
          (r) =>
            r.source !== 'manual' &&
            !('displayName' in r.fieldVersions) &&
            this.#permissions(r, access).categorize,
        )
        .map((row) => ({ row, to: cleanMerchantName(row.originalDescription) }))
        .filter(({ row, to }) => to && to !== row.displayName)
    );
  }

  async nameCleanupPreview(ctx: HouseholdContext): Promise<NameCleanupPreview> {
    return this.scope.run(ctx, async (tx) => {
      const all = await this.#nameCleanups(tx, await this.#access(tx, ctx));
      return {
        total: all.length,
        changes: all.slice(0, 200).map(({ row, to }) => ({
          id: row.id,
          date: row.effectiveDate,
          amountMinor: row.amountMinor,
          currency: row.currency,
          from: row.displayName,
          to,
        })),
      };
    });
  }

  /** Cleans up every name the preview lists. Not marked as set by a person: rules still apply. */
  async cleanNames(ctx: HouseholdContext): Promise<NameCleanup[]> {
    return this.scope.run(ctx, async (tx, activity) => {
      const all = await this.#nameCleanups(tx, await this.#access(tx, ctx));
      const changes = all.map(({ row, to }) => ({ id: row.id, from: row.displayName, to }));
      await this.#rename(tx, activity, changes, 'from', 'to');
      return all.map(({ row, to }) => ({
        id: row.id,
        date: row.effectiveDate,
        amountMinor: row.amountMinor,
        currency: row.currency,
        from: row.displayName,
        to,
      }));
    });
  }

  /** Undo for cleanNames: names still as the cleanup left them go back. */
  async undoCleanNames(
    ctx: HouseholdContext,
    input: z.infer<typeof undoNameCleanupSchema>,
  ): Promise<{ restored: number }> {
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      if (input.changes.length === 0) return { restored: 0 };
      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(
            inArray(
              transactions.id,
              input.changes.map((c) => c.id),
            ),
            isNull(transactions.deletedAt),
          ),
        );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const allowed = input.changes.filter((c) => {
        const row = byId.get(c.id);
        return (
          row &&
          row.displayName === c.to &&
          row.originalDescription === c.from &&
          !('displayName' in row.fieldVersions) &&
          this.#permissions(row, access).categorize
        );
      });
      const restored = await this.#rename(tx, activity, allowed, 'to', 'from');
      return { restored };
    });
  }

  /**
   * Sets names in one statement, only where they're still `whereWas`, and records one event per
   * account. Returns how many changed.
   */
  async #rename(
    tx: Executor,
    activity: HouseholdActivity,
    changes: { id: string; from: string; to: string }[],
    whereWas: 'from' | 'to',
    setTo: 'from' | 'to',
  ): Promise<number> {
    if (changes.length === 0) return 0;
    const list = JSON.stringify(
      changes.map((c) => ({ id: c.id, was: c[whereWas], name: c[setTo] })),
    );
    const updated = await tx.execute(sql`
      UPDATE transactions AS t
      SET display_name = v.name, version = t.version + 1
      FROM jsonb_to_recordset(${list}::jsonb) AS v(id uuid, was text, name text)
      WHERE t.id = v.id AND t.display_name = v.was
      RETURNING t.id, t.account_id`);
    const byAccount = new Map<string, string[]>();
    for (const r of updated.rows as { id: string; account_id: string }[]) {
      byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r.id]);
    }
    const byId = new Map(changes.map((c) => [c.id, c]));
    const names = (ids: string[], side: 'from' | 'to') =>
      Object.fromEntries(ids.map((id) => [id, byId.get(id)![side]]));
    for (const [accountId, ids] of byAccount) {
      await activity.record({
        action: 'transaction.bulk_updated',
        targetType: 'account',
        targetId: accountId,
        accountId,
        metadata: { count: ids.length, fields: ['displayName'], via: 'name_cleanup' },
        transactionIds: ids,
        // Each one's name before and after, for its history (#46).
        changes: {
          before: { names: names(ids, whereWas) },
          after: { ids, names: names(ids, setTo) },
        },
      });
    }
    return updated.rows.length;
  }

  /** ATT-01/02: owners of the paying account say who it's for. `[]` inherits from the owners. */
  /**
   * TXN-12: moves transactions to another account, each checked on its own. Needs ownership of
   * both accounts and the same currency; a split moves with all its parts. Bank-synced rows stay
   * with their bank (M2).
   */
  async move(ctx: HouseholdContext, input: MoveInput): Promise<BulkUpdateResult> {
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const level = access.levels.get(input.accountId);
      if (access.viewer || level !== 'owner') {
        throw level
          ? forbidden('You can only move transactions into accounts you own.')
          : problems.notFound();
      }
      const [target] = await tx
        .select({ currency: accounts.currency })
        .from(accounts)
        .where(eq(accounts.id, input.accountId));
      const rows = await tx
        .select()
        .from(transactions)
        .where(and(inArray(transactions.id, input.ids), isNull(transactions.deletedAt)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      // Imported rows can't land where the same row was already imported.
      const keys = rows.filter((r) => r.dedupeKey).map((r) => r.dedupeKey!);
      const taken = new Set(
        keys.length
          ? (
              await tx
                .select({ key: transactions.dedupeKey })
                .from(transactions)
                .where(
                  and(
                    eq(transactions.accountId, input.accountId),
                    eq(transactions.source, 'import'),
                    inArray(transactions.dedupeKey, keys),
                  ),
                )
            ).map((r) => r.key)
          : [],
      );
      const result: BulkUpdateResult = { updated: [], refused: [] };
      const from = new Map<string, string[]>();
      for (const id of input.ids) {
        const row = byId.get(id);
        if (!row) {
          result.refused.push({ id, code: 'not_found' });
          continue;
        }
        if (row.accountId === input.accountId) continue; // already there
        if (!this.#permissions(row, access).edit) {
          result.refused.push({ id, code: 'forbidden' });
          continue;
        }
        if (row.parentId || row.source === 'provider') {
          // A part moves with its whole purchase; the bank feed owns synced rows.
          result.refused.push({ id, code: 'not_editable' });
          continue;
        }
        if (row.currency !== target!.currency) {
          result.refused.push({ id, code: 'different_currency' });
          continue;
        }
        if (row.dedupeKey && taken.has(row.dedupeKey)) {
          result.refused.push({ id, code: 'already_there' });
          continue;
        }
        result.updated.push(id);
        from.set(row.accountId, [...(from.get(row.accountId) ?? []), id]);
      }
      if (result.updated.length === 0) return result;

      await tx
        .update(transactions)
        .set({ accountId: input.accountId, version: sql`${transactions.version} + 1` })
        .where(
          or(
            inArray(transactions.id, result.updated),
            inArray(transactions.parentId, result.updated),
          ),
        );
      // A transfer whose legs now share an account isn't one any more.
      const groups = rows
        .filter((r) => r.transferGroupId && result.updated.includes(r.id))
        .map((r) => r.transferGroupId!);
      if (groups.length) {
        const sameAccount = await tx
          .select({ group: transactions.transferGroupId })
          .from(transactions)
          .where(
            and(
              inArray(transactions.transferGroupId, groups),
              isNull(transactions.deletedAt),
              eq(transactions.accountId, input.accountId),
            ),
          )
          .groupBy(transactions.transferGroupId)
          .having(sql`count(*) > 1`);
        await unlinkTransfers(
          tx,
          activity,
          sameAccount.map((g) => g.group!),
          'moved',
        );
      }
      for (const [accountId, ids] of from) {
        await recomputeBalances(tx, accountId);
        // One event per account, so each is visible only to members who can see that account.
        // Not part of the transactions' history: moved_in is, in the account they're in now.
        await activity.record({
          action: 'transaction.moved_out',
          targetType: 'account',
          targetId: accountId,
          accountId,
          metadata: { count: ids.length, to: input.accountId },
          changes: { after: { ids } },
        });
      }
      await recomputeBalances(tx, input.accountId);
      await activity.record({
        action: 'transaction.moved_in',
        targetType: 'account',
        targetId: input.accountId,
        accountId: input.accountId,
        metadata: { count: result.updated.length, from: [...from.keys()] },
        transactionIds: result.updated,
        changes: { after: { ids: result.updated } },
      });
      return result;
    });
  }

  /**
   * TXN-08: links a transaction to the other leg of a transfer. Needs ownership of both legs, in
   * different accounts, for opposite amounts in the same currency.
   */
  /** Links two transactions by hand; `settled` counts the other pairs that left clear (#332). */
  async linkTransfer(
    ctx: HouseholdContext,
    id: string,
    input: LinkInput,
  ): Promise<{ transaction: Transaction; settled: number; groups: string[] }> {
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const a = await this.#visible(tx, id, true);
      const b = await this.#visible(tx, input.transactionId, true);
      const refusal = this.#linkRefusal(a, b, access);
      if (refusal === 'forbidden') {
        throw forbidden('Linking a transfer needs ownership of both accounts.');
      }
      if (refusal) throw LINK_PROBLEMS[refusal]();
      const linked = await linkTransfers(
        tx,
        activity,
        [[a, b]],
        await transferCategories(tx),
        false,
      );
      const settled = await detectAround(tx, activity, [a, b], access.levels);
      const [transaction] = await this.#present(tx, ctx, access, [await this.#visible(tx, id)]);
      return {
        transaction: transaction!,
        settled: settled.length,
        groups: [...linked, ...settled],
      };
    });
  }

  /**
   * Links the pairs a person confirmed in the review (#332), as one change: each checked as a
   * link by hand is, refused ones reported rather than failing the rest, then what they settle.
   */
  async linkTransferPairs(
    ctx: HouseholdContext,
    input: LinkPairsInput,
  ): Promise<LinkTransfersResult> {
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      if (access.viewer) throw forbidden('Viewers can’t link transfers.');
      const ids = input.pairs.flatMap((p) => [p.out, p.into]);
      const rows = new Map(
        (
          await tx
            .select()
            .from(transactions)
            .where(and(inArray(transactions.id, ids), isNull(transactions.deletedAt)))
        ).map((r) => [r.id, r]),
      );
      const refused: LinkTransfersResult['refused'] = [];
      const pairs: [Row, Row][] = [];
      const taken = new Set<string>();
      for (const p of input.pairs) {
        const a = rows.get(p.out);
        const b = rows.get(p.into);
        // Rows outside your access read as missing, as a link by hand does.
        if (!a || !b || !access.levels.has(a.accountId) || !access.levels.has(b.accountId)) {
          refused.push({ id: p.out, code: 'not_found' });
          continue;
        }
        const code =
          taken.has(a.id) || taken.has(b.id) ? 'already_linked' : this.#linkRefusal(a, b, access);
        if (code) {
          refused.push({ id: p.out, code });
          continue;
        }
        taken.add(a.id).add(b.id);
        pairs.push([a, b]);
      }
      const linked = await linkTransfers(tx, activity, pairs, await transferCategories(tx), false);
      const settled = await detectAround(tx, activity, pairs.flat(), access.levels);
      return {
        linked: pairs.length,
        settled: settled.length,
        groups: [...linked, ...settled],
        refused,
      };
    });
  }

  /** Why two transactions can't be linked as a transfer by this person, if they can't. */
  #linkRefusal(a: Row, b: Row, access: Access): Exclude<LinkRefusal, 'not_found'> | null {
    if (!this.#permissions(a, access).transfer || !this.#permissions(b, access).transfer) {
      return 'forbidden';
    }
    if (a.transferGroupId || b.transferGroupId) return 'already_linked';
    if (!linkable(a) || !linkable(b)) return 'not_editable';
    if (a.accountId === b.accountId) return 'same_account';
    if (a.currency !== b.currency || a.amountMinor !== -b.amountMinor) return 'not_opposite';
    return null;
  }

  /**
   * Undoes links made in the review (#332): unlinks the transfer groups they made, settled ones
   * too, each leg back to the category it had. A group you couldn't unlink by hand (a leg you don't
   * own, or no longer there) is left as it is; one already unlinked counts for nothing.
   */
  async unlinkTransferGroups(
    ctx: HouseholdContext,
    input: z.infer<typeof unlinkTransferGroupsSchema>,
  ): Promise<{ unlinked: number }> {
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      if (access.viewer) throw forbidden('Viewers can’t unlink transfers.');
      const legs = await tx
        .select()
        .from(transactions)
        .where(
          and(inArray(transactions.transferGroupId, input.groups), isNull(transactions.deletedAt)),
        );
      const allowed = [...Map.groupBy(legs, (l) => l.transferGroupId!)]
        .filter(
          ([, group]) =>
            group.length === 2 && group.every((l) => this.#permissions(l, access).transfer),
        )
        .map(([id]) => id);
      await unlinkTransfers(tx, activity, allowed, 'unlinked');
      return { unlinked: allowed.length };
    });
  }

  /** TXN-08: unlinks a transfer; each leg goes back to the category it had. */
  async unlinkTransfer(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const row = await this.#visible(tx, id, true);
      if (!row.transferGroupId) return;
      const legs = await tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.transferGroupId, row.transferGroupId),
            isNull(transactions.deletedAt),
          ),
        );
      // Both legs: one you can't see or don't own refuses, as linking would have.
      if (legs.length < 2 || legs.some((l) => !this.#permissions(l, access).transfer)) {
        throw forbidden('Unlinking a transfer needs ownership of both accounts.');
      }
      await unlinkTransfers(tx, activity, [row.transferGroupId], 'unlinked');
    });
  }

  async setAttribution(ctx: HouseholdContext, id: string, input: AttributionInput): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const row = await this.#visible(tx, id, true);
      if (!this.#permissions(row, access).attribute) {
        throw forbidden('Only the owners of the paying account can change who it’s for.');
      }
      if (row.hasSplits) {
        throw new Problem(409, 'split_parent', 'Set who each part is for instead');
      }
      const before = await tx
        .select({
          memberId: transactionAttributions.memberId,
          shareBps: transactionAttributions.shareBps,
        })
        .from(transactionAttributions)
        .where(eq(transactionAttributions.transactionId, id));
      await tx.delete(transactionAttributions).where(eq(transactionAttributions.transactionId, id));
      const after = input.length ? await this.#writeAttribution(tx, ctx, id, input) : [];
      await tx
        .update(transactions)
        .set({
          fieldVersions: markPersonSet(['attribution']),
          version: sql`${transactions.version} + 1`,
        })
        .where(eq(transactions.id, id));
      await activity.record({
        action: 'transaction.attribution_changed',
        targetType: 'transaction',
        targetId: id,
        accountId: row.accountId,
        transactionIds: [id],
        metadata: { members: after.map((a) => a.memberId), inherited: after.length === 0 },
        changes: { before: { attribution: before }, after: { attribution: after } },
      });
    });
  }

  /** TXN-06: owners split a transaction into parts that add up to it exactly. */
  async setSplits(ctx: HouseholdContext, id: string, input: SplitsInput): Promise<Transaction[]> {
    return this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const row = await this.#visible(tx, id, true);
      if (!this.#permissions(row, access).edit)
        throw forbidden('Only the account’s owners can split it.');
      if (row.parentId) throw new Problem(409, 'split_part', 'A part can’t be split again');
      // Its amount can still change at the bank, and the parts must add up to it (#88).
      if (row.pending) {
        throw new Problem(
          422,
          'pending',
          'Split it once it posts',
          'A pending transaction’s amount can still change.',
        );
      }
      if (row.transferGroupId) {
        throw new Problem(409, 'transfer', 'Unlink the transfer before splitting it');
      }
      const total = input.parts.reduce((sum, p) => sum + BigInt(p.amountMinor), 0n);
      if (total !== BigInt(row.amountMinor)) {
        throw new Problem(
          422,
          'split_total',
          'The parts must add up to the whole amount',
          undefined,
          [
            {
              path: 'parts',
              code: 'split_total',
              message: `Parts total ${total}, not ${row.amountMinor}`,
            },
          ],
        );
      }
      for (const p of input.parts) await this.#checkCategory(tx, p.categoryId ?? null);

      await tx.delete(transactions).where(eq(transactions.parentId, id));
      await tx
        .update(transactions)
        .set({ hasSplits: true, version: row.version + 1 })
        .where(eq(transactions.id, id));
      // The parent's own attribution moves to the parts.
      await tx.delete(transactionAttributions).where(eq(transactionAttributions.transactionId, id));
      const childIds: string[] = [];
      for (const [i, p] of input.parts.entries()) {
        const childId = uuidv7();
        childIds.push(childId);
        await tx.insert(transactions).values({
          id: childId,
          householdId: ctx.householdId,
          accountId: row.accountId,
          parentId: id,
          amountMinor: p.amountMinor,
          currency: row.currency,
          postedDate: row.postedDate,
          authorizedDate: row.authorizedDate,
          dateOverride: row.dateOverride,
          pending: row.pending,
          originalDescription: row.originalDescription,
          displayName: p.displayName ?? `${row.displayName} (${i + 1}/${input.parts.length})`,
          categoryId: p.categoryId === undefined ? row.categoryId : p.categoryId,
          reviewStatus: row.reviewStatus,
          excluded: row.excluded,
          isBusiness: row.isBusiness,
          source: row.source,
        });
        if (p.attribution?.length) await this.#writeAttribution(tx, ctx, childId, p.attribution);
      }
      await activity.record({
        action: 'transaction.split',
        targetType: 'transaction',
        targetId: id,
        accountId: row.accountId,
        transactionIds: [id, ...childIds],
        metadata: { parts: input.parts.length },
      });
      const children = await tx
        .select()
        .from(transactions)
        .where(inArray(transactions.id, childIds))
        .orderBy(asc(transactions.displayName));
      return this.#present(tx, ctx, await this.#access(tx, ctx), children);
    });
  }

  async removeSplits(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const row = await this.#visible(tx, id, true);
      if (!this.#permissions(row, access).edit)
        throw forbidden('Only the account’s owners can unsplit it.');
      if (!row.hasSplits) return;
      await tx.delete(transactions).where(eq(transactions.parentId, id));
      await tx
        .update(transactions)
        .set({ hasSplits: false, version: row.version + 1 })
        .where(eq(transactions.id, id));
      await activity.record({
        action: 'transaction.unsplit',
        targetType: 'transaction',
        targetId: id,
        accountId: row.accountId,
        transactionIds: [id],
      });
    });
  }

  /**
   * Notes (NOTE-01–04). The shared note: owners, full members, or whoever it's for. Your own
   * note: anyone who can see the transaction; recorded as activity only you can see.
   */
  async setNote(ctx: HouseholdContext, id: string, kind: 'shared' | 'mine', body: string | null) {
    await this.scope.run(ctx, async (tx, activity) => {
      const access = await this.#access(tx, ctx);
      const row = await this.#visible(tx, id);
      if (kind === 'shared' && !this.#permissions(row, access).writeSharedNote) {
        throw forbidden('You can read the shared note but not change it.');
      }
      const author = kind === 'shared' ? null : ctx.memberId;
      const match = and(
        eq(transactionNotes.transactionId, id),
        author
          ? eq(transactionNotes.authorMemberId, author)
          : isNull(transactionNotes.authorMemberId),
      );
      const [existing] = await tx
        .select({ id: transactionNotes.id })
        .from(transactionNotes)
        .where(match);
      if (body === null) {
        if (!existing) return;
        await tx.delete(transactionNotes).where(match);
      } else {
        const bodyEnc = await this.crypto.encrypt(
          transactionNoteContext(ctx.householdId, id, author),
          body,
        );
        if (existing) {
          await tx
            .update(transactionNotes)
            .set({ bodyEnc, updatedByMemberId: ctx.memberId, updatedAt: new Date() })
            .where(match);
        } else {
          await tx.insert(transactionNotes).values({
            householdId: ctx.householdId,
            transactionId: id,
            authorMemberId: author,
            bodyEnc,
            updatedByMemberId: ctx.memberId,
          });
        }
      }
      await activity.record({
        action: body === null ? `transaction.${kind}_note_deleted` : `transaction.${kind}_note_set`,
        targetType: 'transaction',
        targetId: id,
        accountId: row.accountId,
        transactionIds: [id],
        visibleToHousehold: kind === 'shared',
      });
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

  /**
   * A page sorted by name, category, account, or amount (#351), ties newest first. Names sort
   * ignoring case; no category sorts as Uncategorized; an account you can't see sorts as blank,
   * as the row shows only who paid (F1).
   */
  async #sortedPage(
    tx: Executor,
    ctx: HouseholdContext,
    access: Access,
    q: Query,
    where: (SQL | undefined)[],
    dateColumn: ReturnType<typeof transactionDate>,
  ): Promise<{ page: Row[]; nextCursor: string | null }> {
    const sort = q.sort as Exclude<TransactionSort, 'date'>;
    let key: SQL;
    if (sort === 'name') key = sql`lower(${transactions.displayName})`;
    else if (sort === 'amount') key = sql`${transactions.amountMinor}`;
    else if (sort === 'category') {
      const [uncategorized] = await tx
        .select({ name: categories.name })
        .from(categories)
        .where(
          and(
            eq(categories.householdId, ctx.householdId),
            eq(categories.systemKey, 'uncategorized'),
          ),
        );
      key = sql`lower(coalesce((SELECT ${categories.name} FROM ${categories}
                  WHERE ${categories.id} = ${transactions.categoryId}), ${uncategorized?.name ?? ''}))`;
    } else {
      const shown = [...access.levels]
        .filter(([, l]) => l === 'owner' || l === 'full' || l === 'view_only')
        .map(([id]) => id);
      key = sql`lower(coalesce(CASE WHEN ${transactions.accountId} = ANY(${sql.param(shown)}::uuid[])
                  THEN (SELECT ${accounts.name} FROM ${accounts} WHERE ${accounts.id} = ${transactions.accountId})
                  END, ''))`;
    }
    const ascending = (q.direction ?? 'asc') === 'asc';
    if (q.cursor) {
      const [, after, date, id] = decodeSortedCursor(q.cursor, sort);
      const value = sort === 'amount' ? sql`${after}::bigint` : sql`${after}::text`;
      where.push(
        sql`(${key} ${sql.raw(ascending ? '>' : '<')} ${value} OR (${key} = ${value}
              AND (${dateColumn}, ${transactions.id}) < (${date}::date, ${id}::uuid)))`,
      );
    }
    const rows = await tx
      .select({ row: transactions, key: sql<string | number>`${key}` })
      .from(transactions)
      .where(and(...where))
      .orderBy(
        ascending ? sql`${key} ASC` : sql`${key} DESC`,
        desc(dateColumn),
        desc(transactions.id),
      )
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      page: page.map((r) => r.row),
      nextCursor:
        rows.length > q.limit && last
          ? encodeSortedCursor(
              sort,
              sort === 'amount' ? Number(last.key) : String(last.key),
              access.dateBasis === 'authorized'
                ? last.row.effectiveAuthorizedDate
                : last.row.effectiveDate,
              last.row.id,
            )
          : null,
    };
  }

  async #access(tx: Executor, ctx: HouseholdContext): Promise<Access> {
    const levels = await accessLevels(tx);
    const { rows: payers } = await tx.execute<{ transaction_id: string; member_id: string }>(
      sql`SELECT transaction_id, member_id FROM fiscus_attributed_payers()`,
    );
    const attributedPayers = new Map<string, string[]>();
    for (const p of payers) {
      attributedPayers.set(p.transaction_id, [
        ...(attributedPayers.get(p.transaction_id) ?? []),
        p.member_id,
      ]);
    }
    const ranges = await householdRanges(tx, ctx.householdId);
    return {
      viewer: ctx.role === 'viewer',
      dateBasis: ranges.dateBasis,
      ranges,
      levels,
      attributedPayers,
    };
  }

  /** The household's "categorizing marks it reviewed" setting. */
  async #categorizeMarksReviewed(tx: Executor, ctx: HouseholdContext): Promise<boolean> {
    const [h] = await tx
      .select({ on: households.categorizeMarksReviewed })
      .from(households)
      .where(eq(households.id, ctx.householdId));
    return h?.on ?? true;
  }

  async #transferReview(tx: Executor, access: Access): Promise<TransferReviewIds> {
    if (access.viewer) {
      return {
        suggested: new Map(),
        unique: [],
        identical: new Set(),
        rivals: new Map(),
        unmatched: [],
      };
    }
    const owned = new Set([...access.levels].filter(([, l]) => l === 'owner').map(([id]) => id));
    return transferReview(tx, await transferCategories(tx), owned, access.ranges.today);
  }

  #permissions(row: Row, access: Access): Permissions {
    // Viewers are read-only (permissions §2), whatever an account's visibility allows.
    if (access.viewer) return ZERO_PERMISSIONS;
    const level = access.levels.get(row.accountId);
    const owner = level === 'owner';
    const categorize = owner || level === 'full';
    return {
      categorize,
      edit: owner,
      attribute: owner,
      writeSharedNote: categorize || access.attributedPayers.has(row.id),
      transfer: owner,
    };
  }

  async #earliest(tx: Executor, column: ReturnType<typeof transactionDate>) {
    const [row] = await tx
      .select({ d: sql<string | null>`min(${column})::text` })
      .from(transactions)
      .where(isNull(transactions.deletedAt));
    return row?.d ?? undefined;
  }

  /** The transaction if the caller can see it (row-level security), else 404. */
  async #visible(tx: Executor, id: string, forUpdate = false): Promise<Row> {
    const where = and(eq(transactions.id, id), isNull(transactions.deletedAt));
    const [row] = await tx.select().from(transactions).where(where);
    if (!row) throw problems.notFound();
    if (!forUpdate) return row;
    // FOR UPDATE also applies the update policy: a row you can see but not change comes back
    // empty. That's 403, not 404 (permissions §1).
    const [locked] = await tx.select().from(transactions).where(where).for('update');
    if (!locked) throw forbidden('You can view this transaction but not change it.');
    return locked;
  }

  async #checkCategory(tx: Executor, categoryId: string | null): Promise<void> {
    if (!categoryId) return;
    const [found] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), isNull(categories.archivedAt)));
    if (!found) throw new Problem(422, 'invalid_category', 'Choose an existing category');
  }

  async #checkTags(tx: Executor, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await tx.select({ id: tags.id }).from(tags).where(inArray(tags.id, ids));
    if (found.length !== new Set(ids).size)
      throw new Problem(422, 'invalid_tag', 'Choose existing tags');
  }

  /** Validates members (anyone current, including viewers) and writes shares. */
  async #writeAttribution(
    tx: Executor,
    ctx: HouseholdContext,
    id: string,
    input: AttributionInput,
  ) {
    const members = await tx
      .select({ id: householdMembers.id })
      .from(householdMembers)
      .where(
        and(eq(householdMembers.householdId, ctx.householdId), isNull(householdMembers.leftAt)),
      );
    const current = new Set(members.map((m) => m.id));
    if (input.some((a) => !current.has(a.memberId))) {
      throw new Problem(422, 'invalid_member', 'Attribute spending to current members only');
    }
    const shares = input[0]?.shareBps === undefined ? equalShares(input.length) : undefined;
    const rows = input.map((a, i) => ({
      transactionId: id,
      memberId: a.memberId,
      householdId: ctx.householdId,
      shareBps: shares ? shares[i]! : a.shareBps!,
    }));
    await tx.insert(transactionAttributions).values(rows);
    return rows.map(({ memberId, shareBps }) => ({ memberId, shareBps }));
  }

  async #tagIds(tx: Executor, ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    for (const t of await tx
      .select()
      .from(transactionTags)
      .where(inArray(transactionTags.transactionId, ids))) {
      out.set(t.transactionId, [...(out.get(t.transactionId) ?? []), t.tagId]);
    }
    return out;
  }

  /**
   * The other leg of each linked transfer among `rows`. Its account is named only when the caller
   * sees it at view-only or above; otherwise only its owners are (F1), from a function that
   * reveals people and nothing else.
   */
  async #transfers(
    tx: Executor,
    access: Access,
    rows: Row[],
  ): Promise<Map<string, TransferCounterpart>> {
    const out = new Map<string, TransferCounterpart>();
    const linked = rows.filter((r) => r.transferGroupId);
    if (linked.length === 0) return out;
    const { rows: owners } = await tx.execute<{ transaction_id: string; member_id: string }>(
      sql`SELECT transaction_id, member_id FROM fiscus_transfer_counterparts(${sql.param(
        linked.map((r) => r.id),
      )}::uuid[])`,
    );
    const others = await tx
      .select({
        id: transactions.id,
        group: transactions.transferGroupId,
        accountId: transactions.accountId,
        name: accounts.name,
        mask: accounts.maskLast4,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          inArray(
            transactions.transferGroupId,
            linked.map((r) => r.transferGroupId!),
          ),
          isNull(transactions.deletedAt),
        ),
      );
    for (const r of linked) {
      const ownerIds = owners.filter((o) => o.transaction_id === r.id).map((o) => o.member_id);
      const other = others.find((o) => o.group === r.transferGroupId && o.id !== r.id);
      const level = other ? access.levels.get(other.accountId) : undefined;
      const shown = level === 'owner' || level === 'full' || level === 'view_only';
      if (!ownerIds.length && !shown) continue; // the other leg is gone
      out.set(r.id, {
        transactionId: shown ? other!.id : null,
        account: shown ? { id: other!.accountId, name: other!.name, mask: other!.mask } : null,
        ownerIds: [...new Set(ownerIds)],
      });
    }
    return out;
  }

  /**
   * Serializes transactions for the caller. When a transaction is visible only because it's
   * attributed to them, the account is omitted and only the payers (people) are named (F1).
   */
  async #present(
    tx: Executor,
    ctx: HouseholdContext,
    access: Access,
    rows: Row[],
  ): Promise<Transaction[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const accountIds = [...new Set(rows.map((r) => r.accountId))];

    // Accounts and owners: row-level security returns only what the caller can see.
    const visibleAccounts = new Map(
      (
        await tx
          .select({ id: accounts.id, name: accounts.name, mask: accounts.maskLast4 })
          .from(accounts)
          .where(inArray(accounts.id, accountIds))
      ).map((a) => [a.id, a]),
    );
    const owners = new Map<string, { memberId: string; shareBps: number }[]>();
    for (const o of await tx
      .select()
      .from(accountOwners)
      .where(inArray(accountOwners.accountId, accountIds))) {
      owners.set(o.accountId, [
        ...(owners.get(o.accountId) ?? []),
        { memberId: o.memberId, shareBps: o.shareBps },
      ]);
    }
    const attributions = new Map<string, { memberId: string; shareBps: number }[]>();
    for (const a of await tx
      .select()
      .from(transactionAttributions)
      .where(inArray(transactionAttributions.transactionId, ids))
      .orderBy(desc(transactionAttributions.shareBps), asc(transactionAttributions.memberId))) {
      attributions.set(a.transactionId, [
        ...(attributions.get(a.transactionId) ?? []),
        { memberId: a.memberId, shareBps: a.shareBps },
      ]);
    }
    const tagIds = await this.#tagIds(tx, ids);
    const transfers = await this.#transfers(tx, access, rows);
    const notes = new Map<string, { shared: string | null; mine: string | null }>();
    for (const n of await tx
      .select()
      .from(transactionNotes)
      .where(inArray(transactionNotes.transactionId, ids))) {
      const body = await this.crypto.decrypt(
        transactionNoteContext(ctx.householdId, n.transactionId, n.authorMemberId),
        n.bodyEnc,
      );
      const entry = notes.get(n.transactionId) ?? { shared: null, mine: null };
      if (n.authorMemberId === null) entry.shared = body;
      else if (n.authorMemberId === ctx.memberId) entry.mine = body;
      notes.set(n.transactionId, entry);
    }

    return rows.map((r): Transaction => {
      const level = access.levels.get(r.accountId);
      // F1: the account is shown only at view-only and above, never through attribution alone.
      const showAccount = level === 'owner' || level === 'full' || level === 'view_only';
      const account = showAccount ? visibleAccounts.get(r.accountId) : undefined;
      const accountOwners = showAccount ? (owners.get(r.accountId) ?? []) : [];
      const explicit = attributions.get(r.id);
      const can =
        showAccount || access.attributedPayers.has(r.id)
          ? this.#permissions(r, access)
          : ZERO_PERMISSIONS;
      return {
        id: r.id,
        date: access.dateBasis === 'authorized' ? r.effectiveAuthorizedDate : r.effectiveDate,
        reportedDate: r.postedDate ?? r.authorizedDate,
        dateEdited: r.dateOverride !== null,
        amountMinor: r.amountMinor,
        currency: r.currency,
        displayName: r.displayName,
        originalDescription: r.originalDescription,
        categoryId: r.categoryId,
        reviewStatus: r.reviewStatus,
        excluded: r.excluded,
        pending: r.pending,
        source: r.source,
        isBusiness: r.isBusiness,
        account: account ? { id: account.id, name: account.name, mask: account.mask } : null,
        paidBy: showAccount
          ? accountOwners.map((o) => o.memberId)
          : (access.attributedPayers.get(r.id) ?? []),
        attribution: explicit ?? accountOwners,
        attributionInherited: !explicit,
        tagIds: tagIds.get(r.id) ?? [],
        sharedNote: notes.get(r.id)?.shared ?? null,
        myNote: notes.get(r.id)?.mine ?? null,
        parentId: r.parentId,
        hasSplits: r.hasSplits,
        transfer: transfers.get(r.id) ?? null,
        transferExternal: r.transferExternal,
        can,
        version: r.version,
      };
    });
  }
}
