// SPDX-License-Identifier: AGPL-3.0-or-later

// Budgets (#98, docs/design/walkthroughs/budgeting.md): the model every strategy shares, and the
// engine that runs a budget from its first month to the one being looked at. A strategy decides
// how amounts are read, what a month shows, and what carries into the next (architecture,
// "Budgeting strategies"); this file knows none of that. Nothing here is stored: a month is
// computed from the amounts and the ledger each time it's read (D13).

/** A calendar month, `YYYY-MM`. Compares in order as a string. */
export type Month = string;

export const BUDGET_STRATEGIES = ['category', 'zero_based', 'percentage', 'flex'] as const;
export type BudgetStrategyKind = (typeof BUDGET_STRATEGIES)[number];

/** A category group's kind (data model, `category_kind`). */
export type CategoryKind = 'income' | 'fixed' | 'flexible' | 'non_monthly' | 'savings' | 'transfer';

/** A category as a budget sees it: its group's kind, and the budget's settings for it. */
export interface BudgetCategory {
  id: string;
  kind: CategoryKind;
  /** Category limits: what's left (or overspent) moves to next month (§3.1). */
  rollover: boolean;
  /** 50/30/20: the bucket it counts in, when not the one its kind gives (D10). */
  bucket: string | null;
  /** Non-monthly costs: the yearly figure a twelfth of is set aside each month (D12). */
  yearlyMinor: number | null;
}

/**
 * One month of the budget's scope in the ledger: what's attributed to it (D1), with transfers,
 * settle-ups, and excluded transactions already left out. Minor units, household currency.
 */
export interface MonthActivity {
  /** Spending per category, net of refunds: positive is money spent. */
  spentMinor: ReadonlyMap<string, number>;
  /** Income attributed to the scope. */
  incomeMinor: number;
  /**
   * Contributions (D2): for the household's budget, money members moved into joint accounts; for
   * a member's own, what they moved into joint accounts, which leaves their budget for Ours.
   */
  contributionsMinor: number;
}

export const NO_ACTIVITY: MonthActivity = {
  spentMinor: new Map(),
  incomeMinor: 0,
  contributionsMinor: 0,
};

/** What a month hands the next: balances per category, and money not yet given a job. */
export interface Carry {
  balances: ReadonlyMap<string, number>;
  unassignedMinor: number;
}

export const NOTHING_CARRIED: Carry = { balances: new Map(), unassignedMinor: 0 };

/** Everything a strategy is given for one month. */
export interface StrategyMonth<S> {
  month: Month;
  settings: S;
  categories: readonly BudgetCategory[];
  /** This month's amounts by category id (see `amountsFor`). */
  amounts: ReadonlyMap<string, number>;
  activity: MonthActivity;
  /** From the month before, under whichever strategy it ran (D14). */
  carry: Carry;
}

/**
 * A budgeting strategy. `S` is its settings, `V` what a month shows. Strategies are pure: the same
 * inputs give the same month, so a month can always be computed again.
 */
export interface BudgetStrategy<S = unknown, V = unknown> {
  readonly kind: BudgetStrategyKind;
  /** Reads stored settings, filling in defaults. Throws `BudgetSettingsError` on a bad shape. */
  settings(raw: Readonly<Record<string, unknown>>): S;
  /** One month: what it shows, and what carries into the next. */
  month(input: StrategyMonth<S>): { view: V; carry: Carry };
}

/** A strategy, and the month it runs from. */
export interface BudgetPeriod {
  fromMonth: Month;
  kind: BudgetStrategyKind;
  settings: Readonly<Record<string, unknown>>;
}

export interface BudgetDefinition {
  /** The first month it covers. */
  startsMonth: Month;
  /** The first starts on or before `startsMonth`; switching adds one (D14). */
  periods: readonly BudgetPeriod[];
  categories: readonly BudgetCategory[];
  /** Amounts by month, for the months that have their own. */
  amounts: ReadonlyMap<Month, ReadonlyMap<string, number>>;
}

export type StrategyRegistry = Partial<Record<BudgetStrategyKind, BudgetStrategy>>;

export class BudgetSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetSettingsError';
  }
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function parseMonth(month: Month): [number, number] {
  const m = MONTH.exec(month);
  if (!m) throw new RangeError(`Not a month: ${month}`);
  return [Number(m[1]), Number(m[2])];
}

/** The month `n` months after (or before, for negative `n`) `month`. */
export function addMonths(month: Month, n: number): Month {
  const [y, m] = parseMonth(month);
  const index = y * 12 + (m - 1) + n;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The month a date (`YYYY-MM-DD`) falls in. */
export function monthOf(date: string): Month {
  const month = date.slice(0, 7);
  parseMonth(month);
  return month;
}

/** The first day of a month, as the database stores months. */
export function firstDayOf(month: Month): string {
  parseMonth(month);
  return `${month}-01`;
}

/**
 * A month's amounts: its own, or those of the last month before it that had some. A plan stays
 * as it was until it's changed, so a new month needs nothing entered; changing an amount in a
 * month without its own copies these first, then changes the one.
 */
export function amountsFor(
  month: Month,
  amounts: BudgetDefinition['amounts'],
): ReadonlyMap<string, number> {
  let best: Month | undefined;
  for (const m of amounts.keys()) {
    if (m <= month && (best === undefined || m > best)) best = m;
  }
  return best === undefined ? new Map() : amounts.get(best)!;
}

/** The period a month runs under: the last one starting on or before it. */
export function periodFor(month: Month, periods: readonly BudgetPeriod[]): BudgetPeriod {
  let found: BudgetPeriod | undefined;
  for (const p of periods) {
    if (p.fromMonth <= month && (found === undefined || p.fromMonth > found.fromMonth)) found = p;
  }
  if (!found) throw new RangeError(`No strategy runs in ${month}`);
  return found;
}

/**
 * Runs a budget from its first month to `target` and returns what `target` shows. Each month's
 * carry goes into the next, including across a change of strategy (D14): the strategy a month
 * ran under decides what it carries, and the next one starts from that.
 *
 * `activity` holds the ledger's months; a month that isn't there had none.
 */
export function computeBudgetMonth(
  budget: BudgetDefinition,
  target: Month,
  activity: ReadonlyMap<Month, MonthActivity>,
  strategies: StrategyRegistry,
): { kind: BudgetStrategyKind; view: unknown; carry: Carry } {
  if (target < budget.startsMonth) {
    throw new RangeError(`The budget starts in ${budget.startsMonth}, after ${target}`);
  }
  const settings = new Map<BudgetPeriod, unknown>();
  let carry = NOTHING_CARRIED;
  for (let month = budget.startsMonth; ; month = addMonths(month, 1)) {
    const period = periodFor(month, budget.periods);
    const strategy = strategies[period.kind];
    if (!strategy) throw new Error(`The ${period.kind} strategy isn't available`);
    if (!settings.has(period)) settings.set(period, strategy.settings(period.settings));
    const out = strategy.month({
      month,
      settings: settings.get(period),
      categories: budget.categories,
      amounts: amountsFor(month, budget.amounts),
      activity: activity.get(month) ?? NO_ACTIVITY,
      carry,
    });
    if (month === target) return { kind: period.kind, view: out.view, carry: out.carry };
    carry = out.carry;
  }
}
