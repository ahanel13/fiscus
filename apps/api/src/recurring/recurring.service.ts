// SPDX-License-Identifier: AGPL-3.0-or-later
import { accounts, type Executor, households, recurringSeries, transactions } from '@fiscus/db';
import { accessLevels } from '@fiscus/ledger';
import {
  addDays,
  type createRecurringSchema,
  estimateNext,
  guessSchedule,
  nextOccurrences,
  occurrences,
  payOccurrences,
  RECURRING_DEFAULT_WINDOW,
  type RecurringCandidate,
  type RecurringDraft,
  type RecurringKind,
  type RecurringMatch,
  recurringMatches,
  type RecurringPayment,
  type RecurringPreview,
  type RecurringSchedule,
  type RecurringSeries,
  type RecurringSuggestion,
  type updateRecurringSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, isNull, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { todayIn } from '../common/dates.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type CreateInput = z.infer<typeof createRecurringSchema>;
type UpdateInput = z.infer<typeof updateRecurringSchema>;
type Row = typeof recurringSeries.$inferSelect;

/** How many recent payments a series shows. */
const RECENT = 6;
/** How far back Make recurring looks for payments like the one it starts from. */
const SUGGEST_YEARS = 2;

const cannotChange = () =>
  new Problem(
    403,
    'account_not_editable',
    'You can’t change this account’s transactions',
    'A series needs owner or full access to its account.',
  );

/**
 * Recurring series (#118; bills walkthrough §1–§3): everyone who sees an account's transactions
 * sees its series (row-level security, 0068); owners and members with owner or full access to the
 * account make and change them. A series' payments aren't stored: they're its account's
 * transactions that match it, near each date it was due, worked out here when it's read.
 */
@Injectable()
export class RecurringService {
  constructor(private readonly scope: HouseholdScope) {}

  async list(ctx: HouseholdContext): Promise<RecurringSeries[]> {
    return this.scope.run(ctx, async (tx) => {
      const today = await this.#today(tx, ctx);
      const rows = await tx
        .select({ series: recurringSeries, currency: accounts.currency })
        .from(recurringSeries)
        .innerJoin(accounts, eq(accounts.id, recurringSeries.accountId))
        .orderBy(asc(recurringSeries.name), asc(recurringSeries.id));
      return Promise.all(
        rows.map(async ({ series, currency }) =>
          toSeries(series, currency, await this.#paid(tx, series, today), today),
        ),
      );
    });
  }

  /** What a draft would match and when it's next due: for the Make recurring dialog. */
  async preview(ctx: HouseholdContext, draft: RecurringDraft): Promise<RecurringPreview> {
    return this.scope.run(ctx, async (tx) => {
      const today = await this.#today(tx, ctx);
      const paid = await this.#paid(tx, draft, today);
      return {
        next: nextOccurrences(draft.schedule, today, 6),
        paidCount: paid.length,
        firstPaid: paid[0]?.date ?? null,
        estimateMinor: estimateNext(paid),
        recent: paid.slice(-RECENT).reverse(),
      };
    });
  }

  /**
   * A starting point from one transaction (D6): its account, its name, money in or out, an amount
   * range from the payments like it, and a schedule that fits their dates.
   */
  async suggest(ctx: HouseholdContext, transactionId: string): Promise<RecurringSuggestion> {
    return this.scope.run(ctx, async (tx) => {
      const [t] = await tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), isNull(transactions.deletedAt)));
      if (!t) throw problems.notFound();
      const direction = t.amountMinor > 0 ? 'in' : 'out';
      const like = (
        await this.#candidates(
          tx,
          t.accountId,
          direction,
          addDays(t.effectiveDate!, -366 * SUGGEST_YEARS),
        )
      ).filter((c) => c.displayName.trim().toLowerCase() === t.displayName.trim().toLowerCase());
      const sizes = like.map((c) => Math.abs(c.amountMinor));
      const lo = Math.min(...sizes, Math.abs(t.amountMinor));
      const hi = Math.max(...sizes, Math.abs(t.amountMinor));
      // Steady within 5% reads "about" it; anything wider gets 10% of room either side.
      const margin = hi - lo <= lo * 0.1 ? 0.05 : 0.1;
      const match: RecurringMatch = {
        direction,
        description: { op: 'equals', value: t.displayName },
        amount: { min: roundDown(lo * (1 - margin)), max: roundUp(hi * (1 + margin)) },
      };
      const schedule: RecurringSchedule = guessSchedule(
        like.map((c) => c.date),
        direction,
      ) ?? {
        unit: 'month',
        every: 1,
        days: [Number(t.effectiveDate!.slice(8, 10))],
        anchor: t.effectiveDate!,
        weekend: direction === 'in' ? 'before' : 'after',
      };
      const kind: RecurringKind = t.transferGroupId
        ? 'transfer'
        : direction === 'in'
          ? 'income'
          : 'bill';
      return {
        name: t.displayName,
        kind,
        draft: { accountId: t.accountId, match, schedule, windowDays: RECURRING_DEFAULT_WINDOW },
      };
    });
  }

  async create(ctx: HouseholdContext, input: CreateInput): Promise<RecurringSeries> {
    return this.scope.run(ctx, async (tx, activity) => {
      await this.#checkAccount(tx, input.accountId);
      const [row] = await tx
        .insert(recurringSeries)
        .values({
          householdId: ctx.householdId,
          accountId: input.accountId,
          name: input.name,
          kind: input.kind,
          match: input.match,
          schedule: input.schedule,
          windowDays: input.windowDays,
          createdByMemberId: ctx.memberId,
        })
        .returning();
      await activity.record({
        action: 'recurring.created',
        targetType: 'recurring_series',
        targetId: row!.id,
        accountId: input.accountId,
        metadata: { kind: input.kind },
        changes: { after: { name: input.name, match: input.match, schedule: input.schedule } },
      });
      return this.#read(tx, ctx, row!);
    });
  }

  async update(ctx: HouseholdContext, id: string, patch: UpdateInput): Promise<RecurringSeries> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [before] = await tx.select().from(recurringSeries).where(eq(recurringSeries.id, id));
      if (!before) throw problems.notFound();
      await this.#checkAccount(tx, before.accountId);
      const [row] = await tx
        .update(recurringSeries)
        .set({ ...patch, version: before.version + 1, updatedAt: new Date() })
        .where(eq(recurringSeries.id, id))
        .returning();
      await activity.record({
        action: 'recurring.updated',
        targetType: 'recurring_series',
        targetId: id,
        accountId: before.accountId,
        metadata: { fields: Object.keys(patch) },
        changes: {
          before: Object.fromEntries(
            Object.keys(patch).map((k) => [k, before[k as keyof typeof before]]),
          ),
          after: patch,
        },
      });
      return this.#read(tx, ctx, row!);
    });
  }

  async remove(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [before] = await tx.select().from(recurringSeries).where(eq(recurringSeries.id, id));
      if (!before) throw problems.notFound();
      await this.#checkAccount(tx, before.accountId);
      await tx.delete(recurringSeries).where(eq(recurringSeries.id, id));
      await activity.record({
        action: 'recurring.deleted',
        targetType: 'recurring_series',
        targetId: id,
        accountId: before.accountId,
        metadata: { kind: before.kind },
        changes: { before: { name: before.name } },
      });
    });
  }

  async #read(tx: Executor, ctx: HouseholdContext, row: Row): Promise<RecurringSeries> {
    const today = await this.#today(tx, ctx);
    const [account] = await tx
      .select({ currency: accounts.currency })
      .from(accounts)
      .where(eq(accounts.id, row.accountId));
    return toSeries(row, account!.currency, await this.#paid(tx, row, today), today);
  }

  /** Owner or full access to the account: the same as changing its transactions. */
  async #checkAccount(tx: Executor, accountId: string) {
    const level = (await accessLevels(tx)).get(accountId);
    if (!level) throw problems.notFound();
    if (level !== 'owner' && level !== 'full') throw cannotChange();
  }

  /** The payments it's had, oldest first: each date up to today, paid by the closest match. */
  async #paid(
    tx: Executor,
    s: {
      accountId: string;
      match: unknown;
      schedule: unknown;
      windowDays: number;
      endedOn?: string | null;
    },
    today: string,
  ): Promise<RecurringPayment[]> {
    const match = s.match as RecurringMatch;
    const candidates = (
      await this.#candidates(tx, s.accountId, match.direction, null, match)
    ).filter((c) => recurringMatches(match, c));
    if (candidates.length === 0) return [];
    const last = s.endedOn && s.endedOn < today ? s.endedOn : today;
    const dates = occurrences(
      s.schedule as RecurringSchedule,
      addDays(candidates[0]!.date, -s.windowDays),
      addDays(last, s.windowDays),
    );
    return payOccurrences(dates, candidates, s.windowDays);
  }

  /**
   * The account's transactions in one direction, oldest first: whole transactions, not their
   * split parts, and not deleted. The amount condition narrows it in the database.
   */
  async #candidates(
    tx: Executor,
    accountId: string,
    direction: 'in' | 'out',
    from: string | null,
    match?: RecurringMatch,
  ): Promise<RecurringCandidate[]> {
    const size = sql`abs(${transactions.amountMinor})`;
    const rows = await tx
      .select({
        id: transactions.id,
        date: transactions.effectiveDate,
        amountMinor: transactions.amountMinor,
        displayName: transactions.displayName,
        originalDescription: transactions.originalDescription,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, accountId),
          isNull(transactions.parentId),
          isNull(transactions.deletedAt),
          direction === 'in' ? gt(transactions.amountMinor, 0) : lt(transactions.amountMinor, 0),
          from ? gte(transactions.effectiveDate, from) : undefined,
          match?.amount?.min !== undefined ? sql`${size} >= ${match.amount.min}` : undefined,
          match?.amount?.max !== undefined ? sql`${size} <= ${match.amount.max}` : undefined,
        ),
      )
      .orderBy(asc(transactions.effectiveDate), asc(transactions.id));
    return rows.map((r) => ({ ...r, date: r.date! }));
  }

  async #today(tx: Executor, ctx: HouseholdContext): Promise<string> {
    const [hh] = await tx
      .select({ timezone: households.timezone })
      .from(households)
      .where(eq(households.id, ctx.householdId));
    if (!hh) throw problems.notFound();
    return todayIn(hh.timezone);
  }
}

const roundDown = (minor: number) => Math.max(0, Math.floor(minor / 100) * 100);
const roundUp = (minor: number) => Math.ceil(minor / 100) * 100;

function toSeries(
  row: Row,
  currency: string,
  paid: RecurringPayment[],
  today: string,
): RecurringSeries {
  const schedule = row.schedule as RecurringSchedule;
  const paidDues = new Set(paid.map((p) => p.due));
  // The next date it's due that hasn't already been paid (a paycheck in a day early).
  const upcoming = nextOccurrences(schedule, today, 3).find((d) => !paidDues.has(d)) ?? null;
  const next = upcoming && row.endedOn && upcoming > row.endedOn ? null : upcoming;
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    kind: row.kind,
    match: row.match as RecurringMatch,
    schedule,
    windowDays: row.windowDays,
    endedOn: row.endedOn,
    currency,
    next,
    estimateMinor: estimateNext(paid),
    recent: paid.slice(-RECENT).reverse(),
    paidCount: paid.length,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}
