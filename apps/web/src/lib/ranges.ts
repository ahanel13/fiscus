// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  allowedGranularities,
  autoGranularity,
  type Comparison,
  COMPARISONS,
  type DateRangeSpec,
  type Granularity,
  GRANULARITIES,
  type Preset,
  PRESETS,
  type RangeSettings,
  type ResolvedRange,
  resolveRange,
} from '@fiscus/shared';

// Time-range presets (ADR 0011). Rolling and calendar presets are grouped separately so the
// difference is obvious.
export const RANGE_GROUPS = [
  {
    label: 'Rolling',
    presets: [
      ['last_7d', 'Last 7 days'],
      ['last_30d', 'Last 30 days'],
      ['last_90d', 'Last 90 days'],
    ],
  },
  {
    label: 'Calendar',
    presets: [
      ['this_month', 'This month'],
      ['last_month', 'Last month'],
      ['this_quarter', 'This quarter'],
      ['last_quarter', 'Last quarter'],
      ['last_3m', 'Last 3 months'],
      ['last_6m', 'Last 6 months'],
      ['last_12m', 'Last 12 months'],
      ['ytd', 'Year to date'],
      ['this_year', 'This year'],
      ['last_year', 'Last year'],
      ['all_time', 'All time'],
    ],
  },
] as const satisfies readonly { label: string; presets: readonly (readonly [Preset, string])[] }[];

export type RangePreset = Preset;
export const PRESET_LABELS = Object.fromEntries(
  RANGE_GROUPS.flatMap((g) => [...g.presets] as (readonly [Preset, string])[]),
) as Record<Preset, string>;

export const parseRange = (value: unknown, fallback: Preset = 'last_30d'): Preset =>
  typeof value === 'string' && (PRESETS as readonly string[]).includes(value)
    ? (value as Preset)
    : fallback;

/** What a page shows: a preset or custom range, plus granularity and comparison (ADR 0011 §2). */
export interface RangeSelection {
  range: Preset | 'custom';
  from?: string;
  to?: string;
  granularity?: Granularity;
  compare: Comparison;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a selection from URL search params or a stored preference; invalid parts are dropped. */
export function readSelection(raw: unknown): RangeSelection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const compare = (COMPARISONS as readonly string[]).includes(s.compare as string)
    ? (s.compare as Comparison)
    : 'none';
  const granularity = (GRANULARITIES as readonly string[]).includes(s.granularity as string)
    ? (s.granularity as Granularity)
    : undefined;
  if (s.range === 'custom') {
    if (
      typeof s.from === 'string' &&
      typeof s.to === 'string' &&
      ISO.test(s.from) &&
      ISO.test(s.to) &&
      s.from <= s.to
    ) {
      return {
        range: 'custom',
        from: s.from,
        to: s.to,
        compare,
        ...(granularity ? { granularity } : {}),
      };
    }
    return undefined;
  }
  if (typeof s.range === 'string' && (PRESETS as readonly string[]).includes(s.range)) {
    return { range: s.range as Preset, compare, ...(granularity ? { granularity } : {}) };
  }
  return undefined;
}

export const specOf = (s: RangeSelection): DateRangeSpec =>
  s.range === 'custom'
    ? { kind: 'custom', from: s.from!, to: s.to! }
    : { kind: 'preset', preset: s.range };

export const resolveSelection = (s: RangeSelection, settings: RangeSettings): ResolvedRange =>
  resolveRange(specOf(s), settings);

/** The granularity in effect: the chosen one if it suits the range, else the automatic one. */
export function effectiveGranularity(s: RangeSelection, r: ResolvedRange): Granularity {
  const allowed = allowedGranularities(r.from, r.to);
  return s.granularity && allowed.includes(s.granularity)
    ? s.granularity
    : autoGranularity(r.from, r.to);
}

/** Query-string parameters for the API (ADR 0011 §1). */
export function rangeParams(s: RangeSelection, granularity?: Granularity): URLSearchParams {
  const p = new URLSearchParams({ range: s.range });
  if (s.range === 'custom') {
    p.set('from', s.from!);
    p.set('to', s.to!);
  }
  if (granularity) p.set('granularity', granularity);
  if (s.compare !== 'none') p.set('compare', s.compare);
  return p;
}

const dates = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const datesWithYear = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const at = (d: string) => new Date(`${d}T00:00:00Z`);

/** "Sep 7 – Oct 6" (the year shows when it isn't this year, or the dates span two years). */
export function formatSpan(
  from: string,
  to: string,
  thisYear = new Date().getUTCFullYear(),
): string {
  const sameYear = from.slice(0, 4) === to.slice(0, 4) && Number(to.slice(0, 4)) === thisYear;
  const f = sameYear ? dates : datesWithYear;
  return from === to ? f.format(at(from)) : `${f.format(at(from))} – ${f.format(at(to))}`;
}

/** The label for a selection: "Last 30 days" or "Sep 1 – Sep 30, 2025". */
export const selectionLabel = (s: RangeSelection) =>
  s.range === 'custom' ? formatSpan(s.from!, s.to!) : PRESET_LABELS[s.range];

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  quarter: 'Quarterly',
  year: 'Yearly',
};

const monthOnly = new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' });
const monthYear = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A bucket's label: "May" for a whole month (with the year if not this year), else its dates. */
export function bucketLabel(
  start: string,
  end: string,
  thisYear = new Date().getUTCFullYear(),
): string {
  const s = at(start);
  const nextMonth = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
  const lastDay = new Date(nextMonth.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (start.endsWith('-01') && end === lastDay) {
    return (s.getUTCFullYear() === thisYear ? monthOnly : monthYear).format(s);
  }
  return formatSpan(start, end, thisYear);
}
