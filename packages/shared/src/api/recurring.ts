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

/**
 * When it comes. `anchor` is one of its dates: it sets the weekday (weeks), the phase (every 2
 * weeks, every 3 months), and the month (yearly). Twice a month is `month` with two days.
 */
export const recurringScheduleSchema = z.discriminatedUnion('unit', [
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
      .refine((d) => new Set(d).size === d.length, 'Two different days'),
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
});
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
  version: number;
  updatedAt: string;
}

/** What a series would look like, before it's saved: for the Make recurring dialog. */
export interface RecurringPreview {
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
}

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
      for (const day of s.days) nominal.push(onDay(i, day));
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
  const days = [...s.days].sort((a, b) => (a === LAST_DAY ? 32 : a) - (b === LAST_DAY ? 32 : b));
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
