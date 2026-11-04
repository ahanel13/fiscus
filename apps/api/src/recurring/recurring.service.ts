// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accounts,
  type Executor,
  households,
  recurringDismissals,
  recurringMarks,
  recurringSeries,
  transactions,
} from '@fiscus/db';
import {
  accessLevels,
  cardStatements,
  type SeriesLike,
  changesOf,
  seriesCandidates,
  seriesHistory,
  seriesOccurrences,
  type SeriesPeople,
  seriesPeople,
  seriesWho,
  type SeriesWho,
} from '@fiscus/ledger';
import {
  addDays,
  type createRecurringSchema,
  type DetectedSeries,
  type DetectGroup,
  detectRecurring,
  estimateCount,
  estimateNext,
  guessSchedule,
  type MarkOccurrence,
  nextOccurrences,
  occurrences,
  RECURRING_DEFAULT_WINDOW,
  type RecurringDraft,
  type RecurringKind,
  type RecurringMatch,
  recurringMatches,
  type RecurringMonth,
  type RecurringOccurrence,
  recurringKey,
  type RecurringPayment,
  type RecurringPreview,
  type RecurringSchedule,
  type RecurringSeries,
  type RecurringSuggestion,
  type SeriesChanges,
  type updateRecurringSchema,
  whoLooksAfter,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { todayIn } from '../common/dates.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type CreateInput = z.infer<typeof createRecurringSchema>;
type UpdateInput = z.infer<typeof updateRecurringSchema>;
type Row = typeof recurringSeries.$inferSelect;

/** The most suggestions shown at once: the most-paid first. */
const MAX_SUGGESTIONS = 50;

/** How far back Upcoming looks for dates still late. */
const LATE_LOOKBACK_DAYS = 62;

/** How many recent payments a series shows. */
const RECENT = 6;
/** How far back Make recurring looks for payments like the one it starts from. */
const SUGGEST_YEARS = 2;

const cannotSee = () =>
  new Problem(
    422,
    'member_cannot_see_account',
    'They can’t see this account',
    'Only someone who sees its account can look after it.',
  );

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
      const people = await seriesPeople(tx);
      const rows = await tx
        .select({ series: recurringSeries, currency: accounts.currency })
        .from(recurringSeries)
        .innerJoin(accounts, eq(accounts.id, recurringSeries.accountId))
        .orderBy(asc(recurringSeries.name), asc(recurringSeries.id));
      return Promise.all(
        rows.map(async ({ series, currency }) => {
          const history = await seriesHistory(tx, series, today, today);
          const paid = history.payments;
          return toSeries(series, currency, paid, today, {
            ...(await seriesWho(tx, series, people, paid)),
            changes: changesOf(series, history, today),
          });
        }),
      );
    });
  }

  /** What a draft would match and when it's next due: for the Make recurring dialog. */
  async preview(ctx: HouseholdContext, draft: RecurringDraft): Promise<RecurringPreview> {
    return this.scope.run(ctx, async (tx) => {
      const today = await this.#today(tx, ctx);
      const paid = await this.#paid(tx, draft, today);
      const people = await seriesPeople(tx);
      return {
        responsibleMemberId: whoLooksAfter({
          kind: 'bill',
          responsibleMemberId: null,
          createdByMemberId: ctx.memberId,
          seenBy: people.seenBy(draft.accountId),
          accountOwners: people.owners(draft.accountId),
          householdOwners: people.householdOwners,
        }),
        seenBy: people.seenBy(draft.accountId),
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
        await seriesCandidates(
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
      const people = await seriesPeople(tx);
      const seenBy = people.seenBy(input.accountId);
      if (input.responsibleMemberId && !seenBy.includes(input.responsibleMemberId)) {
        throw cannotSee();
      }
      // Who looks after it from now on (D13): whoever was chosen, else the account's only owner,
      // else whoever confirms it. Kept, so a later change of owners doesn't move it.
      const responsibleMemberId = whoLooksAfter({
        kind: input.kind,
        responsibleMemberId: input.responsibleMemberId ?? null,
        createdByMemberId: ctx.memberId,
        seenBy,
        accountOwners: people.owners(input.accountId),
        householdOwners: people.householdOwners,
      });
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
          responsibleMemberId,
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
   * Hands a series to someone else who sees its account (D13; REC-04). Anyone who sees the series
   * can, view-only access included: it changes who's reminded, nothing else.
   */
  async handOver(ctx: HouseholdContext, id: string, memberId: string): Promise<RecurringSeries> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [before] = await tx.select().from(recurringSeries).where(eq(recurringSeries.id, id));
      if (!before) throw problems.notFound();
      if (before.kind === 'income') {
        throw new Problem(
          422,
          'income_has_no_owner',
          'Income has no one looking after it',
          'Who it’s for comes from its payments.',
        );
      }
      const people = await seriesPeople(tx);
      if (!people.seenBy(before.accountId).includes(memberId)) throw cannotSee();
      const { rows } = await tx.execute<{ changed: boolean }>(
        sql`SELECT fiscus_hand_over_series(${id}::uuid, ${memberId}::uuid) AS changed`,
      );
      if (!rows[0]?.changed) throw problems.notFound();
      await activity.record({
        action: 'recurring.handed_over',
        targetType: 'recurring_series',
        targetId: id,
        accountId: before.accountId,
        metadata: { to: memberId },
        changes: {
          before: { responsibleMemberId: before.responsibleMemberId },
          after: { responsibleMemberId: memberId },
        },
      });
      const [row] = await tx.select().from(recurringSeries).where(eq(recurringSeries.id, id));
      return this.#read(tx, ctx, row!);
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
      const people = await seriesPeople(tx);
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
      for (const {
        series,
        currency,
        estimate,
        inRange,
        occurrences: list,
      } of await seriesOccurrences(tx, { start, end, lateFrom, today })) {
        const counted = hh && currency === hh.currency;
        for (const occurrence of list) {
          out.push(occurrence);
          const { due, status } = occurrence;
          if (!counted || due < start || status === 'skipped') continue;
          const size = Math.abs(occurrence.expectedMinor ?? 0);
          const paidSize = Math.abs(
            occurrence.payment?.amountMinor ?? (status === 'paid' ? size : 0),
          );
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
          totals.subscriptionsMinor += Math.abs(estimate ?? 0) * Math.max(1, inRange.length);
        }
      }
      for (const st of await this.#statements(tx, lateFrom, end, today, people)) {
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
   * card since the statement reaches its balance; minimum paid, or partly paid, with less. Seen by
   * those who see the card's statement details (owner and full access); whose card it is shows
   * where more than one of them does (D22).
   */
  async #statements(
    tx: Executor,
    from: string,
    to: string,
    today: string,
    people: SeriesPeople,
  ): Promise<RecurringOccurrence[]> {
    return (await cardStatements(tx, { from, to, today })).map((st) => ({
      seriesId: null,
      name: `${st.accountName} statement`,
      kind: 'statement',
      accountId: st.accountId,
      currency: st.currency,
      due: st.due,
      status: st.status,
      expectedMinor: -st.owedMinor,
      payment: null,
      minimumMinor: st.minimumMinor,
      paidSoFarMinor: st.paidSoFarMinor,
      statementPaid: st.paid,
      memberIds: people.owners(st.accountId),
      shared: people.seeStatement(st.accountId).length > 1,
    }));
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

  /**
   * What looks recurring in the history you can change (§2, D3–D5): payments grouped by account,
   * direction and name, steady enough to be a series, still coming, and not already one of yours
   * or put away with "Not recurring".
   */
  async suggestions(ctx: HouseholdContext): Promise<DetectedSeries[]> {
    return this.scope.run(ctx, async (tx) => {
      const today = await this.#today(tx, ctx);
      const levels = await accessLevels(tx);
      const rows = await tx
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          date: transactions.effectiveDate,
          amountMinor: transactions.amountMinor,
          displayName: transactions.displayName,
          originalDescription: transactions.originalDescription,
          transferGroupId: transactions.transferGroupId,
        })
        .from(transactions)
        .where(and(isNull(transactions.parentId), isNull(transactions.deletedAt)))
        .orderBy(asc(transactions.effectiveDate), asc(transactions.id));
      const series = await tx.select().from(recurringSeries);
      const dismissed = new Set(
        (await tx.select().from(recurringDismissals)).map(
          (d) => `${d.accountId}|${d.direction}|${d.key}`,
        ),
      );
      const groups = new Map<string, DetectGroup>();
      for (const r of rows) {
        const level = levels.get(r.accountId);
        if (level !== 'owner' && level !== 'full') continue;
        if (r.amountMinor === 0) continue;
        const direction = r.amountMinor > 0 ? 'in' : 'out';
        const key = recurringKey(r.displayName);
        if (!key) continue;
        const id = `${r.accountId}|${direction}|${key}`;
        if (dismissed.has(id)) continue;
        let g = groups.get(id);
        if (!g) {
          g = {
            accountId: r.accountId,
            direction,
            key,
            name: r.displayName,
            payments: [],
            transfer: false,
          };
          groups.set(id, g);
        }
        g.payments.push({ ...r, date: r.date! });
        g.name = r.displayName;
        if (r.transferGroupId) g.transfer = true;
      }
      const out: { found: DetectedSeries; g: DetectGroup }[] = [];
      for (const g of groups.values()) {
        if (g.payments.length < 2) continue;
        // Already one of yours: a series on the account that takes most of these payments.
        const covered = series.some((s) => {
          const m = s.match as RecurringMatch;
          if (s.accountId !== g.accountId || m.direction !== g.direction) return false;
          const hits = g.payments.filter((p) => recurringMatches(m, p)).length;
          return hits >= g.payments.length / 2;
        });
        if (covered) continue;
        const found = detectRecurring(g, today);
        if (found) out.push({ found, g });
      }
      // Who would look after each, shown on the suggestion so it can be changed first (D13).
      const people = await seriesPeople(tx);
      return Promise.all(
        out
          .sort((a, b) => b.found.seenCount - a.found.seenCount)
          .slice(0, MAX_SUGGESTIONS)
          .map(async ({ found, g }) => {
            const latest = g.payments.at(-1)!;
            const who = await seriesWho(
              tx,
              {
                kind: found.kind,
                accountId: g.accountId,
                responsibleMemberId: null,
                createdByMemberId: ctx.memberId,
              },
              people,
              [{ due: latest.date, transactionId: latest.id, date: latest.date, amountMinor: 0 }],
            );
            return { ...found, ...who };
          }),
      );
    });
  }

  /** "Not recurring" (D5): detection doesn't suggest these payments again. */
  async dismiss(
    ctx: HouseholdContext,
    input: { accountId: string; direction: 'in' | 'out'; key: string },
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      await this.#checkAccount(tx, input.accountId);
      await tx
        .insert(recurringDismissals)
        .values({ householdId: ctx.householdId, ...input, createdByMemberId: ctx.memberId })
        .onConflictDoNothing();
      await activity.record({
        action: 'recurring.dismissed',
        targetType: 'account',
        targetId: input.accountId,
        accountId: input.accountId,
        metadata: { direction: input.direction },
      });
    });
  }

  async #read(tx: Executor, ctx: HouseholdContext, row: Row): Promise<RecurringSeries> {
    const today = await this.#today(tx, ctx);
    const [account] = await tx
      .select({ currency: accounts.currency })
      .from(accounts)
      .where(eq(accounts.id, row.accountId));
    const history = await seriesHistory(tx, row, today, today);
    const paid = history.payments;
    const who = await seriesWho(tx, row, await seriesPeople(tx), paid);
    return toSeries(row, account!.currency, paid, today, {
      ...who,
      changes: changesOf(row, history, today),
    });
  }

  /** Owner or full access to the account: the same as changing its transactions. */
  async #checkAccount(tx: Executor, accountId: string) {
    const level = (await accessLevels(tx)).get(accountId);
    if (!level) throw problems.notFound();
    if (level !== 'owner' && level !== 'full') throw cannotChange();
  }

  /** The payments it's had, oldest first. */
  async #paid(tx: Executor, s: SeriesLike, today: string): Promise<RecurringPayment[]> {
    return (await seriesHistory(tx, s, today, today)).payments;
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
  who: SeriesWho & { changes: SeriesChanges },
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
    lastPaid: paid.at(-1)?.date ?? null,
    ...who,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}
