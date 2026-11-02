// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountLiabilities,
  accounts,
  type Executor,
  households,
  recurringMarks,
  recurringSeries,
  transactions,
} from '@fiscus/db';
import { accessLevels } from '@fiscus/ledger';
import {
  addDays,
  type createRecurringSchema,
  estimateCount,
  estimateNext,
  guessSchedule,
  LATE_AFTER_DAYS,
  type MarkOccurrence,
  nextOccurrences,
  occurrences,
  payOccurrences,
  RECURRING_DEFAULT_WINDOW,
  type RecurringCandidate,
  type RecurringDraft,
  type RecurringKind,
  type RecurringMatch,
  recurringMatches,
  type RecurringMonth,
  type RecurringOccurrence,
  type RecurringPayment,
  type RecurringPreview,
  type RecurringSchedule,
  type RecurringSeries,
  type RecurringSuggestion,
  type updateRecurringSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { todayIn } from '../common/dates.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type CreateInput = z.infer<typeof createRecurringSchema>;
type UpdateInput = z.infer<typeof updateRecurringSchema>;
type Row = typeof recurringSeries.$inferSelect;
type MarkRow = typeof recurringMarks.$inferSelect;

/** A series, or a draft of one: what working out its payments needs. */
interface SeriesLike {
  id?: string;
  accountId: string;
  match: unknown;
  schedule: unknown;
  windowDays: number;
  endedOn?: string | null;
}

/** How far back Upcoming looks for dates still late. */
const LATE_LOOKBACK_DAYS = 62;

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
        estimateMinor: estimateNext(paid, estimateCount(draft.schedule)),
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

  /**
   * A month of what's due (§4, §5): every series' dates in it, paid, late, due or skipped, and
   * card statements due in it, from the bank (D9). For the current month, dates still late from
   * before it come first.
   */
  async month(ctx: HouseholdContext, month: string): Promise<RecurringMonth> {
    return this.scope.run(ctx, async (tx) => {
      const today = await this.#today(tx, ctx);
      const [hh] = await tx
        .select({ currency: households.baseCurrency })
        .from(households)
        .where(eq(households.id, ctx.householdId));
      const start = `${month}-01`;
      const end = addDays(nextMonthStart(month), -1);
      const current = today >= start && today <= end;
      const lateFrom = current ? addDays(start, -LATE_LOOKBACK_DAYS) : start;
      const rows = await tx
        .select({ series: recurringSeries, currency: accounts.currency })
        .from(recurringSeries)
        .innerJoin(accounts, eq(accounts.id, recurringSeries.accountId))
        .orderBy(asc(recurringSeries.name));
      const out: RecurringOccurrence[] = [];
      const totals = {
        billsMinor: 0,
        billsPaidMinor: 0,
        incomeMinor: 0,
        incomeReceivedMinor: 0,
        statementsMinor: 0,
        subscriptionsMinor: 0,
        subscriptionCount: 0,
      };
      for (const { series, currency } of rows) {
        const schedule = series.schedule as RecurringSchedule;
        const { dates, payments, marks } = await this.#history(tx, series, today, end, lateFrom);
        const paidBy = new Map(payments.map((p) => [p.due, p]));
        const estimate = estimateNext(payments, estimateCount(schedule));
        // Dates before the series was made, and before its first payment, were never expected.
        const since = [payments[0]?.due, addDays(series.createdAt.toISOString().slice(0, 10), -31)]
          .filter((d) => d !== undefined)
          .sort()[0]!;
        const inMonth = dates.filter((d) => d >= start && d <= end);
        const counted = hh && currency === hh.currency;
        for (const due of dates.filter((d) => d >= lateFrom && d <= end)) {
          const mark = marks.get(due);
          const payment = paidBy.get(due);
          const status: RecurringOccurrence['status'] =
            mark?.mark === 'skipped'
              ? 'skipped'
              : payment || mark?.mark === 'paid'
                ? 'paid'
                : addDays(due, LATE_AFTER_DAYS) < today
                  ? 'late'
                  : 'due';
          if (due < start && status !== 'late') continue;
          if (status !== 'paid' && status !== 'skipped' && due < since) continue;
          const occurrence: RecurringOccurrence = {
            seriesId: series.id,
            name: series.name,
            kind: series.kind,
            accountId: series.accountId,
            currency,
            due,
            status,
            expectedMinor: payment?.amountMinor ?? estimate,
            payment: payment
              ? {
                  transactionId: payment.transactionId,
                  date: payment.date,
                  amountMinor: payment.amountMinor,
                }
              : mark?.mark === 'paid'
                ? { transactionId: null, date: null, amountMinor: null }
                : null,
          };
          out.push(occurrence);
          if (!counted || due < start || status === 'skipped') continue;
          const size = Math.abs(occurrence.expectedMinor ?? 0);
          const paidSize = Math.abs(payment?.amountMinor ?? (status === 'paid' ? size : 0));
          if (series.kind === 'income') {
            totals.incomeMinor += size;
            totals.incomeReceivedMinor += paidSize;
          } else if (series.kind !== 'transfer') {
            totals.billsMinor += size;
            totals.billsPaidMinor += paidSize;
          }
        }
        const ended = series.endedOn !== null && series.endedOn < start;
        if (series.kind === 'subscription' && counted && !ended) {
          totals.subscriptionCount += 1;
          totals.subscriptionsMinor += Math.abs(estimate ?? 0) * Math.max(1, inMonth.length);
        }
      }
      for (const st of await this.#statements(tx, lateFrom, end, today)) {
        if (st.due < start && st.status !== 'late') continue;
        out.push(st);
        if (hh && st.currency === hh.currency && st.due >= start) {
          totals.statementsMinor += Math.abs(st.expectedMinor ?? 0);
        }
      }
      out.sort(
        (a, b) =>
          a.due.localeCompare(b.due) ||
          a.name.localeCompare(b.name) ||
          a.accountId.localeCompare(b.accountId),
      );
      return { month, today, occurrences: out, totals };
    });
  }

  /**
   * Card statements due from `from` to `to`, from the bank (D9): paid once what's gone into the
   * card since the statement reaches its balance.
   */
  async #statements(
    tx: Executor,
    from: string,
    to: string,
    today: string,
  ): Promise<RecurringOccurrence[]> {
    const rows = await tx
      .select({ l: accountLiabilities, name: accounts.name, currency: accounts.currency })
      .from(accountLiabilities)
      .innerJoin(accounts, eq(accounts.id, accountLiabilities.accountId))
      .where(
        and(gte(accountLiabilities.nextDueDate, from), lte(accountLiabilities.nextDueDate, to)),
      );
    const out: RecurringOccurrence[] = [];
    for (const { l, name, currency } of rows) {
      const owed = -(l.lastStatementBalanceMinor ?? 0);
      if (owed <= 0 || !l.nextDueDate) continue;
      const [paid] = await tx
        .select({ total: sql<string>`coalesce(sum(${transactions.amountMinor}), 0)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, l.accountId),
            isNull(transactions.parentId),
            isNull(transactions.deletedAt),
            gt(transactions.amountMinor, 0),
            l.lastStatementDate ? gt(transactions.effectiveDate, l.lastStatementDate) : undefined,
          ),
        );
      const paidSoFar = Number(paid?.total ?? 0);
      const status: RecurringOccurrence['status'] =
        paidSoFar >= owed
          ? 'paid'
          : addDays(l.nextDueDate, LATE_AFTER_DAYS) < today
            ? 'late'
            : 'due';
      out.push({
        seriesId: null,
        name: `${name} statement`,
        kind: 'statement',
        accountId: l.accountId,
        currency,
        due: l.nextDueDate,
        status,
        expectedMinor: -owed,
        payment: null,
        minimumMinor: l.minimumPaymentMinor,
        paidSoFarMinor: paidSoFar,
      });
    }
    return out;
  }

  /** Says a date was paid (by a transaction, or another way) or skipped (D12). */
  async mark(ctx: HouseholdContext, id: string, due: string, input: MarkOccurrence): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [series] = await tx.select().from(recurringSeries).where(eq(recurringSeries.id, id));
      if (!series) throw problems.notFound();
      await this.#checkAccount(tx, series.accountId);
      if (!occurrences(series.schedule as RecurringSchedule, due, due).includes(due)) {
        throw new Problem(422, 'not_a_due_date', 'It isn’t due on that day');
      }
      const transactionId = input.status === 'paid' ? input.transactionId : null;
      if (transactionId) {
        const [t] = await tx
          .select({ accountId: transactions.accountId })
          .from(transactions)
          .where(and(eq(transactions.id, transactionId), isNull(transactions.deletedAt)));
        if (!t) throw problems.notFound();
        // The same transaction can't pay two dates: it moves to this one.
        await tx
          .delete(recurringMarks)
          .where(
            and(eq(recurringMarks.seriesId, id), eq(recurringMarks.transactionId, transactionId)),
          );
      }
      await tx
        .insert(recurringMarks)
        .values({
          householdId: ctx.householdId,
          seriesId: id,
          due,
          mark: input.status,
          transactionId,
          createdByMemberId: ctx.memberId,
        })
        .onConflictDoUpdate({
          target: [recurringMarks.seriesId, recurringMarks.due],
          set: {
            mark: input.status,
            transactionId,
            createdByMemberId: ctx.memberId,
            createdAt: new Date(),
          },
        });
      await activity.record({
        action: 'recurring.marked',
        targetType: 'recurring_series',
        targetId: id,
        accountId: series.accountId,
        metadata: { due, mark: input.status, transaction: transactionId !== null },
      });
    });
  }

  /** Takes a mark back: the date is worked out from the transactions again. */
  async unmark(ctx: HouseholdContext, id: string, due: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [series] = await tx.select().from(recurringSeries).where(eq(recurringSeries.id, id));
      if (!series) throw problems.notFound();
      await this.#checkAccount(tx, series.accountId);
      await tx
        .delete(recurringMarks)
        .where(and(eq(recurringMarks.seriesId, id), eq(recurringMarks.due, due)));
      await activity.record({
        action: 'recurring.unmarked',
        targetType: 'recurring_series',
        targetId: id,
        accountId: series.accountId,
        metadata: { due },
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

  /** The payments it's had, oldest first. */
  async #paid(tx: Executor, s: SeriesLike, today: string): Promise<RecurringPayment[]> {
    return (await this.#history(tx, s, today, today)).payments;
  }

  /**
   * Its dates from its first payment (or `from`, if earlier) to `until`, and the payments that
   * paid them: the closest match, a late one, or the one someone linked. Also what people marked.
   */
  async #history(
    tx: Executor,
    s: SeriesLike,
    today: string,
    until: string,
    from?: string,
  ): Promise<{ dates: string[]; payments: RecurringPayment[]; marks: Map<string, MarkRow> }> {
    const match = s.match as RecurringMatch;
    const marks = new Map<string, MarkRow>();
    if (s.id) {
      for (const m of await tx
        .select()
        .from(recurringMarks)
        .where(eq(recurringMarks.seriesId, s.id))) {
        marks.set(m.due, m);
      }
    }
    const linkedIds = [...marks.values()].flatMap((m) =>
      m.transactionId ? [m.transactionId] : [],
    );
    const linkedRows = linkedIds.length
      ? await tx
          .select({
            id: transactions.id,
            date: transactions.effectiveDate,
            amountMinor: transactions.amountMinor,
            displayName: transactions.displayName,
            originalDescription: transactions.originalDescription,
          })
          .from(transactions)
          .where(and(inArray(transactions.id, linkedIds), isNull(transactions.deletedAt)))
      : [];
    const byId = new Map(linkedRows.map((r) => [r.id, { ...r, date: r.date! }]));
    const linked = new Map<string, RecurringCandidate>();
    for (const m of marks.values()) {
      const t = m.transactionId ? byId.get(m.transactionId) : undefined;
      if (t) linked.set(m.due, t);
    }
    const candidates = (
      await this.#candidates(tx, s.accountId, match.direction, null, match)
    ).filter((c) => recurringMatches(match, c) && !byId.has(c.id));
    const first = [candidates[0]?.date, from, ...marks.keys()]
      .filter((d) => d !== undefined)
      .sort()[0];
    if (!first) return { dates: [], payments: [], marks };
    const end = s.endedOn && s.endedOn < until ? s.endedOn : until;
    const dates = occurrences(
      s.schedule as RecurringSchedule,
      addDays(first, -s.windowDays),
      addDays(end > today ? end : today, s.windowDays),
    ).filter((d) => d <= end);
    const payments = payOccurrences(
      dates.filter((d) => marks.get(d)?.mark !== 'skipped'),
      candidates,
      s.windowDays,
      linked,
    );
    return { dates, payments, marks };
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

const nextMonthStart = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};

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
    estimateMinor: estimateNext(paid, estimateCount(schedule)),
    recent: paid.slice(-RECENT).reverse(),
    paidCount: paid.length,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}
