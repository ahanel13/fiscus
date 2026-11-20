// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, households, transactions } from '@fiscus/db';
import { budgetMonthOf, type RangeSettings, todayIn } from '@fiscus/shared';
import { eq, type SQL, sql, type SQLWrapper } from 'drizzle-orm';

// A household's time settings (ADR 0011): its time zone, week start, fiscal year, budget month
// start day, and date basis.
// Every time-based endpoint, and anything else that needs "today", goes through here.

export interface HouseholdRanges {
  settings: RangeSettings;
  /** Which date transactions count on: posted (default) or authorized (#69). */
  dateBasis: 'posted' | 'authorized';
  today: string;
  /** The day budget months start on (#71): 1 is the calendar month. Budget views only. */
  budgetStartDay: number;
  /** The budget month (`YYYY-MM`) today is in. */
  budgetMonth: string;
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
      budgetStartDay: households.budgetMonthStartDay,
    })
    .from(households)
    .where(eq(households.id, householdId));
  if (!h) throw new HouseholdNotFoundError();
  const { dateBasis, budgetStartDay, ...settings } = h;
  const today = todayIn(settings.timeZone);
  return {
    settings,
    dateBasis,
    today,
    budgetStartDay,
    budgetMonth: budgetMonthOf(today, budgetStartDay),
  };
}

/** The transaction date column for the household's date basis. */
export const transactionDate = (basis: HouseholdRanges['dateBasis']) =>
  basis === 'authorized' ? transactions.effectiveAuthorizedDate : transactions.effectiveDate;

/**
 * The budget month (`YYYY-MM`) of a date column, as budgetMonthOf() works it out: before the
 * start day (or the month's last day, when it has fewer days), it's the month before's.
 */
export function budgetMonthSql(date: SQLWrapper, startDay: number): SQL<string> {
  if (startDay === 1) return sql<string>`to_char(${date}, 'YYYY-MM')`;
  return sql<string>`to_char(CASE
    WHEN extract(day FROM ${date}) >= least(${startDay}::int,
      extract(day FROM date_trunc('month', ${date}) + interval '1 month - 1 day'))
    THEN date_trunc('month', ${date})
    ELSE date_trunc('month', ${date}) - interval '1 month' END, 'YYYY-MM')`;
}
