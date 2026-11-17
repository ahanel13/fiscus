// SPDX-License-Identifier: AGPL-3.0-or-later
import { budgetMonthOf, budgetMonthRange, type Household, todayIn } from '@fiscus/shared';

// Budget months (#71, ADR 0011 §4): named for the month they start in, from the household's
// start day. Day 1 is the calendar month, and shows no dates.

/** "1st", "2nd", "15th", "31st". */
export const ordinal = (n: number) =>
  n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

const shortDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export const longDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** The budget month today is in, in the household's time zone. */
export const thisBudgetMonth = (h: Pick<Household, 'timezone' | 'budgetMonthStartDay'>) =>
  budgetMonthOf(todayIn(h.timezone), h.budgetMonthStartDay);

/** "Nov 15 – Dec 14": a budget month's days, or null when they're the calendar month's. */
export function monthDates(month: string, startDay: number): string | null {
  if (startDay === 1) return null;
  const r = budgetMonthRange(month, startDay);
  return `${shortDate(r.from)} – ${shortDate(r.to)}`;
}

/** What a start day means, with the budget month running today as the example. */
export function startDayHint(startDay: number, today: string): string {
  if (startDay === 1) {
    return 'Budgets follow calendar months. Pick a later day to match a mid-month payday.';
  }
  const month = budgetMonthOf(today, startDay);
  const name = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    timeZone: 'UTC',
  });
  const short =
    startDay > 28 ? `, and start on the last day of months without the ${ordinal(startDay)}` : '';
  return `${name}’s budget runs ${monthDates(month, startDay)}. Months are named for the month they start in${short}.`;
}
