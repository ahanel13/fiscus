// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, recurringMarks, transactionAttributions, transactions } from '@fiscus/db';
import {
  addDays,
  estimateCount,
  estimateNext,
  LATE_AFTER_DAYS,
  occurrences,
  payOccurrences,
  type RecurringCandidate,
  type RecurringMatch,
  recurringMatches,
  type RecurringPayment,
  type RecurringSchedule,
} from '@fiscus/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { ownersOnDates } from './owners.js';

// A series' payments (#118, #120; bills walkthrough D11, D12): not stored, but worked out from
// its account's transactions when it's read, for the api's pages and the worker's reminders
// (#127). Row-level security limits them to what the caller sees.

export type RecurringMarkRow = typeof recurringMarks.$inferSelect;

/** A series, or a draft of one: what working out its payments needs. */
export interface SeriesLike {
  id?: string;
  accountId: string;
  match: unknown;
  schedule: unknown;
  windowDays: number;
  endedOn?: string | null;
}

export interface SeriesHistory {
  dates: string[];
  payments: RecurringPayment[];
  marks: Map<string, RecurringMarkRow>;
}

/**
 * Its dates from its first payment (or `from`, if earlier) to `until`, and the payments that
 * paid them: the closest match, a late one, or the one someone linked. Also what people marked.
 */
export async function seriesHistory(
  tx: Executor,
  s: SeriesLike,
  today: string,
  until: string,
  from?: string,
): Promise<SeriesHistory> {
  const match = s.match as RecurringMatch;
  const marks = new Map<string, RecurringMarkRow>();
  if (s.id) {
    for (const m of await tx
      .select()
      .from(recurringMarks)
      .where(eq(recurringMarks.seriesId, s.id))) {
      marks.set(m.due, m);
    }
  }
  const linkedIds = [...marks.values()].flatMap((m) => (m.transactionId ? [m.transactionId] : []));
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
  const candidates = (await seriesCandidates(tx, s.accountId, match.direction, null, match)).filter(
    (c) => recurringMatches(match, c) && !byId.has(c.id),
  );
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
export async function seriesCandidates(
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

/** Who a payment is for: its own attribution, else its account's owners on its date. */
export async function paymentForMembers(
  tx: Executor,
  accountId: string,
  payment: { transactionId: string; date: string } | undefined,
  today: string,
): Promise<string[]> {
  if (payment) {
    const explicit = await tx
      .select({ memberId: transactionAttributions.memberId })
      .from(transactionAttributions)
      .where(eq(transactionAttributions.transactionId, payment.transactionId))
      .orderBy(desc(transactionAttributions.shareBps), asc(transactionAttributions.memberId));
    if (explicit.length) return explicit.map((a) => a.memberId);
  }
  const owners = await ownersOnDates(tx, [accountId]);
  return owners(accountId, payment?.date ?? today).map((o) => o.memberId);
}

/** One date a series was due, and how it stands (D12). */
export interface SeriesOccurrence {
  due: string;
  status: 'paid' | 'late' | 'due' | 'skipped';
  /** What paid it, or about how much is expected; signed as its payments are. */
  expectedMinor: number | null;
}

/**
 * The series' dates from `from` to `to`, as Upcoming shows them: paid (a payment, or marked
 * paid), skipped, late two days after the date with nothing paying it, or due. Dates before the
 * series was made, and before its first payment, were never expected, and aren't included.
 */
export function seriesOccurrences(
  s: { schedule: unknown; createdAt: Date },
  h: SeriesHistory,
  { today, from, to }: { today: string; from: string; to: string },
): SeriesOccurrence[] {
  const paidBy = new Map(h.payments.map((p) => [p.due, p]));
  const estimate = estimateNext(h.payments, estimateCount(s.schedule as RecurringSchedule));
  const since = [h.payments[0]?.due, addDays(s.createdAt.toISOString().slice(0, 10), -31)]
    .filter((d) => d !== undefined)
    .sort()[0]!;
  return h.dates
    .filter((due) => due >= from && due <= to)
    .flatMap((due): SeriesOccurrence[] => {
      const mark = h.marks.get(due);
      const payment = paidBy.get(due);
      const status: SeriesOccurrence['status'] =
        mark?.mark === 'skipped'
          ? 'skipped'
          : payment || mark?.mark === 'paid'
            ? 'paid'
            : addDays(due, LATE_AFTER_DAYS) < today
              ? 'late'
              : 'due';
      if (status !== 'paid' && status !== 'skipped' && due < since) return [];
      return [{ due, status, expectedMinor: payment?.amountMinor ?? estimate }];
    });
}
