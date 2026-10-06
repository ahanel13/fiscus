// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, households, transactions } from '@fiscus/db';
import {
  autoGranularity,
  comparisonRange,
  type Comparison,
  type DateRangeSpec,
  type Granularity,
  PRESETS,
  type RangeMeta,
  type RangeSettings,
  type ResolvedRange,
  resolveRange,
  todayIn,
} from '@fiscus/shared';
import { eq } from 'drizzle-orm';
import { Problem } from '../common/problem.js';

// Resolving time ranges for a household (ADR 0011): its time zone, week start, fiscal year, and
// date basis. Every time-based endpoint goes through here, so they all agree.

export interface HouseholdRanges {
  settings: RangeSettings;
  /** Which date transactions count on: posted (default) or authorized (#69). */
  dateBasis: 'posted' | 'authorized';
  today: string;
}

export async function householdRanges(tx: Executor, householdId: string): Promise<HouseholdRanges> {
  const [h] = await tx
    .select({
      timeZone: households.timezone,
      weekStart: households.weekStart,
      fiscalYearStartMonth: households.fiscalYearStartMonth,
      dateBasis: households.dateBasis,
    })
    .from(households)
    .where(eq(households.id, householdId));
  if (!h) throw new Problem(404, 'not_found', 'Not found');
  const { dateBasis, ...settings } = h;
  return { settings, dateBasis, today: todayIn(settings.timeZone) };
}

/** The transaction date column for the household's date basis. */
export const transactionDate = (basis: HouseholdRanges['dateBasis']) =>
  basis === 'authorized' ? transactions.effectiveAuthorizedDate : transactions.effectiveDate;

export interface RangeParams {
  range?: (typeof PRESETS)[number] | 'custom' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  granularity?: Granularity | undefined;
  compare?: Comparison | undefined;
}

export interface Resolved {
  spec: DateRangeSpec;
  range: ResolvedRange;
  granularity: Granularity;
  comparison: ResolvedRange | null;
  meta: RangeMeta;
}

const MAX_DAYS = 3660;

/**
 * Resolves `range`/`from`/`to`/`granularity`/`compare` from a query. Returns null when no range
 * was given, so callers can keep their own default. `earliest` is the first data, for "all time".
 */
export function resolveParams(
  params: RangeParams,
  h: HouseholdRanges,
  earliest?: string,
): Resolved | null {
  if (!params.range) return null;
  if (params.range === 'custom' && (!params.from || !params.to)) {
    throw new Problem(422, 'invalid_range', 'A custom range needs "from" and "to"');
  }
  const spec: DateRangeSpec =
    params.range === 'custom'
      ? { kind: 'custom', from: params.from!, to: params.to! }
      : { kind: 'preset', preset: params.range };
  const range = resolveRange(spec, h.settings, new Date(), earliest);
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
  if (days > MAX_DAYS)
    throw new Problem(422, 'window_too_long', 'Choose a period of 10 years or less');
  const granularity = params.granularity ?? autoGranularity(range.from, range.to);
  const comparison = comparisonRange(range, spec, params.compare ?? 'none');
  return {
    spec,
    range,
    granularity,
    comparison,
    meta: {
      ...range,
      granularity,
      comparison: comparison ? { from: comparison.from, to: comparison.to } : null,
    },
  };
}
