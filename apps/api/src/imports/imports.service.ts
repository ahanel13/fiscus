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
  type ImportRow,
  type ImportRowResult,
  type ImportTransferPreview,
  type importRowsSchema,
  type ImportRowsResult,
  type ImportRun,
  cleanMerchantName,
  inferCategoryKind,
  MEMBER_COLORS,
  normalizeDescription,
  type startImportSchema,
  type updateImportProfileSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { AccountsService } from '../accounts/accounts.service.js';
import { recomputeBalances } from '../accounts/balances.js';
import {
  detectTransfers,
  findTransfers,
  type Leg,
  transferCategories,
  unlinkTransfers,
} from '../ledger/transfers.js';
import { activeRules, runRules } from '../rules/engine.js';
import { addDays, todayIn } from '../common/dates.js';
import { violatedConstraint } from '../common/db-errors.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { type HouseholdActivity, HouseholdScope } from '../households/household-scope.js';
import { transactionNoteContext } from '../ledger/transactions.service.js';
import { accessLevels } from '../visibility/visibility-scope.js';

type PreviewInput = z.output<typeof importRequestSchema>;
type StartInput = z.output<typeof startImportSchema>;
type RowsInput = z.output<typeof importRowsSchema>;
type ProfileInput = z.infer<typeof createImportProfileSchema>;
type ProfilePatch = z.infer<typeof updateImportProfileSchema>;
type Batch = typeof importBatches.$inferSelect;
type AccountMapping = StartInput['accounts'][number];

/** A row that would duplicate one already in the account: same amount, within this many days. */
const OVERLAP_DAYS = 3;
const CHUNK = 1000;

interface Planned {
  row: ImportRow;
  dedupeKey: string;
}

interface Resolved {
  ids: Map<string, string>;
  created: ImportPreview['newCategories'];
}

const chunks = <T>(items: T[], size = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

const lower = (s: string) => s.trim().toLowerCase();

const days = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * File imports (docs/design/imports.md, permissions TXN-09/10). The browser parses the file and
 * sends rows. Nothing here holds the household for long:
 * - **preview** reads only, and reports what an import would do;
 * - **start** creates the accounts, categories, and tags, and a batch per account (one run);
 * - **rows** adds one part of one account's rows at a time, so the wizard shows real progress;
 * - **revert** undoes a batch, or a whole run.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
    private readonly accounts: AccountsService,
  ) {}

  // ── Preview ──────────────────────────────────────────────────────────────────────────────

  /** What importing the whole file would do. Reads only: no writes, no locks. */
  async preview(ctx: HouseholdContext, input: PreviewInput): Promise<ImportPreview> {
    return this.scope.run(ctx, async (tx) => {
      const today = await this.#today(tx, ctx);
      this.#checkKeys(input.accounts, [...input.transactions, ...input.balances]);
      await this.#checkProfile(tx, input.profileId);
      await this.#members(tx, ctx, input.members);
      const levels = await accessLevels(tx);
      const include = new Set(input.includeOverlaps);
      const results: ImportRowResult[] = [];
      const accepted = new Map<string, Planned[]>();
      const summaries: ImportAccountSummary[] = [];

      for (const a of input.accounts) {
        const rows = input.transactions.filter((r) => r.account === a.key);
        if (a.skip) {
          for (const r of rows) {
            results.push({ line: r.line, status: 'skipped', message: 'Account skipped' });
          }
        }
        // Combined with another account in the file: that account's target.
        const target = a.sameAs ? input.accounts.find((x) => x.key === a.sameAs)! : a;
        const existing = a.skip ? null : await this.#existing(tx, levels, target, today);
        const accountId = existing?.id ?? null;
        const before = results.length;
        let kept: Planned[] = [];
        if (!a.skip) {
          const planned = this.#dedupeKeys(this.#screen(rows, today, results));
          kept = await this.#removeOverlaps(
            tx,
            accountId,
            null,
            await this.#removeDuplicates(tx, accountId, planned, results),
            results,
            include,
          );
        }
        accepted.set(a.key, kept);
        const mine = results.slice(before);
        const of = (status: ImportRowResult['status']) =>
          mine.filter((r) => r.status === status).length;
        const txnDays = new Set(kept.map((p) => p.row.date));
        if (accountId) for (const d of await this.#transactionDays(tx, accountId)) txnDays.add(d);
        const balances = a.skip
          ? []
          : this.#balancesToStore(
              input.balances.filter((b) => b.account === a.key),
              txnDays,
              today,
            );
        summaries.push({
          key: a.key,
          accountId,
          name: existing?.name ?? target.create?.name ?? target.key,
          new: kept.length,
          duplicates: of('duplicate'),
          overlaps: of('overlap'),
          skipped: a.skip ? rows.length : of('skipped'),
          errors: of('error'),
          balances: balances.length,
          closeOn: a.skip || a.sameAs || existing?.closedAt ? null : (a.closeOn ?? null),
        });
      }

      const all = [...accepted.values()].flat().sort((x, y) => x.row.line - y.row.line);
      const amounts = Map.groupBy(
        all.filter((p) => p.row.category),
        (p) => lower(p.row.category!),
      );
      const names = [
        ...new Set(all.map((p) => p.row.category?.trim()).filter((n): n is string => !!n)),
      ];
      const resolved = await this.#categories(tx, null, ctx, input, names, amounts);
      const tagNames = all.flatMap((p) => p.row.tags ?? []);
      const tagIds = await this.#tags(tx, null, ctx, tagNames);
      const transfers = await this.#transfers(tx, ctx, input, accepted, summaries, resolved);
      results.sort((x, y) => x.line - y.line);
      return {
        accounts: summaries,
        newCategories: resolved.created,
        newTags: tagIds.created,
        rows: results,
        transfers,
        totals: {
          transfers: transfers.length,
          new: all.length,
          duplicates: results.filter((r) => r.status === 'duplicate').length,
          overlaps: results.filter((r) => r.status === 'overlap').length,
          skipped: results.filter((r) => r.status === 'skipped').length,
          errors: results.filter((r) => r.status === 'error').length,
        },
      };
    });
  }

  /**
   * The transfers the import would link (§5), for the wizard's review step: detection run over the
   * file's new rows and your ledger, as rowsAdded will. Rows going to a new account are yours: the
   * importer always owns the accounts it creates. Reads only.
   */
  async #transfers(
    tx: Executor,
    ctx: HouseholdContext,
    input: PreviewInput,
    accepted: Map<string, Planned[]>,
    summaries: ImportAccountSummary[],
    resolved: Resolved,
  ): Promise<ImportTransferPreview[]> {
    const cats = await transferCategories(tx);
    const created = new Map(resolved.created.map((c) => [lower(c.name), c.kind]));
    const eligible = (category: string | undefined) => {
      const key = category?.trim() ? lower(category.trim()) : null;
      if (!key) return true;
      const id = resolved.ids.get(key);
      return id
        ? id === cats.uncategorized || cats.transferKind.has(id)
        : created.get(key) === 'transfer';
    };
    const existing = summaries.flatMap((s) => (s.accountId ? [s.accountId] : []));
    const currencies = new Map(
      (existing.length
        ? await tx
            .select({ id: accounts.id, currency: accounts.currency })
            .from(accounts)
            .where(inArray(accounts.id, existing))
        : []
      ).map((a) => [a.id, a.currency]),
    );
    const [hh] = await tx
      .select({ currency: households.baseCurrency })
      .from(households)
      .where(eq(households.id, ctx.householdId));
    const summaryOf = new Map(summaries.map((s) => [s.key, s]));
    const fileLegs = new Map<string, { leg: Leg; line: number; key: string }>();
    for (const a of input.accounts) {
      if (a.skip) continue;
      // Combined accounts are one account: rows of both can't be a transfer between them.
      const target = summaryOf.get(a.sameAs ?? a.key)!;
      const accountId = target.accountId ?? `file:${target.key}`;
      const currency = (target.accountId && currencies.get(target.accountId)) || hh!.currency;
      for (const p of accepted.get(a.key) ?? []) {
        if (!eligible(p.row.category)) continue;
        const id = `line:${p.row.line}`;
        fileLegs.set(id, {
          leg: {
            id,
            accountId,
            amountMinor: p.row.amountMinor,
            currency,
            effectiveDate: p.row.date,
          },
          line: p.row.line,
          key: a.key,
        });
      }
    }
    if (fileLegs.size === 0) return [];
    const levels = await accessLevels(tx);
    const { pairs, ledger } = await findTransfers(
      tx,
      [...fileLegs.values()].map((f) => f.leg),
      cats,
      (accountId) => accountId.startsWith('file:') || levels.get(accountId) === 'owner',
    );
    const ledgerAccounts = [...new Set(ledger.map((l) => l.accountId))];
    const names = new Map(
      (ledgerAccounts.length
        ? await tx
            .select({ id: accounts.id, name: accounts.name })
            .from(accounts)
            .where(inArray(accounts.id, ledgerAccounts))
        : []
      ).map((a) => [a.id, a.name]),
    );
    return (
      pairs
        // A block of identical transfers can pair two older ones too: not this file's to show.
        .filter(([a, b]) => fileLegs.has(a.id) || fileLegs.has(b.id))
        .map(([a, b]) => {
          // Within the file, show the pair once, from the money-out side.
          const [from, to] =
            !fileLegs.has(a.id) || (fileLegs.has(b.id) && a.amountMinor > 0) ? [b, a] : [a, b];
          const row = fileLegs.get(from.id)!;
          const other = fileLegs.get(to.id);
          return {
            line: row.line,
            account: row.key,
            date: from.effectiveDate,
            amountMinor: from.amountMinor,
            other: {
              line: other?.line ?? null,
              accountName: other
                ? summaryOf.get(other.key)!.name
                : (names.get(to.accountId) ?? 'another account'),
              date: to.effectiveDate,
            },
          };
        })
        .sort((x, y) => x.line - y.line)
    );
  }

  // ── Import ───────────────────────────────────────────────────────────────────────────────

  /**
   * Starts a run (TXN-09): creates the new accounts, categories, and tags, closes accounts the
   * file shows closed, and opens a batch per account, recording how names map.
   */
  async start(ctx: HouseholdContext, input: StartInput): Promise<ImportRun> {
    return this.scope.run(ctx, async (tx, activity) => {
      const today = await this.#today(tx, ctx);
      this.#checkKeys(input.accounts, []);
      await this.#checkProfile(tx, input.profileId);
      const members = await this.#members(tx, ctx, input.members);
      const levels = await accessLevels(tx);
      const resolved = await this.#categories(
        tx,
        activity,
        ctx,
        input,
        input.categoryNames,
        new Map(),
      );
      await this.#tags(tx, activity, ctx, input.tags);
      const tz = await this.#timezone(tx, ctx);
      const runId = uuidv7();
      const mapping = {
        categories: Object.fromEntries(resolved.ids),
        members: Object.fromEntries(members),
      };

      const batches: ImportRun['batches'] = [];
      const ids = new Map<string, string>();
      // Accounts combined with another go last, into the account that one resolved to.
      const ordered = [
        ...input.accounts.filter((a) => !a.sameAs),
        ...input.accounts.filter((a) => a.sameAs),
      ];
      for (const a of ordered) {
        if (a.skip) continue;
        const combined = a.sameAs ? ids.get(a.sameAs)! : null;
        const existing = combined ? null : await this.#existing(tx, levels, a, today);
        const accountId =
          combined ??
          existing?.id ??
          (await this.accounts.createWithin(tx, activity, ctx, {
            name: a.create!.name,
            type: a.create!.type,
            ...(a.create!.balanceMode ? { balanceMode: a.create!.balanceMode } : {}),
            ...(a.create!.visibility ? { visibility: a.create!.visibility } : {}),
            ...(a.create!.owners ? { owners: a.create!.owners } : {}),
          }));
        ids.set(a.key, accountId);
        const close = !combined && !!a.closeOn && !existing?.closedAt;
        if (close) {
          // Closed from the start of that day in the household's time zone.
          await tx
            .update(accounts)
            .set({
              closedAt: sql`(${a.closeOn}::date)::timestamp AT TIME ZONE ${tz}`,
              version: sql`${accounts.version} + 1`,
            })
            .where(eq(accounts.id, accountId));
          await activity.record({
            action: 'account.closed',
            targetType: 'account',
            targetId: accountId,
            accountId,
            metadata: { on: a.closeOn, reason: 'import' },
          });
        }
        const batchId = uuidv7();
        await tx.insert(importBatches).values({
          id: batchId,
          householdId: ctx.householdId,
          accountId,
          memberId: ctx.memberId,
          runId,
          profileId: input.profileId ?? null,
          format: input.format,
          filename: input.filename,
          transactionCount: 0,
          balanceCount: 0,
          createdAccount: !existing && !combined,
          closedAccount: close,
          mapping,
        });
        batches.push({ key: a.key, batchId, accountId });
      }
      await activity.record({
        action: 'import.started',
        targetType: 'import_run',
        targetId: runId,
        metadata: { format: input.format, accounts: batches.length },
      });
      return { runId, batches };
    });
  }

  /**
   * Adds one part of an account's rows to its batch. Only the member who started the run adds
   * to it, while they still own the account.
   */
  async addRows(
    ctx: HouseholdContext,
    batchId: string,
    input: RowsInput,
  ): Promise<ImportRowsResult> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, batchId));
      if (!batch) throw problems.notFound();
      if (batch.memberId !== ctx.memberId) {
        throw problems.forbidden('Only the person who started this import can add to it.');
      }
      if (batch.revertedAt) throw new Problem(409, 'already_reverted', 'This import was undone');
      if ((await accessLevels(tx)).get(batch.accountId) !== 'owner') {
        throw problems.forbidden('You can only import into accounts you own.');
      }
      const [account] = await tx
        .select({ currency: accounts.currency })
        .from(accounts)
        .where(eq(accounts.id, batch.accountId));
      const today = await this.#today(tx, ctx);
      const results: ImportRowResult[] = [];
      const planned = this.#dedupeKeys(this.#screen(input.transactions, today, results));
      const accepted = await this.#removeOverlaps(
        tx,
        batch.accountId,
        batch.id,
        await this.#removeDuplicates(tx, batch.accountId, planned, results),
        results,
        new Set(input.includeOverlaps),
      );
      const tagIds = await this.#tags(
        tx,
        activity,
        ctx,
        accepted.flatMap((p) => p.row.tags ?? []),
      );
      const inserted = await this.#insertTransactions(
        tx,
        ctx,
        batch,
        account!.currency,
        accepted,
        tagIds.ids,
      );
      // Rules run on what arrived, within each rule's author's reach (RULE-05). They leave alone
      // what the file supplied: its names, categories, and tags (marked in #insertTransactions).
      const ruled = inserted.length
        ? await runRules(
            tx,
            ctx,
            await tx.select().from(transactions).where(inArray(transactions.id, inserted)),
            await activeRules(tx),
            null,
            activity,
          )
        : [];
      // Then transfers between your accounts (§5): unambiguous pairs only, both accounts yours.
      const transfersLinked = (
        await detectTransfers(tx, activity, inserted, await accessLevels(tx))
      ).length;

      const txnDays = new Set(await this.#transactionDays(tx, batch.accountId));
      const balances = this.#balancesToStore(input.balances, txnDays, today);
      if (input.balances.some((b) => b.date > today)) {
        results.push({ line: 1, status: 'skipped', message: 'Balances dated in the future' });
      }
      await this.#insertBalances(tx, ctx, batch, balances);

      await tx
        .update(importBatches)
        .set({
          transactionCount: sql`${importBatches.transactionCount} + ${accepted.length}`,
          balanceCount: sql`${importBatches.balanceCount} + ${balances.length}`,
          updatedAt: new Date(),
        })
        .where(eq(importBatches.id, batch.id));
      await recomputeBalances(tx, batch.accountId);
      await activity.record({
        action: 'import.rows_added',
        targetType: 'import_batch',
        targetId: batch.id,
        accountId: batch.accountId,
        metadata: {
          transactions: accepted.length,
          balances: balances.length,
          changedByRules: ruled.length,
          transfersLinked,
        },
      });
      results.sort((x, y) => x.line - y.line);
      return {
        added: accepted.length,
        balances: balances.length,
        changedByRules: ruled.length,
        transfersLinked,
        rows: results,
      };
    });
  }

  async list(ctx: HouseholdContext): Promise<ImportBatch[]> {
    return this.scope.run(ctx, async (tx) => {
      const levels = await accessLevels(tx);
      const rows = await tx
        .select({ batch: importBatches, accountName: accounts.name })
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
      if (batch.revertedAt) {
        throw new Problem(409, 'already_reverted', 'This import was already undone');
      }
      const moved = new Set<string>();
      await this.#revertBatch(tx, activity, ctx, batch, await accessLevels(tx), moved);
      await this.#afterRevert(tx, activity, [batch], moved);
    });
  }

  /** Undoes every batch of a run ("Undo this import" after a file with many accounts). */
  async revertRun(ctx: HouseholdContext, runId: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const batches = await tx.select().from(importBatches).where(eq(importBatches.runId, runId));
      if (batches.length === 0) throw problems.notFound();
      const open = batches.filter((b) => !b.revertedAt);
      if (open.length === 0) {
        throw new Problem(409, 'already_reverted', 'This import was already undone');
      }
      const levels = await accessLevels(tx);
      const moved = new Set<string>();
      for (const b of open) await this.#revertBatch(tx, activity, ctx, b, levels, moved);
      await this.#afterRevert(tx, activity, open, moved);
    });
  }

  /**
   * How earlier imports of this kind mapped category names, latest choice winning: lower-cased
   * name → category id, for categories that still exist. The wizard starts from it, so a
   * Monarch category mapped to one of yours once is mapped the same way next time.
   */
  async categoryMap(
    ctx: HouseholdContext,
    format: 'csv' | 'monarch' | undefined,
  ): Promise<Record<string, string>> {
    return this.scope.run(ctx, async (tx) => {
      const rows = await tx
        .select({ mapping: importBatches.mapping })
        .from(importBatches)
        .where(
          and(
            isNull(importBatches.revertedAt),
            format ? eq(importBatches.format, format) : undefined,
          ),
        )
        .orderBy(asc(importBatches.createdAt));
      const merged = new Map<string, string>();
      for (const r of rows) {
        for (const [name, id] of Object.entries(r.mapping.categories)) merged.set(name, id);
      }
      const live = new Set(
        (
          await tx
            .select({ id: categories.id })
            .from(categories)
            .where(isNull(categories.archivedAt))
        ).map((c) => c.id),
      );
      return Object.fromEntries([...merged].filter(([, id]) => live.has(id)));
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

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

  async #timezone(tx: Executor, ctx: HouseholdContext): Promise<string> {
    const [hh] = await tx
      .select({ timezone: households.timezone })
      .from(households)
      .where(eq(households.id, ctx.householdId));
    if (!hh) throw problems.notFound();
    return hh.timezone;
  }

  async #today(tx: Executor, ctx: HouseholdContext): Promise<string> {
    return todayIn(await this.#timezone(tx, ctx));
  }

  async #checkProfile(tx: Executor, profileId: string | undefined) {
    if (!profileId) return;
    const [profile] = await tx
      .select({ id: importProfiles.id })
      .from(importProfiles)
      .where(eq(importProfiles.id, profileId));
    if (!profile) throw new Problem(422, 'invalid_profile', 'That saved mapping no longer exists');
  }

  /** Every row names an account in the mapping, and each account is mapped once. */
  #checkKeys(mapped: AccountMapping[], rows: { account: string }[]) {
    const keys = new Set<string>();
    for (const a of mapped) {
      if (keys.has(a.key)) {
        throw new Problem(422, 'duplicate_account_key', `“${a.key}” is mapped twice`);
      }
      keys.add(a.key);
    }
    const unknown = new Set(rows.map((r) => r.account).filter((k) => !keys.has(k)));
    if (unknown.size) {
      throw new Problem(
        422,
        'unmapped_account',
        'Choose where every account in the file goes',
        [...unknown].slice(0, 5).join(', '),
      );
    }
    for (const a of mapped) {
      if (!a.sameAs || a.skip) continue;
      const other = mapped.find((x) => x.key === a.sameAs);
      if (!other || other.skip || other.sameAs || other === a) {
        throw new Problem(
          422,
          'invalid_combine',
          `“${a.key}” can only be combined with an account that’s being imported on its own`,
        );
      }
    }
    const targets = mapped.filter((a) => a.accountId && !a.skip).map((a) => a.accountId);
    if (new Set(targets).size !== targets.length) {
      throw new Problem(
        422,
        'account_mapped_twice',
        'Two accounts in the file go to the same account',
        'Map each to a different account, or skip one.',
      );
    }
  }

  /** The existing account a file account maps to, which you must own (TXN-09); null if new. */
  async #existing(
    tx: Executor,
    levels: Map<string, string>,
    a: AccountMapping,
    today: string,
  ): Promise<typeof accounts.$inferSelect | null> {
    if (a.closeOn && a.closeOn > addDays(today, 1)) {
      throw new Problem(422, 'future_date', `“${a.key}” can’t be closed on a future day`);
    }
    if (!a.accountId) return null;
    const level = levels.get(a.accountId);
    if (level !== 'owner') {
      throw level
        ? problems.forbidden('You can only import into accounts you own.')
        : problems.notFound();
    }
    const [row] = await tx.select().from(accounts).where(eq(accounts.id, a.accountId));
    return row!;
  }

  /** $0 rows, rows dated in the future, rows with no text: reported, not imported. */
  #screen(rows: ImportRow[], today: string, results: ImportRowResult[]): ImportRow[] {
    return rows.filter((row) => {
      if (row.amountMinor === 0) {
        results.push({ line: row.line, status: 'skipped', message: 'Amount is $0' });
      } else if (row.date > today) {
        results.push({ line: row.line, status: 'error', message: 'Dated in the future' });
      } else if (!row.description.trim() && !row.name?.trim()) {
        results.push({ line: row.line, status: 'error', message: 'No description or name' });
      } else return true;
      return false;
    });
  }

  /**
   * The bank's or Monarch's own id when there is one; otherwise a hash of the reported date,
   * amount, description, and how many identical rows came before it, so two $4.50 coffees on one
   * day stay two (data model §5). Rows arrive a day at a time at most, so the count is stable.
   */
  #dedupeKeys(rows: ImportRow[]): Planned[] {
    const seen = new Map<string, number>();
    return rows.map((row) => {
      if (row.externalId) return { row, dedupeKey: `x:${row.externalId}` };
      const base = [row.date, row.amountMinor, normalizeDescription(row.description)].join('|');
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const hash = createHash('sha256').update(`${base}|${occurrence}`).digest('base64url');
      return { row, dedupeKey: `h:${hash}` };
    });
  }

  /** Rows imported before (same key in the same account, even if since deleted): skipped. */
  async #removeDuplicates(
    tx: Executor,
    accountId: string | null,
    planned: Planned[],
    results: ImportRowResult[],
  ): Promise<Planned[]> {
    const existing = new Set<string>();
    if (accountId) {
      for (const part of chunks(planned.map((p) => p.dedupeKey))) {
        const found = await tx
          .select({ key: transactions.dedupeKey })
          .from(transactions)
          .where(
            and(
              // Also rows imported here and since moved to another account (TXN-12).
              or(
                eq(transactions.accountId, accountId),
                eq(transactions.importAccountId, accountId),
              ),
              eq(transactions.source, 'import'),
              inArray(transactions.dedupeKey, part),
            ),
          );
        for (const f of found) existing.add(f.key!);
      }
    }
    const kept: Planned[] = [];
    for (const p of planned) {
      if (existing.has(p.dedupeKey)) {
        results.push({ line: p.row.line, status: 'duplicate', message: 'Already imported' });
      } else {
        existing.add(p.dedupeKey); // the same id twice in one file
        kept.push(p);
      }
    }
    return kept;
  }

  /**
   * Possible duplicates of transactions already in the account (entered by hand, synced, or from
   * another file), not counting earlier parts of this batch: same amount within three days. Each
   * existing transaction matches at most one row, closest date first. Flagged and left out unless
   * the row is ticked.
   */
  async #removeOverlaps(
    tx: Executor,
    accountId: string | null,
    batchId: string | null,
    planned: Planned[],
    results: ImportRowResult[],
    include: Set<number>,
  ): Promise<Planned[]> {
    if (!accountId || planned.length === 0) return planned;
    const dates = planned.map((p) => p.row.date).sort();
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
          batchId
            ? or(isNull(transactions.importBatchId), ne(transactions.importBatchId, batchId))
            : undefined,
        ),
      );
    const byAmount = Map.groupBy(existing, (e) => e.amount);
    const claimed = new Set<string>();
    const kept: Planned[] = [];
    for (const p of [...planned].sort((a, b) => a.row.date.localeCompare(b.row.date))) {
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
    return kept.sort((a, b) => a.row.line - b.row.line);
  }

  /**
   * Category names → ids: your mapping first, then an existing category of the same name, then
   * the system categories, else a new category. New income and transfer categories join an
   * existing group of that kind; the rest go in a "From Monarch" (or "From import") group.
   * Without `activity` (a preview) nothing is created; it only reports what would be.
   */
  async #categories(
    tx: Executor,
    activity: HouseholdActivity | null,
    ctx: HouseholdContext,
    input: Pick<StartInput, 'categories' | 'format'>,
    names: string[],
    amounts: Map<string, Planned[]>,
  ): Promise<Resolved> {
    const ids = new Map<string, string>();
    const created: Resolved['created'] = [];
    if (names.length === 0) return { ids, created };
    const existing = (
      await tx
        .select({
          id: categories.id,
          name: categories.name,
          systemKey: categories.systemKey,
          archivedAt: categories.archivedAt,
        })
        .from(categories)
    ).filter((c) => !c.archivedAt);
    const groups = await tx.select().from(categoryGroups).orderBy(asc(categoryGroups.sortOrder));
    const explicit = new Map(input.categories.map((c) => [lower(c.name), c]));
    const groupName = `From ${input.format === 'monarch' ? 'Monarch' : 'import'}`;

    for (const name of [...new Set(names.map((n) => n.trim()))]) {
      const key = lower(name);
      if (ids.has(key)) continue;
      const mapped = explicit.get(key);
      if (mapped?.categoryId) {
        if (!existing.some((c) => c.id === mapped.categoryId)) {
          throw new Problem(422, 'invalid_category', `Choose an existing category for “${name}”`);
        }
        ids.set(key, mapped.categoryId);
        continue;
      }
      const match =
        existing.find((c) => lower(c.name) === key) ??
        existing.find((c) => c.systemKey !== null && c.systemKey === key);
      if (match) {
        ids.set(key, match.id);
        continue;
      }
      const kind: CategoryKind =
        mapped?.kind ??
        inferCategoryKind(
          name,
          (amounts.get(key) ?? []).map((p) => p.row.amountMinor),
        );
      let group =
        kind === 'income' || kind === 'transfer'
          ? groups.find((g) => g.kind === kind)
          : groups.find((g) => g.kind === kind && g.name === groupName);
      created.push({ name, kind, group: group?.name ?? groupName });
      if (!activity) continue;
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
      existing.push({ id: row!.id, name, systemKey: null, archivedAt: null });
      ids.set(key, row!.id);
      await activity.record({
        action: 'category.created',
        targetType: 'category',
        targetId: row!.id,
        changes: { after: { name } },
      });
    }
    return { ids, created };
  }

  /** Tag names → ids, matching existing tags by name and creating the rest (unless previewing). */
  async #tags(
    tx: Executor,
    activity: HouseholdActivity | null,
    ctx: HouseholdContext,
    list: string[],
  ): Promise<{ ids: Map<string, string>; created: string[] }> {
    const names = new Map<string, string>();
    for (const t of list) if (t.trim()) names.set(lower(t), t.trim());
    const ids = new Map<string, string>();
    const created: string[] = [];
    if (names.size === 0) return { ids, created };
    const existing = await tx.select({ id: tags.id, name: tags.name }).from(tags);
    for (const e of existing) ids.set(lower(e.name), e.id);
    let i = existing.length;
    for (const [key, name] of names) {
      if (ids.has(key)) continue;
      created.push(name);
      if (!activity) continue;
      const [row] = await tx
        .insert(tags)
        .values({
          householdId: ctx.householdId,
          name: name.slice(0, 40),
          color: MEMBER_COLORS[i++ % MEMBER_COLORS.length]!,
        })
        .returning({ id: tags.id });
      ids.set(key, row!.id);
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
    mapped: StartInput['members'],
  ): Promise<Map<string, string | null>> {
    const members = await tx
      .select({ id: householdMembers.id, name: householdMembers.displayName })
      .from(householdMembers)
      .where(
        and(eq(householdMembers.householdId, ctx.householdId), isNull(householdMembers.leftAt)),
      );
    const out = new Map<string, string | null>();
    for (const m of members) out.set(lower(m.name), m.id);
    for (const m of mapped) {
      if (m.memberId && !members.some((x) => x.id === m.memberId)) {
        throw new Problem(422, 'invalid_member', `“${m.name}” must be mapped to a current member`);
      }
      out.set(lower(m.name), m.memberId);
    }
    return out;
  }

  async #transactionDays(tx: Executor, accountId: string): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ day: transactions.authorizedDate })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt)));
    return rows.map((r) => r.day);
  }

  /**
   * The balances worth storing: the first day, days the balance changed, and days with
   * transactions, so every day reads the same as in the file (ADR 0011 carry-forward).
   */
  #balancesToStore(
    rows: { date: string; balanceMinor: number }[],
    txnDays: Set<string>,
    today: string,
  ): { date: string; balanceMinor: number }[] {
    const byDay = new Map<string, number>();
    for (const b of rows) if (b.date <= today) byDay.set(b.date, b.balanceMinor);
    const keep: { date: string; balanceMinor: number }[] = [];
    let previous: number | undefined;
    for (const date of [...byDay.keys()].sort()) {
      const value = byDay.get(date)!;
      if (previous === undefined || value !== previous || txnDays.has(date)) {
        keep.push({ date, balanceMinor: value });
      }
      previous = value;
    }
    return keep;
  }

  async #insertTransactions(
    tx: Executor,
    ctx: HouseholdContext,
    batch: Batch,
    currency: string,
    rows: Planned[],
    tagIds: Map<string, string>,
  ): Promise<string[]> {
    const ids = rows.map(() => uuidv7());
    const mapping = batch.mapping;
    // The household can keep the bank's text as the name instead (#42).
    const [household] = await tx
      .select({ clean: households.cleanMerchantNames })
      .from(households)
      .where(eq(households.id, ctx.householdId));
    const nameFrom = (description: string) =>
      household?.clean === false ? description.trim() : cleanMerchantName(description);
    for (const part of chunks(rows.map((p, i) => ({ p, id: ids[i]! })))) {
      await tx.insert(transactions).values(
        part.map(({ p, id }) => ({
          id,
          householdId: ctx.householdId,
          accountId: batch.accountId,
          amountMinor: p.row.amountMinor,
          currency,
          authorizedDate: p.row.date,
          postedDate: p.row.date,
          originalDescription: p.row.description.trim() || p.row.name!.trim(),
          // A name given in the file (Monarch's merchant) as is; otherwise from the bank's text,
          // which stays the original description (#42).
          displayName: p.row.name?.trim() || nameFrom(p.row.description),
          categoryId: p.row.category ? (mapping.categories[lower(p.row.category)] ?? null) : null,
          // What the file supplied counts as someone's decision: rules don't change it.
          fieldVersions: Object.fromEntries(
            [
              ...(p.row.name ? ['displayName'] : []),
              ...(p.row.category && mapping.categories[lower(p.row.category)]
                ? ['categoryId']
                : []),
              ...(p.row.tags?.length ? ['tagIds'] : []),
              ...(p.row.owner && mapping.members[lower(p.row.owner)] ? ['attribution'] : []),
            ].map((f) => [f, 1]),
          ),
          reviewStatus: p.row.reviewed ? ('reviewed' as const) : ('needs_review' as const),
          source: 'import' as const,
          importBatchId: batch.id,
          importAccountId: batch.accountId,
          dedupeKey: p.dedupeKey,
        })),
      );
    }
    const tagRows = rows.flatMap((p, i) =>
      [
        ...new Set(
          (p.row.tags ?? []).map((t) => tagIds.get(lower(t))).filter((t): t is string => !!t),
        ),
      ].map((tagId) => ({ transactionId: ids[i]!, tagId, householdId: ctx.householdId })),
    );
    for (const part of chunks(tagRows)) await tx.insert(transactionTags).values(part);

    // Monarch's Owner column: who the purchase was for. "Shared" and unmapped names set nothing.
    const attributions = rows.flatMap((p, i) => {
      const memberId = p.row.owner ? mapping.members[lower(p.row.owner)] : null;
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
    return ids;
  }

  /** Imported balances are entered balances, marked with their batch. Ones you entered win. */
  async #insertBalances(
    tx: Executor,
    ctx: HouseholdContext,
    batch: Batch,
    rows: { date: string; balanceMinor: number }[],
  ) {
    for (const part of chunks(rows)) {
      await tx
        .insert(balanceSnapshots)
        .values(
          part.map((b) => ({
            accountId: batch.accountId,
            householdId: ctx.householdId,
            asOf: b.date,
            balanceMinor: b.balanceMinor,
            source: 'manual' as const,
            importBatchId: batch.id,
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

  async #revertBatch(
    tx: Executor,
    activity: HouseholdActivity,
    ctx: HouseholdContext,
    batch: Batch,
    levels: Map<string, string>,
    moved: Set<string>,
  ) {
    if (batch.memberId !== ctx.memberId && levels.get(batch.accountId) !== 'owner') {
      throw problems.forbidden(
        'Only the person who imported this, or an owner of the account, can undo it.',
      );
    }
    const now = new Date();
    // The dedupe key is cleared so the same file can be imported again later.
    const reverted = await tx
      .update(transactions)
      .set({ deletedAt: now, dedupeKey: null })
      .where(and(eq(transactions.importBatchId, batch.id), isNull(transactions.deletedAt)))
      .returning({
        id: transactions.id,
        accountId: transactions.accountId,
        transferGroupId: transactions.transferGroupId,
      });
    // Transfers it linked: the other legs stand alone again.
    await unlinkTransfers(
      tx,
      activity,
      [...new Set(reverted.flatMap((r) => (r.transferGroupId ? [r.transferGroupId] : [])))],
      'reverted',
    );
    // Rows moved to another account since (TXN-12): that account's balance changes too.
    for (const r of reverted) if (r.accountId !== batch.accountId) moved.add(r.accountId);
    for (const ids of chunks(reverted.map((r) => r.id))) {
      await tx
        .update(transactions)
        .set({ deletedAt: now })
        .where(and(inArray(transactions.parentId, ids), isNull(transactions.deletedAt)));
    }
    await tx.delete(balanceSnapshots).where(eq(balanceSnapshots.importBatchId, batch.id));
    await tx
      .update(importBatches)
      .set({ revertedAt: now, revertedByMemberId: ctx.memberId })
      .where(eq(importBatches.id, batch.id));
    await activity.record({
      action: 'import.reverted',
      targetType: 'import_batch',
      targetId: batch.id,
      accountId: batch.accountId,
      metadata: { transactions: reverted.length },
    });
  }

  /**
   * Once a revert's batches are all undone: accounts an import created that are now empty are
   * removed, accounts it closed are reopened, and the rest recompute their balances. Done after
   * every batch, since batches of one run can share an account ("Combine with").
   */
  async #afterRevert(
    tx: Executor,
    activity: HouseholdActivity,
    batches: Batch[],
    moved: Set<string>,
  ) {
    for (const accountId of moved) {
      if (!batches.some((b) => b.accountId === accountId)) await recomputeBalances(tx, accountId);
    }
    for (const [accountId, list] of Map.groupBy(batches, (b) => b.accountId)) {
      if (list.some((b) => b.createdAccount) && (await this.#accountIsEmpty(tx, accountId))) {
        // The import made this account and nothing else is in it: undo that too.
        await tx.delete(accounts).where(eq(accounts.id, accountId));
        await activity.record({
          action: 'account.deleted',
          targetType: 'account',
          targetId: accountId,
          accountId,
          metadata: { reason: 'import_reverted' },
        });
        continue;
      }
      if (list.some((b) => b.closedAccount)) {
        await tx
          .update(accounts)
          .set({ closedAt: null, version: sql`${accounts.version} + 1` })
          .where(eq(accounts.id, accountId));
        await activity.record({
          action: 'account.reopened',
          targetType: 'account',
          targetId: accountId,
          accountId,
          metadata: { reason: 'import_reverted' },
        });
      }
      await recomputeBalances(tx, accountId);
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
      .where(
        and(
          eq(importBatches.accountId, accountId),
          isNull(importBatches.revertedAt),
          // A later import that added nothing here doesn't keep the account.
          or(
            sql`${importBatches.transactionCount} > 0`,
            sql`${importBatches.balanceCount} > 0`,
            eq(importBatches.closedAccount, true),
          ),
        ),
      )
      .limit(1);
    return !txn && !balance && !other;
  }

  #presentBatch(
    ctx: HouseholdContext,
    b: Batch,
    accountName: string | null,
    levels: Map<string, string>,
  ): ImportBatch {
    return {
      id: b.id,
      runId: b.runId,
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
