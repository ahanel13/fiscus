// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// One time-range model for every view (ADR 0011). A range is stored as intent ("YTD"), and
// resolved to dates here, in the household's time zone and fiscal year. The API and the web app
// share this code, so they always agree on what "last month" means.
//
// All arithmetic is on calendar dates ("YYYY-MM-DD") in UTC, so no time zone or daylight-saving
// change can shift a day. The only time-zone step is finding today's date.

export const PRESETS = [
  'last_7d',
  'last_30d',
  'last_90d',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'last_3m',
  'last_6m',
  'last_12m',
  'ytd',
  'this_year',
  'last_year',
  'all_time',
] as const;
export type Preset = (typeof PRESETS)[number];

export const GRANULARITIES = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const COMPARISONS = ['none', 'previous_period', 'same_period_last_year'] as const;
export type Comparison = (typeof COMPARISONS)[number];

const isoDate = z.iso.date();

export const dateRangeSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), preset: z.enum(PRESETS) }),
  z
    .object({ kind: z.literal('custom'), from: isoDate, to: isoDate })
    .refine((r) => r.from <= r.to, '"from" must not be after "to"'),
]);
export type DateRangeSpec = z.infer<typeof dateRangeSpecSchema>;

/**
 * Query-string form shared by every time-based endpoint (ADR 0011 §1): `range` is a preset or
 * `custom` with `from`/`to`; `granularity` and `compare` are optional.
 */
export const rangeQuerySchema = z
  .object({
    range: z.union([z.enum(PRESETS), z.literal('custom')]).default('last_30d'),
    from: isoDate.optional(),
    to: isoDate.optional(),
    granularity: z.enum(GRANULARITIES).optional(),
    compare: z.enum(COMPARISONS).default('none'),
  })
  .refine((q) => q.range !== 'custom' || (q.from && q.to), 'A custom range needs "from" and "to"')
  .refine((q) => !q.from || !q.to || q.from <= q.to, '"from" must not be after "to"');
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

/** The same parameters, all optional: for endpoints that also accept plain `from`/`to` dates. */
export const optionalRangeFields = {
  range: z.union([z.enum(PRESETS), z.literal('custom')]).optional(),
  granularity: z.enum(GRANULARITIES).optional(),
  compare: z.enum(COMPARISONS).default('none'),
};

/** What a time-based endpoint resolved its range to, so clients never re-derive dates (ADR 0011 §1). */
export interface RangeMeta {
  from: string;
  to: string;
  periodEnd: string;
  partial: boolean;
  granularity?: Granularity;
  comparison?: { from: string; to: string } | null;
}

export const specFromQuery = (q: Pick<RangeQuery, 'range' | 'from' | 'to'>): DateRangeSpec =>
  q.range === 'custom'
    ? { kind: 'custom', from: q.from!, to: q.to! }
    : { kind: 'preset', preset: q.range };

export interface RangeSettings {
  timeZone: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekStart: number;
  /** 1 = January. Quarters and YTD follow the fiscal year. */
  fiscalYearStartMonth: number;
}

export interface ResolvedRange {
  /** First day, inclusive. */
  from: string;
  /** Last day with data, inclusive: never after today for current periods. */
  to: string;
  /** Where the period ends in full (e.g. the end of this month). Equal to `to` when complete. */
  periodEnd: string;
  /** The period isn't over yet (ADR 0011 §3): mark it "so far" and leave it out of averages. */
  partial: boolean;
}

// ── Calendar-date arithmetic ────────────────────────────────────────────────────────────────

const parse = (d: string) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return { y, m, day };
};
const fmt = (y: number, m: number, day: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

export function addDays(d: string, n: number): string {
  return new Date(utc(d) + n * 86_400_000).toISOString().slice(0, 10);
}

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Adds months, clamping the day: Jan 31 + 1 month = Feb 28 (or 29). */
export function addMonths(d: string, n: number): string {
  const { y, m, day } = parse(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

export const dayCount = (from: string, to: string) =>
  Math.round((utc(to) - utc(from)) / 86_400_000) + 1;

const startOfMonth = (d: string) => fmt(parse(d).y, parse(d).m, 1);
const endOfMonth = (d: string) => {
  const { y, m } = parse(d);
  return fmt(y, m, daysInMonth(y, m));
};

/** The first day of the fiscal year containing `d`. */
export function fiscalYearStart(d: string, startMonth: number): string {
  const { y, m } = parse(d);
  return fmt(m >= startMonth ? y : y - 1, startMonth, 1);
}

/** The first day of the fiscal quarter containing `d`. */
export function quarterStart(d: string, fiscalStartMonth: number): string {
  const offset = (parse(d).m - fiscalStartMonth + 12) % 12;
  return addMonths(startOfMonth(d), -(offset % 3));
}

/** The first day of the week containing `d`. */
export function weekStart(d: string, firstDay: number): string {
  const dow = new Date(utc(d)).getUTCDay();
  return addDays(d, -((dow - firstDay + 7) % 7));
}

/** Today's calendar date in a time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// ── Resolving ───────────────────────────────────────────────────────────────────────────────

const period = (from: string, periodEnd: string, today: string): ResolvedRange => {
  const to = periodEnd > today ? today : periodEnd;
  return { from, to, periodEnd, partial: periodEnd > today };
};

/**
 * Resolves a range to dates (ADR 0011 §1). Rolling presets count back from today and are never
 * partial; calendar presets snap to month, quarter, and fiscal-year boundaries. `earliest` is the
 * first date with data, for "all time".
 */
export function resolveRange(
  spec: DateRangeSpec,
  settings: RangeSettings,
  now: Date = new Date(),
  earliest?: string,
): ResolvedRange {
  const today = todayIn(settings.timeZone, now);
  if (spec.kind === 'custom') return period(spec.from, spec.to, today);
  const fy = settings.fiscalYearStartMonth;
  const rolling = (days: number) => ({
    from: addDays(today, -(days - 1)),
    to: today,
    periodEnd: today,
    partial: false,
  });
  switch (spec.preset) {
    case 'last_7d':
      return rolling(7);
    case 'last_30d':
      return rolling(30);
    case 'last_90d':
      return rolling(90);
    case 'this_month':
      return period(startOfMonth(today), endOfMonth(today), today);
    case 'last_month': {
      const start = addMonths(startOfMonth(today), -1);
      return period(start, endOfMonth(start), today);
    }
    case 'this_quarter': {
      const start = quarterStart(today, fy);
      return period(start, addDays(addMonths(start, 3), -1), today);
    }
    case 'last_quarter': {
      const start = addMonths(quarterStart(today, fy), -3);
      return period(start, addDays(addMonths(start, 3), -1), today);
    }
    case 'last_3m':
    case 'last_6m':
    case 'last_12m': {
      // Whole calendar months, including the current one (ADR 0011 §1).
      const months = { last_3m: 3, last_6m: 6, last_12m: 12 }[spec.preset];
      return period(addMonths(startOfMonth(today), -(months - 1)), endOfMonth(today), today);
    }
    case 'ytd':
      return { from: fiscalYearStart(today, fy), to: today, periodEnd: today, partial: false };
    case 'this_year': {
      const start = fiscalYearStart(today, fy);
      return period(start, addDays(addMonths(start, 12), -1), today);
    }
    case 'last_year': {
      const start = addMonths(fiscalYearStart(today, fy), -12);
      return period(start, addDays(addMonths(start, 12), -1), today);
    }
    case 'all_time': {
      const from = earliest && earliest < today ? earliest : today;
      return { from, to: today, periodEnd: today, partial: false };
    }
  }
}

/** The range to compare against (ADR 0011 §2): the period just before, or the same one a year ago. */
export function comparisonRange(
  range: ResolvedRange,
  spec: DateRangeSpec,
  compare: Comparison,
): ResolvedRange | null {
  if (compare === 'none') return null;
  if (compare === 'same_period_last_year') {
    return {
      from: addMonths(range.from, -12),
      to: addMonths(range.to, -12),
      periodEnd: addMonths(range.periodEnd, -12),
      partial: false,
    };
  }
  // Calendar periods compare with the previous calendar period, aligned day for day so far:
  // "this month so far" (Oct 1–6) compares with Sep 1–6.
  const calendarMonths: Partial<Record<Preset, number>> = {
    this_month: 1,
    last_month: 1,
    this_quarter: 3,
    last_quarter: 3,
    last_3m: 3,
    last_6m: 6,
    last_12m: 12,
    ytd: 12,
    this_year: 12,
    last_year: 12,
  };
  const months = spec.kind === 'preset' ? calendarMonths[spec.preset] : undefined;
  if (months) {
    return {
      from: addMonths(range.from, -months),
      to: addMonths(range.to, -months),
      periodEnd: addMonths(range.periodEnd, -months),
      partial: false,
    };
  }
  const length = dayCount(range.from, range.to);
  return {
    from: addDays(range.from, -length),
    to: addDays(range.from, -1),
    periodEnd: addDays(range.from, -1),
    partial: false,
  };
}

/** A sensible default granularity for a range's length (ADR 0011 §2): auto-picked, overridable. */
export function autoGranularity(from: string, to: string): Granularity {
  const days = dayCount(from, to);
  if (days <= 31) return 'day';
  if (days <= 92) return 'week';
  if (days <= 3 * 366) return 'month';
  if (days <= 8 * 366) return 'quarter';
  return 'year';
}

/** Granularities that make sense for a range: no 1 800 daily bars, no single yearly bar. */
export function allowedGranularities(from: string, to: string): Granularity[] {
  const days = dayCount(from, to);
  return GRANULARITIES.filter((g) =>
    g === 'day'
      ? days <= 92
      : g === 'week'
        ? days >= 14 && days <= 2 * 366
        : g === 'month'
          ? days >= 45
          : g === 'quarter'
            ? days >= 120
            : days >= 400,
  );
}

export interface Bucket {
  start: string;
  end: string;
  /** Not over yet, or cut off by the range: shown "so far", left out of averages. */
  partial: boolean;
}

/** Splits a range into buckets of a granularity, aligned to weeks, months, and fiscal quarters/years. */
export function buckets(
  range: Pick<ResolvedRange, 'from' | 'to' | 'periodEnd'>,
  granularity: Granularity,
  settings: RangeSettings,
  today: string = todayIn(settings.timeZone),
): Bucket[] {
  const fy = settings.fiscalYearStartMonth;
  const align = (d: string) =>
    granularity === 'day'
      ? d
      : granularity === 'week'
        ? weekStart(d, settings.weekStart)
        : granularity === 'month'
          ? startOfMonth(d)
          : granularity === 'quarter'
            ? quarterStart(d, fy)
            : fiscalYearStart(d, fy);
  const next = (d: string) =>
    granularity === 'day'
      ? addDays(d, 1)
      : granularity === 'week'
        ? addDays(d, 7)
        : addMonths(d, granularity === 'month' ? 1 : granularity === 'quarter' ? 3 : 12);
  const out: Bucket[] = [];
  for (let start = align(range.from); start <= range.to; start = next(start)) {
    const naturalEnd = addDays(next(start), -1);
    const clippedStart = start < range.from ? range.from : start;
    const end = naturalEnd > range.to ? range.to : naturalEnd;
    out.push({
      start: clippedStart,
      end,
      partial: clippedStart !== start || naturalEnd > today || end !== naturalEnd,
    });
    if (out.length > 5000) throw new RangeError('Too many buckets for this range');
  }
  return out;
}

/**
 * Averages per bucket (ADR 0011 §3): partial periods are left out, and so are periods with no
 * data (before an account was linked), rather than counting them as zero.
 */
export function averageOf(points: { value: number | null; partial: boolean }[]): number | null {
  const complete = points.filter((p) => !p.partial && p.value !== null) as { value: number }[];
  if (complete.length === 0) return null;
  return Math.round(complete.reduce((sum, p) => sum + p.value, 0) / complete.length);
}
