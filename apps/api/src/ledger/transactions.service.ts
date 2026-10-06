// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import {
  accountOwners,
  accounts,
  categories,
  type Executor,
  householdMembers,
  tags,
  transactionAttributions,
  transactionNotes,
  transactions,
  transactionTags,
} from '@fiscus/db';
import { planVersionedPatch } from '@fiscus/domain';
import type {
  AccessLevel,
  AttributionInput,
  BulkUpdateResult,
  bulkUpdateTransactionsSchema,
  createTransactionSchema,
  setSplitsSchema,
  RangeMeta,
  Transaction,
  transactionsQuerySchema,
  updateTransactionSchema,
} from '@fiscus/shared';
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
import { recomputeBalances } from '../accounts/balances.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import {
  type HouseholdRanges,
  householdRanges,
  resolveParams,
  transactionDate,
} from '../ranges/household-ranges.js';
import { accessLevels, spendingLensFilter } from '../visibility/visibility-scope.js';

type Row = typeof transactions.$inferSelect;
type Query = z.infer<typeof transactionsQuerySchema>;
type CreateInput = z.infer<typeof createTransactionSchema>;
type UpdateInput = z.infer<typeof updateTransactionSchema>;
type BulkInput = z.infer<typeof bulkUpdateTransactionsSchema>;
type SplitsInput = z.infer<typeof setSplitsSchema>;

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
}

const ZERO_PERMISSIONS: Permissions = {
  categorize: false,
  edit: false,
  attribute: false,
  writeSharedNote: false,
};

const forbidden = (detail: string) => problems.forbidden(detail);

/** Equal shares in basis points; the first member takes the remainder. */
function equalShares(count: number): number[] {
  const base = Math.floor(10000 / count);
  return Array.from({ length: count }, (_, i) => (i === 0 ? 10000 - base * (count - 1) : base));
}

const encodeCursor = (date: string, id: string) =>
  Buffer.from(JSON.stringify([date, id])).toString('base64url');

function decodeCursor(cursor: string): [string, string] {
  try {
    const [date, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^[0-9a-f-]{36}$/.test(id)) return [date, id];
  } catch {
    // fall through
  }
  throw new Problem(
    422,
    'invalid_cursor',
    'Invalid page cursor',
    'Start again from the first page.',
  );
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
      if (q.cursor) {
        const [date, id] = decodeCursor(q.cursor);
        where.push(sql`(${dateColumn}, ${transactions.id}) < (${date}::date, ${id}::uuid)`);
      }
      const rows = await tx
        .select()
        .from(transactions)
        .where(and(...where))
        .orderBy(desc(dateColumn), desc(transactions.id))
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
      await activity.record({
        action: 'transaction.created',
        targetType: 'transaction',
        targetId: id,
        accountId: input.accountId,
        changes: {
          after: {
            amountMinor: input.amountMinor,
            date: input.date,
            displayName: input.displayName,
          },
        },
      });
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
      const needsCategorize = ['displayName', 'categoryId', 'reviewStatus', 'tagIds'].some(
        (f) => f in patch,
      );
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
      };
      const { tagIds, ...rest } = patch;
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
      await tx
        .update(transactions)
        .set({ deletedAt: now, version: row.version + 1 })
        .where(or(eq(transactions.id, id), eq(transactions.parentId, id)));
      await recomputeBalances(tx, row.accountId);
      await activity.record({
        action: 'transaction.deleted',
        targetType: 'transaction',
        targetId: id,
        accountId: row.accountId,
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

      const columns = {
        ...(changes.categoryId !== undefined ? { categoryId: changes.categoryId } : {}),
        ...(changes.reviewStatus ? { reviewStatus: changes.reviewStatus } : {}),
        ...(changes.excluded !== undefined ? { excluded: changes.excluded } : {}),
      };
      if (Object.keys(columns).length) {
        await tx
          .update(transactions)
          .set({ ...columns, version: sql`${transactions.version} + 1` })
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
          changes: { after: { ids, ...changes } },
        });
      }
      return result;
    });
  }

  /** ATT-01/02: owners of the paying account say who it's for. `[]` inherits from the owners. */
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
      await activity.record({
        action: 'transaction.attribution_changed',
        targetType: 'transaction',
        targetId: id,
        accountId: row.accountId,
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
        const bodyEnc = await this.crypto.encrypt(this.#noteContext(ctx, id, author), body);
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
        visibleToHousehold: kind === 'shared',
      });
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

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

  #noteContext(ctx: HouseholdContext, transactionId: string, author: string | null) {
    return {
      householdId: ctx.householdId,
      table: 'transaction_notes',
      column: 'body_enc',
      rowId: `${transactionId}:${author ?? 'shared'}`,
    };
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
    const notes = new Map<string, { shared: string | null; mine: string | null }>();
    for (const n of await tx
      .select()
      .from(transactionNotes)
      .where(inArray(transactionNotes.transactionId, ids))) {
      const body = await this.crypto.decrypt(
        this.#noteContext(ctx, n.transactionId, n.authorMemberId),
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
        can,
        version: r.version,
      };
    });
  }
}
