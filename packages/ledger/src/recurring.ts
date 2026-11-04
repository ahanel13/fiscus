// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountLiabilities,
  accountOwners,
  accounts,
  type Executor,
  householdMembers,
  households,
  recurringMarks,
  recurringSeries,
  transactionAttributions,
  transactions,
} from '@fiscus/db';
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
  type RecurringOccurrence,
  type RecurringPayment,
  type RecurringSchedule,
  type RecurringSeries,
  type SeriesChanges,
  seriesChanges,
  type StatementPaid,
  statementPaid,
  whoLooksAfter,
} from '@fiscus/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { ownersOnDates } from './owners.js';

// Who sees a series, and who looks after it (#121; bills walkthrough D13, D22). For the api's
// pages, and for notifications (#127), which remind only the person who looks after a bill.
// Row-level security limits what's read to what the caller sees; in system context (the worker),
// everything in the household.

type Row = typeof recurringSeries.$inferSelect;
type MarkRow = typeof recurringMarks.$inferSelect;
/** Who looks after a series, who it's for, and who sees it, as the api returns them. */
export type SeriesWho = Pick<RecurringSeries, 'responsibleMemberId' | 'forMemberIds' | 'seenBy'>;
type Who = SeriesWho;

/** A series, or a draft of one: what working out its payments needs. */
export interface SeriesLike {
  id?: string;
  accountId: string;
  match: unknown;
  schedule: unknown;
  windowDays: number;
  endedOn?: string | null;
}

export interface SeriesPeople {
  /** The household's current members who see an account's series, in the order they joined. */
  seenBy(accountId: string): string[];
  /** An account's current owners, largest share first. */
  owners(accountId: string): string[];
  /**
   * The household's current members who see a card's statement: its owners, and everyone when
   * it's shared in full (statement details are for owner and full access, migration 0041).
   */
  seeStatement(accountId: string): string[];
  /** The household's current owners, in the order they joined. */
  householdOwners: string[];
}

/**
 * Who sees each account's series: its owners, and everyone in the household when it's shared in
 * full or view-only (balance-only members see the balance, not the transactions).
 */
export async function seriesPeople(tx: Executor): Promise<SeriesPeople> {
  const members = await tx
    .select({ id: householdMembers.id, role: householdMembers.role })
    .from(householdMembers)
    .where(
      sql`${householdMembers.householdId} = fiscus_household() AND ${householdMembers.leftAt} IS NULL`,
    )
    .orderBy(asc(householdMembers.joinedAt), asc(householdMembers.id));
  const current = new Set(members.map((m) => m.id));
  const visibility = new Map(
    (await tx.select({ id: accounts.id, visibility: accounts.visibility }).from(accounts)).map(
      (a) => [a.id, a.visibility],
    ),
  );
  const owners = new Map<string, { memberId: string; shareBps: number }[]>();
  for (const o of await tx.select().from(accountOwners)) {
    if (!current.has(o.memberId)) continue;
    owners.set(o.accountId, [...(owners.get(o.accountId) ?? []), o]);
  }
  const ownersOf = (accountId: string) =>
    (owners.get(accountId) ?? [])
      .sort((a, b) => b.shareBps - a.shareBps || a.memberId.localeCompare(b.memberId))
      .map((o) => o.memberId);
  return {
    owners: ownersOf,
    seenBy: (accountId) => {
      const v = visibility.get(accountId);
      if (!v) return [];
      const own = new Set(ownersOf(accountId));
      const shared = v === 'full' || v === 'view_only';
      return members.filter((m) => shared || own.has(m.id)).map((m) => m.id);
    },
    seeStatement: (accountId) => {
      const v = visibility.get(accountId);
      if (!v) return [];
      const own = new Set(ownersOf(accountId));
      return members.filter((m) => v === 'full' || own.has(m.id)).map((m) => m.id);
    },
    householdOwners: members.filter((m) => m.role === 'owner').map((m) => m.id),
  };
}

/**
 * Who gets the reminders for a series' occurrences (D13): the one person who looks after it, while
 * they still see its account; otherwise whoever the defaults give. Empty for income (no reminders),
 * for a series nobody left can see, and for one the caller can't see. Every occurrence of a series
 * goes to the same person, so this takes the series.
 */
export async function reminderRecipients(tx: Executor, seriesId: string): Promise<string[]> {
  const [s] = await tx
    .select({
      kind: recurringSeries.kind,
      accountId: recurringSeries.accountId,
      responsibleMemberId: recurringSeries.responsibleMemberId,
      createdByMemberId: recurringSeries.createdByMemberId,
    })
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId));
  if (!s) return [];
  const people = await seriesPeople(tx);
  const who = whoLooksAfter({
    ...s,
    seenBy: people.seenBy(s.accountId),
    accountOwners: people.owners(s.accountId),
    householdOwners: people.householdOwners,
  });
  return who ? [who] : [];
}

/** Every series a member looks after, for their reminders: not income, not ended before `today`. */
export async function seriesLookedAfterBy(
  tx: Executor,
  memberId: string,
  today: string,
): Promise<string[]> {
  const rows = await tx
    .select({
      id: recurringSeries.id,
      kind: recurringSeries.kind,
      accountId: recurringSeries.accountId,
      responsibleMemberId: recurringSeries.responsibleMemberId,
      createdByMemberId: recurringSeries.createdByMemberId,
      endedOn: recurringSeries.endedOn,
    })
    .from(recurringSeries)
    .where(sql`${recurringSeries.endedOn} IS NULL OR ${recurringSeries.endedOn} >= ${today}`);
  const people = await seriesPeople(tx);
  return rows
    .filter(
      (s) =>
        whoLooksAfter({
          ...s,
          seenBy: people.seenBy(s.accountId),
          accountOwners: people.owners(s.accountId),
          householdOwners: people.householdOwners,
        }) === memberId,
    )
    .map((s) => s.id);
}

/**
 * Who looks after a series (D13), who sees it (D22), and for income, who it's for: its latest
 * payment's attribution, else whoever owned the account then (or owns it now, with none yet).
 */
export async function seriesWho(
  tx: Executor,
  row: Pick<Row, 'kind' | 'accountId' | 'responsibleMemberId' | 'createdByMemberId'>,
  people: SeriesPeople,
  paid: readonly RecurringPayment[],
): Promise<Who> {
  const seenBy = people.seenBy(row.accountId);
  const responsibleMemberId = whoLooksAfter({
    ...row,
    seenBy,
    accountOwners: people.owners(row.accountId),
    householdOwners: people.householdOwners,
  });
  if (row.kind !== 'income') return { responsibleMemberId, forMemberIds: [], seenBy };
  const latest = [...paid].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  return {
    responsibleMemberId,
    forMemberIds: await forMembers(tx, row.accountId, latest),
    seenBy,
  };
}

/** Who a payment is for: its own attribution, else its account's owners on its date. */
async function forMembers(
  tx: Executor,
  accountId: string,
  payment: { transactionId: string; date: string } | undefined,
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
  return owners(accountId, payment?.date ?? (await householdToday(tx))).map((o) => o.memberId);
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

/** Today in the household's time zone. */
export async function householdToday(tx: Executor): Promise<string> {
  const [hh] = await tx
    .select({ timezone: households.timezone })
    .from(households)
    .where(sql`${households.id} = fiscus_household()`);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: hh?.timezone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// ── Occurrences (#120; bills walkthrough §4, §5) ────────────────────────────────────────────

/** One series' dates from `lateFrom` to `end`, with the context totals need. */
export interface SeriesDates {
  series: Row;
  currency: string;
  /** About how much the next one is (D8). */
  estimate: number | null;
  /** Its dates from `start` to `end`, whatever their status. */
  inRange: string[];
  /** Its occurrences: from `start`, and late ones from `lateFrom`. */
  occurrences: RecurringOccurrence[];
  /** What's changed worth noticing (D14). */
  changes: SeriesChanges;
}

/** A series' changes worth noticing (D14), from its history as `seriesHistory()` gives it. */
export function changesOf(
  series: Pick<Row, 'kind' | 'createdAt' | 'endedOn'>,
  h: { dates: string[]; payments: RecurringPayment[]; marks: Map<string, MarkRow> },
  today: string,
): SeriesChanges {
  const createdOn = series.createdAt.toISOString().slice(0, 10);
  const since = [h.payments[0]?.due, addDays(createdOn, -31)]
    .filter((d) => d !== undefined)
    .sort()[0]!;
  const marked = [...h.marks.values()];
  return seriesChanges({
    kind: series.kind,
    payments: h.payments.filter((p) => p.date <= today),
    dates: h.dates.filter((d) => d <= today),
    skipped: new Set(marked.filter((m) => m.mark === 'skipped').map((m) => m.due)),
    markedPaid: new Set(marked.filter((m) => m.mark === 'paid').map((m) => m.due)),
    since,
    createdOn,
    endedOn: series.endedOn,
    today,
  });
}

/**
 * Every series' occurrences from `start` to `end` (paid, late, due or skipped), with late ones
 * from `lateFrom` too (D12), on the accounts the caller sees. Dates before a series was made, and
 * before its first payment, were never expected.
 */
export async function seriesOccurrences(
  tx: Executor,
  { start, end, lateFrom, today }: { start: string; end: string; lateFrom: string; today: string },
): Promise<SeriesDates[]> {
  const people = await seriesPeople(tx);
  const rows = await tx
    .select({ series: recurringSeries, currency: accounts.currency })
    .from(recurringSeries)
    .innerJoin(accounts, eq(accounts.id, recurringSeries.accountId))
    .orderBy(asc(recurringSeries.name));
  const out: SeriesDates[] = [];
  for (const { series, currency } of rows) {
    const schedule = series.schedule as RecurringSchedule;
    const history = await seriesHistory(tx, series, today, end, lateFrom);
    const { dates, payments, marks } = history;
    const changes = changesOf(series, history, today);
    const paidBy = new Map(payments.map((p) => [p.due, p]));
    const estimate = estimateNext(payments, estimateCount(schedule));
    const since = [payments[0]?.due, addDays(series.createdAt.toISOString().slice(0, 10), -31)]
      .filter((d) => d !== undefined)
      .sort()[0]!;
    const who = await seriesWho(tx, series, people, payments);
    const memberIds =
      series.kind === 'income'
        ? who.forMemberIds
        : who.responsibleMemberId
          ? [who.responsibleMemberId]
          : [];
    const list: RecurringOccurrence[] = [];
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
      list.push({
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
        memberIds,
        shared: who.seenBy.length > 1,
        changes,
      });
    }
    out.push({
      series,
      currency,
      estimate,
      changes,
      inRange: dates.filter((d) => d >= start && d <= end),
      occurrences: list,
    });
  }
  return out;
}

// ── Card statements (#122; bills walkthrough D9) ────────────────────────────────────────────

/** A card's statement, from the bank (Plaid liabilities, #86): what's owed, by when, and paid. */
export interface CardStatement {
  accountId: string;
  accountName: string;
  currency: string;
  due: string;
  /** The day the statement closed; payments after it count toward it. */
  statementDate: string | null;
  /** Its balance, positive. */
  owedMinor: number;
  minimumMinor: number | null;
  /** What's gone into the card since the statement date. */
  paidSoFarMinor: number;
  paid: StatementPaid;
  /**
   * `paid` once the balance or the minimum is paid; else `late` two days after its due date
   * (D12), or `due`.
   */
  status: 'paid' | 'due' | 'late';
}

/**
 * Card statements due from `from` to `to` (D9), on the cards the caller sees statements of (owner
 * and full access; everything in system context). Payments into the card since the statement
 * date pay it: all of it, its minimum, or part. Cards with no statement from the bank (SimpleFIN,
 * manual ones) have none. `accountIds` narrows it to some cards.
 */
export async function cardStatements(
  tx: Executor,
  {
    from,
    to,
    today,
    accountIds,
  }: { from: string; to: string; today: string; accountIds?: string[] },
): Promise<CardStatement[]> {
  if (accountIds && accountIds.length === 0) return [];
  const rows = await tx
    .select({ l: accountLiabilities, name: accounts.name, currency: accounts.currency })
    .from(accountLiabilities)
    .innerJoin(accounts, eq(accounts.id, accountLiabilities.accountId))
    .where(
      and(
        gte(accountLiabilities.nextDueDate, from),
        lte(accountLiabilities.nextDueDate, to),
        accountIds ? inArray(accountLiabilities.accountId, accountIds) : undefined,
      ),
    )
    .orderBy(asc(accountLiabilities.nextDueDate), asc(accounts.name));
  const out: CardStatement[] = [];
  for (const { l, name, currency } of rows) {
    const owed = -(l.lastStatementBalanceMinor ?? 0);
    if (owed <= 0 || !l.nextDueDate) continue;
    const [sum] = await tx
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
    const paidSoFar = Number(sum?.total ?? 0);
    const paid = statementPaid(owed, l.minimumPaymentMinor, paidSoFar);
    out.push({
      accountId: l.accountId,
      accountName: name,
      currency,
      due: l.nextDueDate,
      statementDate: l.lastStatementDate,
      owedMinor: owed,
      minimumMinor: l.minimumPaymentMinor,
      paidSoFarMinor: paidSoFar,
      paid,
      status:
        paid === 'paid' || paid === 'minimum'
          ? 'paid'
          : addDays(l.nextDueDate, LATE_AFTER_DAYS) < today
            ? 'late'
            : 'due',
    });
  }
  return out;
}

/**
 * For the "A card statement is due" notification (#127): statements due from `today` to
 * `withinDays` days after it, on cards `memberId` owns, not yet paid in full.
 */
export async function cardStatementsDue(
  tx: Executor,
  { memberId, today, withinDays }: { memberId: string; today: string; withinDays: number },
): Promise<CardStatement[]> {
  const owned = await tx
    .select({ accountId: accountOwners.accountId })
    .from(accountOwners)
    .where(eq(accountOwners.memberId, memberId));
  const statements = await cardStatements(tx, {
    from: today,
    to: addDays(today, withinDays),
    today,
    accountIds: owned.map((o) => o.accountId),
  });
  return statements.filter((s) => s.paid !== 'paid');
}
