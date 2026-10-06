// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { FieldCrypto } from '@fiscus/crypto';
import {
  accounts,
  balanceSnapshots,
  categories,
  categoryGroups,
  type Executor,
  householdMembers,
  households,
  importBatches,
  importProfiles,
  tags,
  transactionAttributions,
  transactionNotes,
  transactions,
  transactionTags,
} from '@fiscus/db';
import {
  type CategoryKind,
  type createImportProfileSchema,
  type CsvMapping,
  type ImportAccountSummary,
  type ImportBatch,
  type ImportPreview,
  type ImportProfile,
  type importRequestSchema,
  type ImportResult,
  type ImportRowResult,
  type ImportTransaction,
  inferCategoryKind,
  MEMBER_COLORS,
  normalizeDescription,
  type updateImportProfileSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { AccountsService } from '../accounts/accounts.service.js';
import { recomputeBalances } from '../accounts/balances.js';
import { addDays, todayIn } from '../common/dates.js';
import { violatedConstraint } from '../common/db-errors.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { type HouseholdActivity, HouseholdScope } from '../households/household-scope.js';
import { transactionNoteContext } from '../ledger/transactions.service.js';
import { accessLevels } from '../visibility/visibility-scope.js';

type Request = z.output<typeof importRequestSchema>;
type ProfileInput = z.infer<typeof createImportProfileSchema>;
type ProfilePatch = z.infer<typeof updateImportProfileSchema>;

/** A row that would duplicate one already in the account: same amount, within this many days. */
const OVERLAP_DAYS = 3;
const CHUNK = 1000;

/** Thrown to roll a preview back after it has run the whole import (preview = import, unsaved). */
class Rollback extends Error {
  constructor(readonly result: ImportResult) {
    super('preview');
  }
}

interface Target {
  key: string;
  id: string;
  name: string;
  created: boolean;
  mode: 'transactions' | 'value';
  currency: string;
  closeOn: string | null;
}

interface Planned {
  row: ImportTransaction;
  target: Target;
  dedupeKey: string;
}

const chunks = <T>(items: T[], size = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

const lower = (s: string) => s.trim().toLowerCase();

/**
 * File imports (docs/design/imports.md, permissions TXN-09/10). The browser parses the file and
 * sends rows; this checks them, removes duplicates, maps accounts, categories, tags, and people,
 * and writes everything in one database transaction. A preview runs exactly the same code and
 * rolls back.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
    private readonly accounts: AccountsService,
  ) {}

  async preview(ctx: HouseholdContext, input: Request): Promise<ImportPreview> {
    try {
      await this.scope.run(ctx, async (tx, activity) => {
        throw new Rollback(await this.#import(tx, activity, ctx, input));
      });
    } catch (e) {
      if (e instanceof Rollback) {
        const { batches: _, ...preview } = e.result;
        return preview;
      }
      throw e;
    }
    throw new Error('unreachable');
  }

  async commit(ctx: HouseholdContext, input: Request): Promise<ImportResult> {
    return this.scope.run(ctx, (tx, activity) => this.#import(tx, activity, ctx, input));
  }

  async list(ctx: HouseholdContext): Promise<ImportBatch[]> {
    return this.scope.run(ctx, async (tx) => {
      const levels = await accessLevels(tx);
      const rows = await tx
        .select({
          batch: importBatches,
          accountName: accounts.name,
        })
        .from(importBatches)
        .leftJoin(accounts, eq(accounts.id, importBatches.accountId))
        .orderBy(desc(importBatches.createdAt), desc(importBatches.id))
        .limit(200);
      return rows.map(({ batch, accountName }) =>
        this.#presentBatch(ctx, batch, accountName, levels),
      );
    });
  }

  /** TXN-10: the member who imported it, or an owner of the account. */
  async revert(ctx: HouseholdContext, batchId: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, batchId));
      if (!batch) throw problems.notFound();
      const levels = await accessLevels(tx);
      if (batch.memberId !== ctx.memberId && levels.get(batch.accountId) !== 'owner') {
        throw problems.forbidden(
          'Only the person who imported this, or an owner of the account, can undo it.',
        );
      }
      if (batch.revertedAt) {
        throw new Problem(409, 'already_reverted', 'This import was already undone');
      }
      const now = new Date();
      // The dedupe key is cleared so the same file can be imported again later.
      const reverted = await tx
        .update(transactions)
        .set({ deletedAt: now, dedupeKey: null })
        .where(and(eq(transactions.importBatchId, batchId), isNull(transactions.deletedAt)))
        .returning({ id: transactions.id });
      for (const ids of chunks(reverted.map((r) => r.id))) {
        await tx
          .update(transactions)
          .set({ deletedAt: now })
          .where(and(inArray(transactions.parentId, ids), isNull(transactions.deletedAt)));
      }
      await tx.delete(balanceSnapshots).where(eq(balanceSnapshots.importBatchId, batchId));
      await tx
        .update(importBatches)
        .set({ revertedAt: now, revertedByMemberId: ctx.memberId })
        .where(eq(importBatches.id, batchId));
      await activity.record({
        action: 'import.reverted',
        targetType: 'import_batch',
        targetId: batchId,
        accountId: batch.accountId,
        metadata: { transactions: reverted.length },
      });
      if (batch.createdAccount && (await this.#accountIsEmpty(tx, batch.accountId))) {
        // The import made this account and nothing else is in it: undo that too.
        await tx.delete(accounts).where(eq(accounts.id, batch.accountId));
        await activity.record({
          action: 'account.deleted',
          targetType: 'account',
          targetId: batch.accountId,
          accountId: batch.accountId,
          metadata: { reason: 'import_reverted' },
        });
      } else {
        await recomputeBalances(tx, batch.accountId);
      }
    });
  }

  // ── Saved mappings ───────────────────────────────────────────────────────────────────────

  async listProfiles(ctx: HouseholdContext): Promise<ImportProfile[]> {
    return this.scope.run(ctx, async (tx) =>
      (await tx.select().from(importProfiles).orderBy(asc(importProfiles.name))).map(toProfile),
    );
  }

  async createProfile(ctx: HouseholdContext, input: ProfileInput): Promise<ImportProfile> {
    return this.scope
      .run(ctx, async (tx, activity) => {
        const [row] = await tx
          .insert(importProfiles)
          .values({
            householdId: ctx.householdId,
            name: input.name,
            format: 'csv',
            headers: input.headers.map(lower),
            mapping: input.mapping,
            createdByMemberId: ctx.memberId,
          })
          .returning();
        await activity.record({
          action: 'import_profile.created',
          targetType: 'import_profile',
          targetId: row!.id,
          changes: { after: { name: input.name } },
        });
        return toProfile(row!);
      })
      .catch(duplicateProfile);
  }

  async updateProfile(
    ctx: HouseholdContext,
    id: string,
    patch: ProfilePatch,
  ): Promise<ImportProfile> {
    return this.scope
      .run(ctx, async (tx, activity) => {
        const [row] = await tx
          .update(importProfiles)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.headers !== undefined ? { headers: patch.headers.map(lower) } : {}),
            ...(patch.mapping !== undefined ? { mapping: patch.mapping } : {}),
            updatedAt: new Date(),
          })
          .where(eq(importProfiles.id, id))
          .returning();
        if (!row) throw problems.notFound();
        await activity.record({
          action: 'import_profile.updated',
          targetType: 'import_profile',
          targetId: id,
          metadata: { fields: Object.keys(patch) },
        });
        return toProfile(row);
      })
      .catch(duplicateProfile);
  }

  async deleteProfile(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [row] = await tx
        .delete(importProfiles)
        .where(eq(importProfiles.id, id))
        .returning({ id: importProfiles.id });
      if (!row) throw problems.notFound();
      await activity.record({
        action: 'import_profile.deleted',
        targetType: 'import_profile',
        targetId: id,
      });
    });
  }

  // ── The import ───────────────────────────────────────────────────────────────────────────

  async #import(
    tx: Executor,
    activity: HouseholdActivity,
    ctx: HouseholdContext,
    input: Request,
  ): Promise<ImportResult> {
    const [hh] = await tx
      .select({ timezone: households.timezone, baseCurrency: households.baseCurrency })
      .from(households)
      .where(eq(households.id, ctx.householdId));
    if (!hh) throw problems.notFound();
    const today = todayIn(hh.timezone);
    const source = input.format === 'monarch' ? 'Monarch' : 'import';
    this.#checkKeys(input);

    if (input.profileId) {
      const [profile] = await tx
        .select({ id: importProfiles.id })
        .from(importProfiles)
        .where(eq(importProfiles.id, input.profileId));
      if (!profile)
        throw new Problem(422, 'invalid_profile', 'That saved mapping no longer exists');
    }

    const results: ImportRowResult[] = [];
    const targets = await this.#targets(tx, activity, ctx, input, today);

    // Rows for skipped accounts, $0 rows, rows dated in the future: reported, not imported.
    const candidates: ImportTransaction[] = [];
    for (const row of input.transactions) {
      const target = targets.get(row.account);
      if (!target) results.push({ line: row.line, status: 'skipped', message: 'Account skipped' });
      else if (row.amountMinor === 0) {
        results.push({ line: row.line, status: 'skipped', message: 'Amount is $0' });
      } else if (row.date > today) {
        results.push({ line: row.line, status: 'error', message: 'Dated in the future' });
      } else if (!row.description.trim() && !row.name?.trim()) {
        results.push({ line: row.line, status: 'error', message: 'No description or name' });
      } else candidates.push(row);
    }

    const planned = this.#dedupeKeys(candidates, targets);
    const fresh = await this.#removeDuplicates(tx, planned, results);
    const accepted = await this.#removeOverlaps(tx, fresh, results, new Set(input.includeOverlaps));

    const categoryIds = await this.#categories(tx, activity, ctx, input, accepted, source);
    const tagIds = await this.#tags(tx, activity, ctx, accepted);
    const memberIds = await this.#members(tx, ctx, input);

    // One batch per account, so each can be undone on its own.
    const balancesByAccount = this.#balancesToStore(input, targets, accepted, today, results);
    const batches = new Map<string, string>();
    const touched = [...targets.values()].filter(
      (t) =>
        accepted.some((p) => p.target === t) || (balancesByAccount.get(t.key)?.length ?? 0) > 0,
    );
    for (const t of touched) {
      const id = uuidv7();
      batches.set(t.key, id);
      await tx.insert(importBatches).values({
        id,
        householdId: ctx.householdId,
        accountId: t.id,
        memberId: ctx.memberId,
        profileId: input.profileId ?? null,
        format: input.format,
        filename: input.filename,
        transactionCount: accepted.filter((p) => p.target === t).length,
        balanceCount: balancesByAccount.get(t.key)?.length ?? 0,
        createdAccount: t.created,
      });
    }

    await this.#insertTransactions(tx, ctx, accepted, batches, categoryIds, tagIds, memberIds);
    await this.#insertBalances(tx, ctx, targets, balancesByAccount, batches);
    await this.#close(tx, activity, hh.timezone, targets);

    for (const t of touched) {
      await recomputeBalances(tx, t.id);
      await activity.record({
        action: 'import.completed',
        targetType: 'import_batch',
        targetId: batches.get(t.key)!,
        accountId: t.id,
        metadata: {
          format: input.format,
          transactions: accepted.filter((p) => p.target === t).length,
          balances: balancesByAccount.get(t.key)?.length ?? 0,
        },
      });
    }

    const summaries: ImportAccountSummary[] = input.accounts.map((a) => {
      const t = targets.get(a.key);
      const lines = new Set(
        input.transactions.filter((r) => r.account === a.key).map((r) => r.line),
      );
      const of = (status: ImportRowResult['status']) =>
        results.filter((r) => r.status === status && lines.has(r.line)).length;
      return {
        key: a.key,
        accountId: t && !t.created ? t.id : (a.accountId ?? null),
        name: t?.name ?? a.create?.name ?? a.key,
        new: t ? accepted.filter((p) => p.target === t).length : 0,
        duplicates: of('duplicate'),
        overlaps: of('overlap'),
        skipped: of('skipped'),
        errors: of('error'),
        balances: balancesByAccount.get(a.key)?.length ?? 0,
        closeOn: t?.closeOn ?? null,
      };
    });
    results.sort((a, b) => a.line - b.line);
    const levels = await accessLevels(tx);
    const batchRows = batches.size
      ? await tx
          .select()
          .from(importBatches)
          .where(inArray(importBatches.id, [...batches.values()]))
      : [];
    return {
      accounts: summaries,
      newCategories: categoryIds.created,
      newTags: tagIds.created,
      rows: results,
      totals: {
        new: accepted.length,
        duplicates: results.filter((r) => r.status === 'duplicate').length,
        overlaps: results.filter((r) => r.status === 'overlap').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        errors: results.filter((r) => r.status === 'error').length,
      },
      batches: batchRows.map((b) =>
        this.#presentBatch(
          ctx,
          b,
          [...targets.values()].find((t) => t.id === b.accountId)?.name ?? null,
          levels,
        ),
      ),
    };
  }

  /** Every row names an account in the mapping, and each account is mapped once. */
  #checkKeys(input: Request) {
    const keys = new Set<string>();
    for (const a of input.accounts) {
      if (keys.has(a.key)) {
        throw new Problem(422, 'duplicate_account_key', `“${a.key}” is mapped twice`);
      }
      keys.add(a.key);
    }
    const unknown = new Set(
      [...input.transactions, ...input.balances].map((r) => r.account).filter((k) => !keys.has(k)),
    );
    if (unknown.size) {
      throw new Problem(
        422,
        'unmapped_account',
        'Choose where every account in the file goes',
        [...unknown].slice(0, 5).join(', '),
      );
    }
    const targets = input.accounts.filter((a) => a.accountId && !a.skip).map((a) => a.accountId);
    if (new Set(targets).size !== targets.length) {
      throw new Problem(
        422,
        'account_mapped_twice',
        'Two accounts in the file go to the same account',
        'Map each to a different account, or skip one.',
      );
    }
  }

  /** Resolves each account in the file: an existing one you own (TXN-09), or a new one. */
  async #targets(
    tx: Executor,
    activity: HouseholdActivity,
    ctx: HouseholdContext,
    input: Request,
    today: string,
  ): Promise<Map<string, Target>> {
    const levels = await accessLevels(tx);
    const out = new Map<string, Target>();
    for (const a of input.accounts) {
      if (a.skip) continue;
      if (a.closeOn && a.closeOn > addDays(today, 1)) {
        throw new Problem(422, 'future_date', `“${a.key}” can’t be closed on a future day`);
      }
      if (a.accountId) {
        const level = levels.get(a.accountId);
        if (level !== 'owner') {
          throw level
            ? problems.forbidden('You can only import into accounts you own.')
            : problems.notFound();
        }
        const [row] = await tx.select().from(accounts).where(eq(accounts.id, a.accountId));
        out.set(a.key, {
          key: a.key,
          id: row!.id,
          name: row!.name,
          created: false,
          mode: row!.balanceMode,
          currency: row!.currency,
          closeOn: row!.closedAt ? null : (a.closeOn ?? null),
        });
      } else {
        const create = a.create!;
        const id = await this.accounts.createWithin(tx, activity, ctx, {
          name: create.name,
          type: create.type,
          ...(create.balanceMode ? { balanceMode: create.balanceMode } : {}),
          ...(create.visibility ? { visibility: create.visibility } : {}),
          ...(create.owners ? { owners: create.owners } : {}),
        });
        const [row] = await tx
          .select({ mode: accounts.balanceMode, currency: accounts.currency })
          .from(accounts)
          .where(eq(accounts.id, id));
        out.set(a.key, {
          key: a.key,
          id,
          name: create.name,
          created: true,
          mode: row!.mode,
          currency: row!.currency,
          closeOn: a.closeOn ?? null,
        });
      }
    }
    return out;
  }

  /**
   * The bank's or Monarch's own id when there is one; otherwise a hash of the reported date,
   * amount, description, and how many identical rows came before it in the file, so two $4.50
   * coffees on one day stay two (data model §5).
   */
  #dedupeKeys(rows: ImportTransaction[], targets: Map<string, Target>): Planned[] {
    const seen = new Map<string, number>();
    return rows.map((row) => {
      const target = targets.get(row.account)!;
      if (row.externalId) return { row, target, dedupeKey: `x:${row.externalId}` };
      const base = [
        target.id,
        row.date,
        row.amountMinor,
        normalizeDescription(row.description),
      ].join('|');
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const hash = createHash('sha256').update(`${base}|${occurrence}`).digest('base64url');
      return { row, target, dedupeKey: `h:${hash}` };
    });
  }

  /** Rows imported before (same key in the same account, even if since deleted): skipped. */
  async #removeDuplicates(
    tx: Executor,
    planned: Planned[],
    results: ImportRowResult[],
  ): Promise<Planned[]> {
    const existing = new Set<string>();
    const byAccount = Map.groupBy(planned, (p) => p.target.id);
    for (const [accountId, list] of byAccount) {
      for (const part of chunks(list.map((p) => p.dedupeKey))) {
        const found = await tx
          .select({ key: transactions.dedupeKey })
          .from(transactions)
          .where(
            and(
              eq(transactions.accountId, accountId),
              eq(transactions.source, 'import'),
              inArray(transactions.dedupeKey, part),
            ),
          );
        for (const f of found) existing.add(`${accountId}|${f.key}`);
      }
    }
    const kept: Planned[] = [];
    for (const p of planned) {
      const k = `${p.target.id}|${p.dedupeKey}`;
      if (existing.has(k)) {
        results.push({ line: p.row.line, status: 'duplicate', message: 'Already imported' });
      } else {
        existing.add(k); // the same id twice in one file
        kept.push(p);
      }
    }
    return kept;
  }

  /**
   * Possible duplicates of transactions already in the account (entered by hand, synced, or from
   * another file): same amount within three days. Each existing transaction matches at most one
   * row, closest date first. Flagged and left out unless the row is ticked.
   */
  async #removeOverlaps(
    tx: Executor,
    planned: Planned[],
    results: ImportRowResult[],
    include: Set<number>,
  ): Promise<Planned[]> {
    const kept: Planned[] = [];
    for (const [accountId, list] of Map.groupBy(planned, (p) => p.target.id)) {
      if (list[0]!.target.created) {
        kept.push(...list);
        continue;
      }
      const dates = list.map((p) => p.row.date).sort();
      const existing = await tx
        .select({
          id: transactions.id,
          amount: transactions.amountMinor,
          date: transactions.authorizedDate,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, accountId),
            isNull(transactions.deletedAt),
            isNull(transactions.parentId),
            gte(transactions.authorizedDate, addDays(dates[0]!, -OVERLAP_DAYS)),
            lte(transactions.authorizedDate, addDays(dates.at(-1)!, OVERLAP_DAYS)),
          ),
        );
      const byAmount = Map.groupBy(existing, (e) => e.amount);
      const claimed = new Set<string>();
      const days = (a: string, b: string) =>
        Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
      for (const p of [...list].sort((a, b) => a.row.date.localeCompare(b.row.date))) {
        const match = (byAmount.get(p.row.amountMinor) ?? [])
          .filter((e) => !claimed.has(e.id) && days(e.date, p.row.date) <= OVERLAP_DAYS)
          .sort((a, b) => days(a.date, p.row.date) - days(b.date, p.row.date))[0];
        if (match) claimed.add(match.id);
        if (match && !include.has(p.row.line)) {
          results.push({
            line: p.row.line,
            status: 'overlap',
            matchId: match.id,
            message: 'May already be in this account',
          });
        } else kept.push(p);
      }
    }
    return kept.sort((a, b) => a.row.line - b.row.line);
  }

  /**
   * Category names → ids: your mapping first, then an existing category of the same name, then
   * the system categories, else a new category. New income and transfer categories join an
   * existing group of that kind; the rest go in a "From Monarch" (or "From import") group.
   */
  async #categories(
    tx: Executor,
    activity: HouseholdActivity,
    ctx: HouseholdContext,
    input: Request,
    rows: Planned[],
    source: string,
  ): Promise<{ ids: Map<string, string>; created: ImportPreview['newCategories'] }> {
    const names = [
      ...new Set(rows.map((p) => p.row.category?.trim()).filter((n): n is string => !!n)),
    ];
    const ids = new Map<string, string>();
    const created: ImportPreview['newCategories'] = [];
    if (names.length === 0) return { ids, created };

    const existing = await tx
      .select({
        id: categories.id,
        name: categories.name,
        systemKey: categories.systemKey,
        archivedAt: categories.archivedAt,
      })
      .from(categories);
    const active = existing.filter((c) => !c.archivedAt);
    const groups = await tx.select().from(categoryGroups).orderBy(asc(categoryGroups.sortOrder));
    const explicit = new Map(input.categories.map((c) => [lower(c.name), c]));

    for (const name of names) {
      const mapped = explicit.get(lower(name));
      if (mapped?.categoryId) {
        if (!active.some((c) => c.id === mapped.categoryId)) {
          throw new Problem(422, 'invalid_category', `Choose an existing category for “${name}”`);
        }
        ids.set(lower(name), mapped.categoryId);
        continue;
      }
      const match =
        active.find((c) => lower(c.name) === lower(name)) ??
        active.find((c) => c.systemKey !== null && c.systemKey === lower(name));
      if (match) {
        ids.set(lower(name), match.id);
        continue;
      }
      const kind: CategoryKind =
        mapped?.kind ??
        inferCategoryKind(
          name,
          rows
            .filter((p) => lower(p.row.category ?? '') === lower(name))
            .map((p) => p.row.amountMinor),
        );
      const groupName = `From ${source}`;
      let group =
        kind === 'income' || kind === 'transfer'
          ? groups.find((g) => g.kind === kind)
          : groups.find((g) => g.kind === kind && g.name === groupName);
      if (!group) {
        [group] = await tx
          .insert(categoryGroups)
          .values({
            householdId: ctx.householdId,
            name: groupName,
            kind,
            sortOrder: groups.length + 1,
          })
          .returning();
        groups.push(group!);
        await activity.record({
          action: 'category_group.created',
          targetType: 'category_group',
          targetId: group!.id,
          metadata: { kind, reason: 'import' },
        });
      }
      const [row] = await tx
        .insert(categories)
        .values({ householdId: ctx.householdId, groupId: group!.id, name: name.slice(0, 60) })
        .returning({ id: categories.id });
      active.push({ id: row!.id, name, systemKey: null, archivedAt: null });
      ids.set(lower(name), row!.id);
      created.push({ name, kind, group: group!.name });
      await activity.record({
        action: 'category.created',
        targetType: 'category',
        targetId: row!.id,
        changes: { after: { name } },
      });
    }
    return { ids, created };
  }

  /** Tag names → ids, matching existing tags by name and creating the rest. */
  async #tags(
    tx: Executor,
    activity: HouseholdActivity,
    ctx: HouseholdContext,
    rows: Planned[],
  ): Promise<{ ids: Map<string, string>; created: string[] }> {
    const names = new Map<string, string>();
    for (const p of rows)
      for (const t of p.row.tags ?? []) if (t.trim()) names.set(lower(t), t.trim());
    const ids = new Map<string, string>();
    const created: string[] = [];
    if (names.size === 0) return { ids, created };
    const existing = await tx.select({ id: tags.id, name: tags.name }).from(tags);
    for (const e of existing) ids.set(lower(e.name), e.id);
    let i = existing.length;
    for (const [key, name] of names) {
      if (ids.has(key)) continue;
      const [row] = await tx
        .insert(tags)
        .values({
          householdId: ctx.householdId,
          name: name.slice(0, 40),
          color: MEMBER_COLORS[i++ % MEMBER_COLORS.length]!,
        })
        .returning({ id: tags.id });
      ids.set(key, row!.id);
      created.push(name);
      await activity.record({
        action: 'tag.created',
        targetType: 'tag',
        targetId: row!.id,
        changes: { after: { name } },
      });
    }
    return { ids, created };
  }

  /** People named in the file → current members: your mapping, else a member of that name. */
  async #members(
    tx: Executor,
    ctx: HouseholdContext,
    input: Request,
  ): Promise<Map<string, string | null>> {
    const members = await tx
      .select({ id: householdMembers.id, name: householdMembers.displayName })
      .from(householdMembers)
      .where(
        and(eq(householdMembers.householdId, ctx.householdId), isNull(householdMembers.leftAt)),
      );
    const out = new Map<string, string | null>();
    for (const m of members) out.set(lower(m.name), m.id);
    for (const m of input.members) {
      if (m.memberId && !members.some((x) => x.id === m.memberId)) {
        throw new Problem(422, 'invalid_member', `“${m.name}” must be mapped to a current member`);
      }
      out.set(lower(m.name), m.memberId);
    }
    return out;
  }

  /**
   * The balances worth storing per account: the first day, days the balance changed, and days
   * with transactions (so every day reads the same as in the file, ADR 0011 carry-forward).
   */
  #balancesToStore(
    input: Request,
    targets: Map<string, Target>,
    accepted: Planned[],
    today: string,
    results: ImportRowResult[],
  ): Map<string, { date: string; balanceMinor: number }[]> {
    const txnDays = new Set(accepted.map((p) => `${p.target.key}|${p.row.date}`));
    const out = new Map<string, { date: string; balanceMinor: number }[]>();
    let future = 0;
    for (const [key, rows] of Map.groupBy(input.balances, (b) => b.account)) {
      if (!targets.has(key)) continue;
      const byDay = new Map<string, number>();
      for (const b of rows) {
        if (b.date > today) future++;
        else byDay.set(b.date, b.balanceMinor);
      }
      const days = [...byDay.keys()].sort();
      const keep: { date: string; balanceMinor: number }[] = [];
      let previous: number | undefined;
      for (const date of days) {
        const value = byDay.get(date)!;
        if (previous === undefined || value !== previous || txnDays.has(`${key}|${date}`)) {
          keep.push({ date, balanceMinor: value });
        }
        previous = value;
      }
      out.set(key, keep);
    }
    if (future) {
      results.push({
        line: 1,
        status: 'skipped',
        message: `${future} balances dated in the future`,
      });
    }
    return out;
  }

  async #insertTransactions(
    tx: Executor,
    ctx: HouseholdContext,
    rows: Planned[],
    batches: Map<string, string>,
    categoryIds: { ids: Map<string, string> },
    tagIds: { ids: Map<string, string> },
    memberIds: Map<string, string | null>,
  ) {
    const ids = rows.map(() => uuidv7());
    const reviewed = (r: ImportTransaction) =>
      (r.reviewed ?? false) ? ('reviewed' as const) : ('needs_review' as const);
    for (const part of chunks(rows.map((p, i) => ({ p, id: ids[i]! })))) {
      await tx.insert(transactions).values(
        part.map(({ p, id }) => ({
          id,
          householdId: ctx.householdId,
          accountId: p.target.id,
          amountMinor: p.row.amountMinor,
          currency: p.target.currency,
          authorizedDate: p.row.date,
          postedDate: p.row.date,
          originalDescription: p.row.description.trim() || p.row.name!.trim(),
          displayName: p.row.name?.trim() || p.row.description.trim(),
          categoryId: p.row.category ? (categoryIds.ids.get(lower(p.row.category)) ?? null) : null,
          reviewStatus: reviewed(p.row),
          source: 'import' as const,
          importBatchId: batches.get(p.target.key)!,
          dedupeKey: p.dedupeKey,
        })),
      );
    }
    const tagRows = rows.flatMap((p, i) =>
      [
        ...new Set(
          (p.row.tags ?? []).map((t) => tagIds.ids.get(lower(t))).filter((t): t is string => !!t),
        ),
      ].map((tagId) => ({ transactionId: ids[i]!, tagId, householdId: ctx.householdId })),
    );
    for (const part of chunks(tagRows)) await tx.insert(transactionTags).values(part);

    // Monarch's Owner column: who the purchase was for. "Shared" and unmapped names set nothing.
    const attributions = rows.flatMap((p, i) => {
      const memberId = p.row.owner ? memberIds.get(lower(p.row.owner)) : null;
      return memberId
        ? [{ transactionId: ids[i]!, memberId, householdId: ctx.householdId, shareBps: 10000 }]
        : [];
    });
    for (const part of chunks(attributions)) await tx.insert(transactionAttributions).values(part);

    const notes = await Promise.all(
      rows.flatMap((p, i) =>
        p.row.note?.trim()
          ? [
              (async () => ({
                householdId: ctx.householdId,
                transactionId: ids[i]!,
                authorMemberId: null,
                bodyEnc: await this.crypto.encrypt(
                  transactionNoteContext(ctx.householdId, ids[i]!, null),
                  p.row.note!.trim(),
                ),
                updatedByMemberId: ctx.memberId,
              }))(),
            ]
          : [],
      ),
    );
    for (const part of chunks(notes, 200)) await tx.insert(transactionNotes).values(part);
  }

  /** Imported balances are entered balances, marked with their batch. Ones you entered win. */
  async #insertBalances(
    tx: Executor,
    ctx: HouseholdContext,
    targets: Map<string, Target>,
    balances: Map<string, { date: string; balanceMinor: number }[]>,
    batches: Map<string, string>,
  ) {
    for (const [key, rows] of balances) {
      const target = targets.get(key)!;
      for (const part of chunks(rows)) {
        await tx
          .insert(balanceSnapshots)
          .values(
            part.map((b) => ({
              accountId: target.id,
              householdId: ctx.householdId,
              asOf: b.date,
              balanceMinor: b.balanceMinor,
              source: 'manual' as const,
              importBatchId: batches.get(key)!,
            })),
          )
          .onConflictDoUpdate({
            target: [balanceSnapshots.accountId, balanceSnapshots.asOf],
            set: {
              balanceMinor: sql`excluded.balance_minor`,
              source: sql`excluded.source`,
              importBatchId: sql`excluded.import_batch_id`,
              updatedAt: new Date(),
            },
            setWhere: eq(balanceSnapshots.source, 'computed'),
          });
      }
    }
  }

  /** Accounts the file shows as closed: closed from the start of that day, household time. */
  async #close(
    tx: Executor,
    activity: HouseholdActivity,
    timezone: string,
    targets: Map<string, Target>,
  ) {
    for (const t of targets.values()) {
      if (!t.closeOn) continue;
      await tx
        .update(accounts)
        .set({
          closedAt: sql`(${t.closeOn}::date)::timestamp AT TIME ZONE ${timezone}`,
          version: sql`${accounts.version} + 1`,
        })
        .where(and(eq(accounts.id, t.id), isNull(accounts.closedAt)));
      await activity.record({
        action: 'account.closed',
        targetType: 'account',
        targetId: t.id,
        accountId: t.id,
        metadata: { on: t.closeOn, reason: 'import' },
      });
    }
  }

  async #accountIsEmpty(tx: Executor, accountId: string): Promise<boolean> {
    const [txn] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt)))
      .limit(1);
    const [balance] = await tx
      .select({ asOf: balanceSnapshots.asOf })
      .from(balanceSnapshots)
      .where(
        and(eq(balanceSnapshots.accountId, accountId), ne(balanceSnapshots.source, 'computed')),
      )
      .limit(1);
    const [other] = await tx
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(and(eq(importBatches.accountId, accountId), isNull(importBatches.revertedAt)))
      .limit(1);
    return !txn && !balance && !other;
  }

  #presentBatch(
    ctx: HouseholdContext,
    b: typeof importBatches.$inferSelect,
    accountName: string | null,
    levels: Map<string, string>,
  ): ImportBatch {
    return {
      id: b.id,
      accountId: b.accountId,
      accountName: levels.has(b.accountId) ? accountName : null,
      memberId: b.memberId,
      format: b.format,
      filename: b.filename,
      transactionCount: b.transactionCount,
      balanceCount: b.balanceCount,
      createdAt: b.createdAt.toISOString(),
      revertedAt: b.revertedAt?.toISOString() ?? null,
      canRevert:
        b.revertedAt === null &&
        ctx.role !== 'viewer' &&
        (b.memberId === ctx.memberId || levels.get(b.accountId) === 'owner'),
    };
  }
}

const toProfile = (r: typeof importProfiles.$inferSelect): ImportProfile => ({
  id: r.id,
  name: r.name,
  headers: r.headers,
  mapping: r.mapping as CsvMapping,
  updatedAt: r.updatedAt.toISOString(),
});

const duplicateProfile = (err: unknown): never => {
  if (violatedConstraint(err) === 'import_profiles_name') {
    throw new Problem(409, 'duplicate_name', 'A saved mapping with that name already exists');
  }
  throw err;
};
