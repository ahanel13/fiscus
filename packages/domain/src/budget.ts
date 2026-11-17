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
  /** The same income per income category: positive is money in. */
  incomeByCategory: ReadonlyMap<string, number>;
  /**
   * Contributions (D2): for the household's budget, money members moved into joint accounts; for
   * a member's own, what they moved into joint accounts, which leaves their budget for Ours.
   */
  contributionsMinor: number;
  /**
   * What reached each goal this month (goals and budgets G4): transfers into the accounts it
   * draws on, split by claims (G13); for a debt, what was paid over its minimum (G9).
   */
  goalMovedMinor?: ReadonlyMap<string, number>;
  /**
   * The part of that which `savingsMovedMinor` doesn't already count: into accounts that aren't
   * for saving, and extra paid on debts. 50/30/20's Savings adds it, so nothing counts twice (G5).
   */
  goalMovedElsewhereMinor?: number;
  /**
   * Money moved into savings and investment accounts in the scope (50/30/20's Savings, D10):
   * transfers from accounts that aren't either. A goal's contributions are among these (G5).
   */
  savingsMovedMinor?: number;
}

export const NO_ACTIVITY: MonthActivity = {
  spentMinor: new Map(),
  incomeMinor: 0,
  incomeByCategory: new Map(),
  contributionsMinor: 0,
};

/** What a month hands the next: balances per category, and money not yet given a job. */
export interface Carry {
  balances: ReadonlyMap<string, number>;
  unassignedMinor: number;
}

export const NOTHING_CARRIED: Carry = { balances: new Map(), unassignedMinor: 0 };

/** Whose budget: the household's (Ours) or a member's own (Mine). Contributions differ (D2). */
export type BudgetScopeKind = 'household' | 'mine';

/**
 * A goal as a budget line (goals and budgets G4): its plan is the line's amount (G16), by month,
 * and what moved is in the month's activity. It's in the budget from the month it began, to the
 * month it was archived in.
 */
export interface BudgetGoalLine {
  id: string;
  kind: 'save' | 'pay_down';
  /** Its plan from a month on: a month without its own has the last one before it. */
  plans: ReadonlyMap<Month, number>;
  fromMonth: Month;
  /** The month it was archived in, or null. */
  untilMonth: Month | null;
}

/** A goal line in one month, as a strategy is given it. */
export interface MonthGoal {
  id: string;
  kind: BudgetGoalLine['kind'];
  /** Its plan this month. */
  plannedMinor: number;
  /** Whether the plan was set in this month itself, rather than repeating an earlier one. */
  ownPlan: boolean;
  /** Archived before this month, or begun after it: shown only for what's left on it. */
  ended: boolean;
}

/** A goal line's plan in `month`: its own, or the last one before it. */
export function planFor(month: Month, plans: ReadonlyMap<Month, number>): number {
  let best: Month | undefined;
  for (const m of plans.keys()) if (m <= month && (best === undefined || m > best)) best = m;
  return best === undefined ? 0 : plans.get(best)!;
}

/**
 * A goal's line where it's planned against what moved (category limits and flex, G5): never
 * spending, so it never makes the budget over, and nothing rolls over.
 */
export interface GoalLineRow {
  goalId: string;
  budgetedMinor: number;
  movedMinor: number;
  /** Still to move: `budgeted − moved`; below zero is more than planned. */
  leftMinor: number;
}

/** The goal lines of a month: every goal in it, and an ended one only if something moved. */
export function goalLineRows(goals: readonly MonthGoal[], activity: MonthActivity): GoalLineRow[] {
  const rows: GoalLineRow[] = [];
  for (const g of goals) {
    const moved = activity.goalMovedMinor?.get(g.id) ?? 0;
    if (g.ended && moved === 0) continue;
    const budgeted = g.ended ? 0 : g.plannedMinor;
    rows.push({
      goalId: g.id,
      budgetedMinor: budgeted,
      movedMinor: moved,
      leftMinor: budgeted - moved,
    });
  }
  return rows;
}

const monthGoal = (g: BudgetGoalLine, month: Month): MonthGoal => ({
  id: g.id,
  kind: g.kind,
  plannedMinor: planFor(month, g.plans),
  ownPlan: g.plans.has(month),
  ended: month < g.fromMonth || (g.untilMonth !== null && month > g.untilMonth),
});

/**
 * An allowance, or fun money (#114, D15): a line in the household's budget that funds one
 * member's own each month, from a month on. A month without a row of its own has the last one
 * before it; an amount of zero stops it.
 */
export interface BudgetAllowance {
  memberId: string;
  /** The month it's set from. */
  month: Month;
  categoryId: string;
  amountMinor: number;
  /** The month its member left in, or null: none after it. */
  untilMonth: Month | null;
}

/** An allowance in one month: whose, which category, and how much. */
export interface MonthAllowance {
  memberId: string;
  categoryId: string;
  amountMinor: number;
}

/** The allowances running in `month`: each member's last row on or before it, unless stopped. */
export function allowancesIn(
  month: Month,
  allowances: readonly BudgetAllowance[],
): MonthAllowance[] {
  const latest = new Map<string, BudgetAllowance>();
  for (const a of allowances) {
    if (a.month > month) continue;
    const seen = latest.get(a.memberId);
    if (!seen || a.month > seen.month) latest.set(a.memberId, a);
  }
  return [...latest.values()]
    .filter((a) => a.amountMinor > 0 && (a.untilMonth === null || month <= a.untilMonth))
    .map(({ memberId, categoryId, amountMinor }) => ({ memberId, categoryId, amountMinor }));
}

/**
 * A month as allowances make it (D15). Each allowance's category has the allowances in it as its
 * amount, whatever the budget had there. In the household's budget the whole amount is spent, as
 * it's handed over that month: the budget never shows how it was spent (ADR 0006 §7.4). In the
 * member's own it arrives as money in, and what they spend in its category counts against it.
 */
export function withAllowances(
  scope: BudgetScopeKind,
  amounts: ReadonlyMap<string, number>,
  activity: MonthActivity,
  allowances: readonly MonthAllowance[],
): {
  amounts: ReadonlyMap<string, number>;
  activity: MonthActivity;
  /** The allowances' categories, and their amounts. */
  byCategory: ReadonlyMap<string, number>;
} {
  const byCategory = new Map<string, number>();
  for (const a of allowances) {
    byCategory.set(a.categoryId, (byCategory.get(a.categoryId) ?? 0) + a.amountMinor);
  }
  if (byCategory.size === 0) return { amounts, activity, byCategory };
  const total = [...byCategory.values()].reduce((s, v) => s + v, 0);
  const spent = new Map(activity.spentMinor);
  if (scope === 'household') {
    for (const [id, v] of byCategory) spent.set(id, (spent.get(id) ?? 0) + v);
  }
  return {
    amounts: new Map([...amounts, ...byCategory]),
    activity: {
      ...activity,
      spentMinor: spent,
      incomeMinor: activity.incomeMinor + (scope === 'mine' ? total : 0),
    },
    byCategory,
  };
}

/** Everything a strategy is given for one month. */
export interface StrategyMonth<S> {
  month: Month;
  settings: S;
  scope: BudgetScopeKind;
  categories: readonly BudgetCategory[];
  goals: readonly MonthGoal[];
  /** This month's amounts by category id (see `amountsFor`). */
  amounts: ReadonlyMap<string, number>;
  /** Whether the month has amounts of its own, rather than repeating an earlier month's. */
  ownAmounts: boolean;
  /**
   * Allowances' categories and their amounts (D15), already in `amounts`. They're set every
   * month, so zero-based assigns them whether or not the month has amounts of its own.
   */
  allowances?: ReadonlyMap<string, number>;
  /** Money moved between lines this month (zero-based, D9): net per line, in is positive. */
  moves: ReadonlyMap<string, number>;
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
  /** The household's when left out. */
  scope?: BudgetScopeKind;
  /** The first month it covers. */
  startsMonth: Month;
  /** The first starts on or before `startsMonth`; switching adds one (D14). */
  periods: readonly BudgetPeriod[];
  categories: readonly BudgetCategory[];
  /** Amounts by month, for the months that have their own. */
  amounts: ReadonlyMap<Month, ReadonlyMap<string, number>>;
  /** Money moved between lines, net per line, for the months that have some. */
  moves?: ReadonlyMap<Month, ReadonlyMap<string, number>>;
  /** Goals with a line in this budget (G4): its scope's, Ours or Mine. */
  goals?: readonly BudgetGoalLine[];
  /** Allowances (D15): every member's in the household's budget, the member's own in theirs. */
  allowances?: readonly BudgetAllowance[];
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
    const scope = budget.scope ?? 'household';
    const allowed = withAllowances(
      scope,
      amountsFor(month, budget.amounts),
      activity.get(month) ?? NO_ACTIVITY,
      allowancesIn(month, budget.allowances ?? []),
    );
    const out = strategy.month({
      month,
      settings: settings.get(period),
      scope,
      categories: budget.categories,
      goals: (budget.goals ?? []).map((g) => monthGoal(g, month)),
      amounts: allowed.amounts,
      ownAmounts: budget.amounts.has(month),
      allowances: allowed.byCategory,
      moves: budget.moves?.get(month) ?? new Map(),
      activity: allowed.activity,
      carry,
    });
    if (month === target) return { kind: period.kind, view: out.view, carry: out.carry };
    carry = out.carry;
  }
}
