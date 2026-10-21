// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, households, transactions } from '@fiscus/db';
import { type RangeSettings, todayIn } from '@fiscus/shared';
import { eq } from 'drizzle-orm';

// A household's time settings (ADR 0011): its time zone, week start, fiscal year, and date basis.
// Every time-based endpoint, and anything else that needs "today", goes through here.

export interface HouseholdRanges {
  settings: RangeSettings;
  /** Which date transactions count on: posted (default) or authorized (#69). */
  dateBasis: 'posted' | 'authorized';
  today: string;
}

/**
 * The household isn't there, or isn't visible from this context. `statusCode` makes the api
 * answer 404 Not found (ProblemFilter), as it did before this moved out of the api.
 */
export class HouseholdNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('Household not found');
    this.name = 'HouseholdNotFoundError';
  }
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
  if (!h) throw new HouseholdNotFoundError();
  const { dateBasis, ...settings } = h;
  return { settings, dateBasis, today: todayIn(settings.timeZone) };
}

/** The transaction date column for the household's date basis. */
export const transactionDate = (basis: HouseholdRanges['dateBasis']) =>
  basis === 'authorized' ? transactions.effectiveAuthorizedDate : transactions.effectiveDate;
