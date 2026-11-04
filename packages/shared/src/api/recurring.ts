// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { addDays } from '../ranges.js';
import { minorUnitsSchema } from './accounts.js';

// Recurring series (#118; bills walkthrough §1–§3, D1, D2, D6, D11): a payment that comes at a
// steady pace, named by what it matches (like a rule) and when. What it expects is only an
// estimate from the payments so far; it never decides what counts. The schedule's dates, and
// matching payments to them, are here so the web app can show them as you type.

const isoDate = z.iso.date();

/** Bill, subscription, income, or transfer: they differ in wording and totals only (D1). */
export const recurringKindSchema = z.enum(['bill', 'subscription', 'income', 'transfer']);
export type RecurringKind = z.infer<typeof recurringKindSchema>;

/** A day that lands on a weekend moves to the Friday before, the Monday after, or stays (D2). */
export const weekendRuleSchema = z.enum(['before', 'after', 'as_is']);
export type WeekendRule = z.infer<typeof weekendRuleSchema>;

/** The last day of the month, whichever day that is. */
export const LAST_DAY = -1;

const dayOfMonth = z
  .number()
  .int()
  .min(-1)
  .max(31)
  .refine((d) => d !== 0, 'A day of the month is 1–31, or −1 for the last');

/** A weekday in the month: the 1st–4th of it, or the last (−1). `day` is 0 (Sunday) to 6. */
const weekdayOfMonth = z.object({
  nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]),
  day: z.number().int().min(0).max(6),
});

/**
 * When it comes. `anchor` is one of its dates: it sets the weekday (weeks), the phase (every 2
 * weeks, every 3 months), and the month (yearly). Twice a month is `month` with two days. A month
 * schedule has `days` (the 1st, the 15th) or `weekday` (the first Friday), not both.
 */
const scheduleUnion = z.discriminatedUnion('unit', [
  z.object({
    unit: z.literal('week'),
    every: z.number().int().min(1).max(8),
    anchor: isoDate,
    weekend: weekendRuleSchema,
  }),
  z.object({
    unit: z.literal('month'),
    every: z.number().int().min(1).max(12),
    days: z
      .array(dayOfMonth)
      .min(1)
      .max(2)
      .refine((d) => new Set(d).size === d.length, 'Two different days')
      .optional(),
    weekday: weekdayOfMonth.optional(),
    anchor: isoDate,
    weekend: weekendRuleSchema,
  }),
  z.object({
    unit: z.literal('day'),
    every: z.number().int().min(1).max(366),
    anchor: isoDate,
    weekend: weekendRuleSchema,
  }),
]);
export const recurringScheduleSchema = scheduleUnion.refine(
  (s) => s.unit !== 'month' || !!s.days !== !!s.weekday,
  'Give days of the month or a weekday in it',
);
export type RecurringSchedule = z.infer<typeof recurringScheduleSchema>;

/**
 * What counts as one of its payments, besides its account (D11): money in or out, and optionally
 * its name and an amount condition, the same pieces a rule's conditions use.
 */
export const recurringMatchSchema = z
  .object({
    direction: z.enum(['in', 'out']),
    /** The bank's description or the transaction's name, ignoring case and spacing. */
    description: z
      .object({
        op: z.enum(['contains', 'equals', 'starts_with']),
        value: z.string().trim().min(1).max(200),
      })
      .optional(),
    /** Its size, in minor units: at least `min`, at most `max`, or between. */
    amount: z
      .object({ min: minorUnitsSchema.min(0).optional(), max: minorUnitsSchema.min(0).optional() })
      .refine((a) => a.min !== undefined || a.max !== undefined, 'Give a minimum or a maximum')
      .refine(
        (a) => a.min === undefined || a.max === undefined || a.min <= a.max,
        'Minimum is above maximum',
      )
      .optional(),
  })
  .strict();
export type RecurringMatch = z.infer<typeof recurringMatchSchema>;

/** How many days either side of its date a payment still counts, unless it says otherwise. */
export const RECURRING_DEFAULT_WINDOW = 3;

const seriesName = z.string().trim().min(1).max(80);

export const recurringDraftSchema = z.object({
  accountId: z.uuid(),
  match: recurringMatchSchema,
  schedule: recurringScheduleSchema,
  windowDays: z.number().int().min(0).max(15).default(RECURRING_DEFAULT_WINDOW),
});
export type RecurringDraft = z.infer<typeof recurringDraftSchema>;

export const createRecurringSchema = recurringDraftSchema.extend({
  name: seriesName,
  kind: recurringKindSchema,
  /** Who looks after it (D13): someone who sees its account. Left out: the default. */
  responsibleMemberId: z.uuid().optional(),
});

/** Handing a series to someone else who sees its account (D13; REC-04). */
export const handOverSchema = z.object({ memberId: z.uuid() }).strict();
export const updateRecurringSchema = z
  .object({
    name: seriesName,
    kind: recurringKindSchema,
    match: recurringMatchSchema,
    schedule: recurringScheduleSchema,
    windowDays: z.number().int().min(0).max(15),
    /** The day it ended: no more are expected after it. Null to start it again. */
    endedOn: isoDate.nullable(),
  })
  .partial()
  .strict();

/** A payment of a series: the transaction that paid an occurrence. */
export interface RecurringPayment {
  /** The occurrence it paid. */
  due: string;
  transactionId: string;
  date: string;
  amountMinor: number;
}

export interface RecurringSeries {
  id: string;
  accountId: string;
  name: string;
  kind: RecurringKind;
  match: RecurringMatch;
  schedule: RecurringSchedule;
  windowDays: number;
  endedOn: string | null;
  currency: string;
  /** The next date it's expected, today or later; null once it has ended. */
  next: string | null;
  /** About how much the next one is, signed as its payments are; null with none to go on. */
  estimateMinor: number | null;
  /** The latest payments, newest first: up to 6. */
  recent: RecurringPayment[];
  /** How many payments it has had, in all of the history you can see. */
  paidCount: number;
  /** Who looks after it and gets its reminders (D13); null for income, which has `forMemberIds`. */
  responsibleMemberId: string | null;
  /** Income: who it's for, from its latest payment's attribution. Empty for the rest. */
  forMemberIds: string[];
  /** The members who see its account: who it can be handed to. One: show no person (D22). */
  seenBy: string[];
  /** What's changed worth noticing (D14): a price rise, new, or looks ended. */
  changes: SeriesChanges;
  /** The day its latest payment was made; null with none. */
  lastPaid: string | null;
  version: number;
  updatedAt: string;
}

/** What a series would look like, before it's saved: for the Make recurring dialog. */
export interface RecurringPreview {
  /** Who would look after it if nobody's chosen (D13), and who could (D22). */
  responsibleMemberId: string | null;
  seenBy: string[];
  next: string[];
  paidCount: number;
  firstPaid: string | null;
  estimateMinor: number | null;
  recent: RecurringPayment[];
}

/** A paycheck or bill counts as late this many days after its date (D12). */
export const LATE_AFTER_DAYS = 2;

/** How many recent payments make the estimate: a month's worth for weekly ones. */
export const estimateCount = (s: RecurringSchedule) => (s.unit === 'week' && s.every === 1 ? 4 : 3);

/** Saying a date was paid (by a transaction, or another way) or skipped (D12). */
export const markOccurrenceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('paid'), transactionId: z.uuid().nullable() }),
  z.object({ status: z.literal('skipped') }),
]);
export type MarkOccurrence = z.infer<typeof markOccurrenceSchema>;

/**
 * One date something is due. `paid` with a payment; `late` when nothing has paid it two days
 * after its date; `skipped` when someone said nothing was due; otherwise `due`.
 */
export interface RecurringOccurrence {
  /** Null for a card statement, which comes from the bank (D9). */
  seriesId: string | null;
  name: string;
  kind: RecurringKind | 'statement';
  accountId: string;
  currency: string;
  due: string;
  status: 'paid' | 'late' | 'due' | 'skipped';
  /** About how much, signed as its payments are. A statement: its balance, as money out. */
  expectedMinor: number | null;
  /** What paid it: a transaction, or null for "paid another way". */
  payment: { transactionId: string | null; date: string | null; amountMinor: number | null } | null;
  /** Card statements: the minimum, and what's gone into the card since the statement. */
  minimumMinor?: number | null;
  paidSoFarMinor?: number;
  /** Card statements: how much of it is paid (D9). */
  statementPaid?: StatementPaid;
  /**
   * Who: for a bill, who looks after it; for income, who it's for; for a card statement, whose
   * card it is. Shown only when `shared` (D22).
   */
  memberIds: string[];
  /** Seen by more than one member, so who it's for is worth saying (D22). */
  shared: boolean;
  /** A series' changes worth noticing (D14); none on a card statement. */
  changes?: SeriesChanges;
}

/** How much of a card statement is paid (D9): all of it, the minimum, some, or nothing yet. */
export type StatementPaid = 'paid' | 'minimum' | 'part' | null;

/**
 * Whether payments into a card since its statement date pay the statement: all of its balance,
 * at least its minimum, or less. `owedMinor` and the rest are positive.
 */
export function statementPaid(
  owedMinor: number,
  minimumMinor: number | null,
  paidSoFarMinor: number,
): StatementPaid {
  if (paidSoFarMinor >= owedMinor) return 'paid';
  if (minimumMinor !== null && minimumMinor > 0 && paidSoFarMinor >= minimumMinor) return 'minimum';
  return paidSoFarMinor > 0 ? 'part' : null;
}

// ── Who looks after it (#121; D13, D22) ─────────────────────────────────────────────────────

export interface LookAfterInput {
  kind: RecurringKind;
  /** Who someone chose; null for the default. */
  responsibleMemberId: string | null;
  /** Whoever made it (confirmed the suggestion, or added it). */
  createdByMemberId: string;
  /** The household's current members who see its account, in the order they joined. */
  seenBy: readonly string[];
  /** Its account's current owners, largest share first. */
  accountOwners: readonly string[];
  /** The household's current owners, in the order they joined. */
  householdOwners: readonly string[];
}

/**
 * Who looks after a series and gets its reminders (D13): whoever was chosen, while they still see
 * its account. Otherwise the account's only owner; for a joint account, whoever made it; then the
 * account's first owner, then the household's first owner who sees it. Income has none: it has
 * "for" instead, and no reminders.
 */
export function whoLooksAfter(x: LookAfterInput): string | null {
  if (x.kind === 'income') return null;
  const sees = (m: string | null): m is string => m !== null && x.seenBy.includes(m);
  if (sees(x.responsibleMemberId)) return x.responsibleMemberId;
  const owners = x.accountOwners.filter(sees);
  if (owners.length === 1) return owners[0]!;
  if (sees(x.createdByMemberId)) return x.createdByMemberId;
  return owners[0] ?? x.householdOwners.find(sees) ?? null;
}

/** Whether to show a person, or ask for one: only where more than one member sees it (D22). */
export const showWho = (seenBy: readonly string[]) => seenBy.length > 1;

/** A month of what's due, for Upcoming and the calendar (§4). */
export interface RecurringMonth {
  month: string;
  today: string;
  /** This month's, by date; for the current month, late ones from before it come first. */
  occurrences: RecurringOccurrence[];
  /** In the household's base currency, as positive amounts. */
  totals: {
    billsMinor: number;
    billsPaidMinor: number;
    incomeMinor: number;
    incomeReceivedMinor: number;
    statementsMinor: number;
    /** Subscriptions, about how much a month. */
    subscriptionsMinor: number;
    subscriptionCount: number;
  };
}

/** A starting point for Make recurring, from one transaction and the ones like it (D6). */
export interface RecurringSuggestion {
  name: string;
  kind: RecurringKind;
  draft: RecurringDraft;
}

// ── Dates ───────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDate = (t: number) => new Date(t).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);
const weekday = (d: string) => new Date(toTime(d)).getUTCDay();
const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
const lastDayOf = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

function onDay(index: number, day: number): string {
  const y = Math.floor(index / 12);
  const m0 = index % 12;
  const last = lastDayOf(y, m0);
  const d = day === LAST_DAY ? last : Math.min(day, last);
  return toDate(Date.UTC(y, m0, d));
}

/** The `nth` (−1: last) `day` of the week in month `index`. */
function onWeekday(index: number, nth: number, day: number): string {
  const y = Math.floor(index / 12);
  const m0 = index % 12;
  if (nth === -1) {
    const last = lastDayOf(y, m0);
    const back = (new Date(Date.UTC(y, m0, last)).getUTCDay() - day + 7) % 7;
    return toDate(Date.UTC(y, m0, last - back));
  }
  const first = (day - new Date(Date.UTC(y, m0, 1)).getUTCDay() + 7) % 7;
  return toDate(Date.UTC(y, m0, 1 + first + 7 * (nth - 1)));
}

function shift(d: string, rule: WeekendRule): string {
  const w = weekday(d);
  if (rule === 'as_is' || (w !== 0 && w !== 6)) return d;
  if (rule === 'before') return addDays(d, w === 6 ? -1 : -2);
  return addDays(d, w === 6 ? 2 : 1);
}

/** The dates it's due, from `from` to `to` (both included), after the weekend rule. */
export function occurrences(s: RecurringSchedule, from: string, to: string): string[] {
  // Two days of slack: a date just outside can move inside, over a weekend.
  const lo = addDays(from, -2);
  const hi = addDays(to, 2);
  const nominal: string[] = [];
  if (s.unit === 'month') {
    const a = monthIndex(s.anchor);
    const first = monthIndex(lo);
    const start = first - ((((first - a) % s.every) + s.every) % s.every);
    for (let i = start; i <= monthIndex(hi); i += s.every) {
      if (s.weekday) nominal.push(onWeekday(i, s.weekday.nth, s.weekday.day));
      for (const day of s.days ?? []) nominal.push(onDay(i, day));
    }
  } else {
    const step = s.unit === 'week' ? 7 * s.every : s.every;
    const k = Math.ceil(daysBetween(s.anchor, lo) / step);
    for (let d = addDays(s.anchor, k * step); d <= hi; d = addDays(d, step)) nominal.push(d);
  }
  const out = new Set(
    nominal
      .filter((d) => d >= lo && d <= hi)
      .map((d) => shift(d, s.weekend))
      .filter((d) => d >= from && d <= to),
  );
  return [...out].sort();
}

/** The first `count` dates on or after `from`. */
export function nextOccurrences(s: RecurringSchedule, from: string, count: number): string[] {
  // A year and a bit covers six of anything up to yearly; one more year for yearly with gaps.
  const span = s.unit === 'month' ? 31 * s.every * count + 31 : 400;
  return occurrences(s, from, addDays(from, Math.max(span, 400))).slice(0, count);
}

const ordinal = (n: number) =>
  n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const dayName = (d: number) => (d === LAST_DAY ? 'the last day' : `the ${ordinal(d)}`);
const NTH: Record<number, string> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  [-1]: 'last',
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** In words: "Every 2 weeks, on Friday", "Twice a month, the 1st and the 15th". */
export function describeSchedule(s: RecurringSchedule): string {
  if (s.unit === 'week') {
    const on = `on ${WEEKDAYS[weekday(s.anchor)]}`;
    return s.every === 1 ? `Every week, ${on}` : `Every ${s.every} weeks, ${on}`;
  }
  if (s.unit === 'day') return s.every === 1 ? 'Every day' : `Every ${s.every} days`;
  if (s.weekday) {
    const which = `the ${NTH[s.weekday.nth]} ${WEEKDAYS[s.weekday.day]}`;
    if (s.every === 12)
      return `Every year, ${which} of ${MONTHS[Number(s.anchor.slice(5, 7)) - 1]}`;
    return s.every === 1 ? `Every month, on ${which}` : `Every ${s.every} months, on ${which}`;
  }
  const days = [...(s.days ?? [])].sort(
    (a, b) => (a === LAST_DAY ? 32 : a) - (b === LAST_DAY ? 32 : b),
  );
  const on = days.map(dayName).join(' and ');
  if (days.length === 2 && s.every === 1) return `Twice a month, ${on}`;
  if (s.every === 12)
    return `Every year, ${MONTHS[Number(s.anchor.slice(5, 7)) - 1]} ${on.replace('the ', '')}`;
  return s.every === 1 ? `Every month, on ${on}` : `Every ${s.every} months, on ${on}`;
}

// ── Payments ────────────────────────────────────────────────────────────────────────────────

/** The parts of a transaction a series looks at. */
export interface RecurringCandidate {
  id: string;
  date: string;
  amountMinor: number;
  displayName: string;
  originalDescription: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether a transaction (on the series' account) is the kind of payment it's looking for. */
export function recurringMatches(m: RecurringMatch, t: RecurringCandidate): boolean {
  if (m.direction === 'in' ? t.amountMinor <= 0 : t.amountMinor >= 0) return false;
  if (m.description) {
    const v = norm(m.description.value);
    const hit = (text: string) => {
      const x = norm(text);
      return m.description!.op === 'equals'
        ? x === v
        : m.description!.op === 'starts_with'
          ? x.startsWith(v)
          : x.includes(v);
    };
    if (!hit(t.displayName) && !hit(t.originalDescription)) return false;
  }
  const size = Math.abs(t.amountMinor);
  if (m.amount?.min !== undefined && size < m.amount.min) return false;
  if (m.amount?.max !== undefined && size > m.amount.max) return false;
  return true;
}

/**
 * Pairs payments with the dates they were due. Each date takes the closest payment within
 * `windowDays` that no earlier date took; payments are taken in date order, so a payment early
 * for one date can't be claimed by the date before. A date left unpaid then takes the first
 * payment after its window that comes before the next date's window: paid late (D12).
 * `linked` are payments someone said paid a date: they're taken first, whatever their date.
 */
export function payOccurrences(
  dates: readonly string[],
  payments: readonly RecurringCandidate[],
  windowDays: number,
  linked: ReadonlyMap<string, RecurringCandidate> = new Map(),
): RecurringPayment[] {
  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  const taken = new Set([...linked.values()].map((p) => p.id));
  const paid = new Map<string, RecurringCandidate>(linked);
  for (const due of dates) {
    if (paid.has(due)) continue;
    let best: RecurringCandidate | undefined;
    for (const p of sorted) {
      if (taken.has(p.id)) continue;
      const gap = Math.abs(daysBetween(due, p.date));
      if (gap > windowDays) continue;
      if (!best || gap < Math.abs(daysBetween(due, best.date))) best = p;
    }
    if (best) {
      taken.add(best.id);
      paid.set(due, best);
    }
  }
  dates.forEach((due, i) => {
    if (paid.has(due)) return;
    const after = addDays(due, windowDays);
    const next = dates[i + 1];
    const before = next ? addDays(next, -windowDays) : null;
    const late = sorted.find(
      (p) => !taken.has(p.id) && p.date > after && (before === null || p.date < before),
    );
    if (late) {
      taken.add(late.id);
      paid.set(due, late);
    }
  });
  return dates
    .filter((due) => paid.has(due))
    .map((due) => {
      const p = paid.get(due)!;
      return { due, transactionId: p.id, date: p.date, amountMinor: p.amountMinor };
    });
}

/**
 * About how much the next one is: the average of the last `count` payments (D8), three unless
 * said otherwise; a weekly paycheck uses a month's worth, so one big week doesn't swing it. A
 * month that alternates (a paycheck that's smaller on the 15th) averages out over the month.
 */
export function estimateNext(payments: readonly RecurringPayment[], count = 3): number | null {
  const last = [...payments].sort((a, b) => b.date.localeCompare(a.date)).slice(0, count);
  if (last.length === 0) return null;
  return Math.round(last.reduce((s, p) => s + p.amountMinor, 0) / last.length);
}

// ── Guessing a schedule from past payments ──────────────────────────────────────────────────

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** The most common values, most common first. */
const modes = (xs: number[]) => {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
};

/** Its day of the month. A payment moved off a weekend is a day or two out; the commonest wins. */
const dayOf = (d: string) => Number(d.slice(8, 10));

/**
 * A schedule that fits these dates (D6), or null with too few to tell. Paychecks move to the
 * Friday before a weekend; bills to the Monday after, unless the dates show otherwise.
 */
export function guessSchedule(
  dates: readonly string[],
  direction: 'in' | 'out',
): RecurringSchedule | null {
  const ds = [...new Set(dates)].sort();
  if (ds.length < 2) return null;
  const gaps = ds.slice(1).map((d, i) => daysBetween(ds[i]!, d));
  const gap = median(gaps);
  const anchor = ds[ds.length - 1]!;
  const weekend: WeekendRule = direction === 'in' ? 'before' : 'after';
  if (gap >= 6 && gap <= 8) return { unit: 'week', every: 1, anchor, weekend };
  if (gap >= 12 && gap <= 17) {
    // Twice a month when the days of the month repeat; every 2 weeks when the weekday does.
    const counted = modes(ds.map((d) => (dayOf(d) >= 28 ? LAST_DAY : dayOf(d))));
    const top = counted.slice(0, 2).reduce((s, [, n]) => s + n, 0);
    if (counted.length >= 2 && top / ds.length >= 0.6) {
      return {
        unit: 'month',
        every: 1,
        days: counted.slice(0, 2).map(([d]) => d),
        anchor,
        weekend,
      };
    }
    return { unit: 'week', every: 2, anchor, weekend };
  }
  const months = [
    [27, 33, 1],
    [57, 65, 2],
    [86, 96, 3],
    [170, 195, 6],
    [350, 380, 12],
  ] as const;
  for (const [lo, hi, every] of months) {
    if (gap >= lo && gap <= hi) {
      const [[day]] = modes(ds.map((d) => (dayOf(d) >= 29 ? LAST_DAY : dayOf(d)))) as [
        [number, number],
      ];
      return { unit: 'month', every, days: [day], anchor, weekend };
    }
  }
  return { unit: 'day', every: Math.max(1, Math.min(366, gap)), anchor, weekend };
}

// ── Finding them in history (#119; bills walkthrough §2, D3, D4) ────────────────────────────

/** Payments that might be one series: one account, one direction, one name. */
export interface DetectGroup {
  accountId: string;
  direction: 'in' | 'out';
  /** The name, cleaned up: what "Not recurring" remembers. */
  key: string;
  name: string;
  /** Oldest first. */
  payments: RecurringCandidate[];
  /** Linked as transfers between your own accounts. */
  transfer: boolean;
}

/** A series Fiscus found, to confirm or dismiss. */
export interface DetectedSeries {
  key: string;
  name: string;
  kind: RecurringKind;
  draft: RecurringDraft;
  seenCount: number;
  since: string;
  /** The last few amounts, oldest first, signed: for the little bars. */
  amounts: number[];
  next: string | null;
  /**
   * Filled in by the api: who would look after it (D13), who could (D22), and for income, who
   * it's for. Shown on the suggestion, so it can be changed before confirming.
   */
  responsibleMemberId?: string | null;
  seenBy?: string[];
  forMemberIds?: string[];
}

/** The name a group of payments goes by: case and spacing don't matter. */
export const recurringKey = (name: string) => norm(name);

/** About how many days apart its dates are. */
const cycleDays = (s: RecurringSchedule) =>
  s.unit === 'week'
    ? 7 * s.every
    : s.unit === 'day'
      ? s.every
      : s.days?.length === 2
        ? 15
        : 30.4 * s.every;

/** How many of the most recent payments detection looks at. */
const RECENT_FOR_DETECTION = 24;

/**
 * A series these payments make, or null (D4): at least 3 at a steady pace that fits a schedule
 * (2 for yearly ones), still coming (the last no more than one and a half cycles ago), with an
 * amount condition wide enough for what's been paid. Frequent but unsteady spending (groceries)
 * fits no schedule well enough to be suggested.
 */
export function detectRecurring(g: DetectGroup, today: string): DetectedSeries | null {
  const byDay = new Map<string, RecurringCandidate>();
  for (const p of g.payments) if (!byDay.has(p.date)) byDay.set(p.date, p);
  const recent = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-RECENT_FOR_DETECTION);
  if (recent.length < 2) return null;
  const schedule = guessSchedule(
    recent.map((p) => p.date),
    g.direction,
  );
  if (!schedule || schedule.unit === 'day') return null;
  const yearly = schedule.unit === 'month' && schedule.every === 12;
  if (recent.length < (yearly ? 2 : 3)) return null;
  const cycle = cycleDays(schedule);
  const last = recent[recent.length - 1]!;
  const slack = Math.min(7, Math.max(3, Math.round(cycle / 6)));
  // Still coming: the date after its last payment hasn't gone by unpaid. One that's missed a
  // payment has most likely ended (a cancelled subscription, an old job's paychecks).
  const after = occurrences(schedule, addDays(last.date, slack + 1), addDays(today, cycle + 31))[0];
  if (!after || addDays(after, slack + LATE_AFTER_DAYS) < today) return null;
  // Steady: most of its dates over the stretch were paid, within a few days.
  const dates = occurrences(schedule, addDays(recent[0]!.date, -slack), addDays(last.date, slack));
  const paid = payOccurrences(dates, recent, slack);
  if (paid.length < (yearly ? 2 : 3) || paid.length / Math.max(1, dates.length) < 0.75) return null;
  const gaps = paid.map((p) => Math.abs(daysBetween(p.due, p.date)));
  const drift = Math.max(...gaps);
  // On its dates, give or take a day or two, and not much paid in between: a weekly shop isn't.
  const average = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (average > Math.max(1, cycle / 10)) return null;
  if ((recent.length - paid.length) / recent.length > 0.2) return null;
  const sizes = paid.map((p) => Math.abs(p.amountMinor));
  const lo = Math.min(...sizes);
  const hi = Math.max(...sizes);
  const margin = hi - lo <= lo * 0.1 ? 0.05 : 0.1;
  const match: RecurringMatch = {
    direction: g.direction,
    description: { op: 'equals', value: g.name },
    amount: {
      min: Math.max(0, Math.floor((lo * (1 - margin)) / 100) * 100),
      max: Math.ceil((hi * (1 + margin)) / 100) * 100,
    },
  };
  return {
    key: g.key,
    name: g.name,
    kind: g.transfer ? 'transfer' : g.direction === 'in' ? 'income' : 'bill',
    draft: {
      accountId: g.accountId,
      match,
      schedule,
      windowDays: Math.max(RECURRING_DEFAULT_WINDOW, Math.min(7, drift)),
    },
    seenCount: g.payments.length,
    since: g.payments[0]!.date,
    amounts: paid.slice(-10).map((p) => p.amountMinor),
    next: nextOccurrences(schedule, today, 1)[0] ?? null,
  };
}

// ── Changes worth noticing (#129, #123; bills walkthrough D14) ──────────────────────────────

/** A price rise counts once the last this many payments are all up. */
export const PRICE_RISE_PAYMENTS = 2;
/** By at least this much over what came before (5%: what "about" allows, D4). */
export const PRICE_RISE_RATIO = 1.05;
/** A price rise is news while its first raised payment is this recent. */
export const PRICE_RISE_NEWS_DAYS = 120;
/** A subscription is new while its first payment, or its confirming, is this recent. */
export const NEW_SUBSCRIPTION_DAYS = 45;

/** What's changed about a series (D14): its price went up, it's new, or it looks ended. */
export interface SeriesChanges {
  /** Up by `changeMinor` (positive) since `since`, the first raised payment. */
  priceUp: { changeMinor: number; since: string } | null;
  /** A subscription first paid, or confirmed, in the last few weeks. */
  isNew: boolean;
  /** Its last two dates went by unpaid: it may have ended (D12). */
  looksEnded: boolean;
}

export const NO_CHANGES: SeriesChanges = { priceUp: null, isNew: false, looksEnded: false };

/**
 * What's worth noticing about a series (D14), from its payments (oldest first) and its dates up
 * to today:
 * - **Price went up**: its last 2 payments are both at least 5% over the average of the 3 before
 *   them (so one odd bill doesn't count, and a rise that's reversed stops counting), and the first
 *   of them is from the last 120 days. Income and transfers don't count.
 * - **New**: a subscription first paid, or confirmed with no payments yet, in the last 45 days.
 * - **Looks ended**: its last two dates more than 2 days ago (D12) are both unpaid, and it hasn't
 *   been marked ended. Skipped dates don't count either way.
 */
export function seriesChanges(x: {
  kind: RecurringKind;
  payments: readonly RecurringPayment[];
  /** Its dates up to today, oldest first, and which of them were skipped. */
  dates: readonly string[];
  skipped: ReadonlySet<string>;
  /** Dates someone marked paid another way, with no transaction. */
  markedPaid?: ReadonlySet<string>;
  /** Dates before this were never expected (before it was made, or first paid). */
  since: string;
  createdOn: string;
  endedOn: string | null;
  today: string;
}): SeriesChanges {
  const paid = [...x.payments].sort((a, b) => a.date.localeCompare(b.date));
  let priceUp: SeriesChanges['priceUp'] = null;
  if ((x.kind === 'bill' || x.kind === 'subscription') && paid.length >= PRICE_RISE_PAYMENTS + 3) {
    const recent = paid.slice(-PRICE_RISE_PAYMENTS);
    const before = paid.slice(-PRICE_RISE_PAYMENTS - 3, -PRICE_RISE_PAYMENTS);
    const prior = before.reduce((s, p) => s + Math.abs(p.amountMinor), 0) / before.length;
    const up = recent.every((p) => Math.abs(p.amountMinor) >= prior * PRICE_RISE_RATIO);
    const first = recent[0]!;
    if (up && prior > 0 && daysBetween(first.date, x.today) <= PRICE_RISE_NEWS_DAYS) {
      const now = recent.reduce((s, p) => s + Math.abs(p.amountMinor), 0) / recent.length;
      priceUp = { changeMinor: Math.round(now - prior), since: first.date };
    }
  }
  const firstPaid = paid[0]?.date;
  const isNew =
    x.kind === 'subscription' &&
    daysBetween(firstPaid ?? x.createdOn, x.today) <= NEW_SUBSCRIPTION_DAYS;
  const paidDues = new Set([...paid.map((p) => p.due), ...(x.markedPaid ?? [])]);
  const past = x.dates.filter(
    (d) =>
      d >= x.since &&
      !x.skipped.has(d) &&
      addDays(d, LATE_AFTER_DAYS) < x.today &&
      (x.endedOn === null || d <= x.endedOn),
  );
  const lastTwo = past.slice(-2);
  const looksEnded =
    x.endedOn === null && lastTwo.length === 2 && lastTwo.every((d) => !paidDues.has(d));
  return { priceUp, isNew, looksEnded };
}

/** How many times a year it comes: for a subscription's yearly cost (#123). */
export function paymentsPerYear(s: RecurringSchedule): number {
  if (s.unit === 'week') return 52 / s.every;
  if (s.unit === 'day') return 365 / s.every;
  // A weekday in the month (#506) has no `days`: once a month.
  const days = (s as { days?: readonly number[] }).days;
  return (12 / s.every) * (days?.length ?? 1);
}
