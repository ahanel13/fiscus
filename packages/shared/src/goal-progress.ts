// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GoalPace } from './api/goals.js';

// A savings goal's progress over time, its pace and where it leads (#135, #137; goals walkthrough
// §3–§4, goals and budgets G2, G10–G12, G17, G18). Pure: the api reads the claims as they stood at
// each month's end and what moved in, and this works out the rest. Months are budget months
// (`YYYY-MM`, G10). Money in minor units.

/** A claim as it stood at a moment, and what it was worth then (G2, G17). */
export interface ClaimAt {
  accountId: string;
  amountMinor: number | null;
  percentBps: number | null;
  valueMinor: number;
}

/** One month of a goal's history. */
export interface GoalProgressMonth {
  month: string;
  /** What its claims were worth as the month ended; this month's is now. */
  savedMinor: number;
  /** New money that reached its accounts (G4): its budget line's moved figure. */
  movedMinor: number;
  /** How percentage claims moved with their balances, beyond what moved in (G12). */
  marketMinor: number;
  /** Claims set, raised, lowered or taken off: progress, but not saving (G11). */
  claimsMinor: number;
}

/** What a goal's pace is, and where it came from (G18). */
export interface GoalPaceBasis {
  /** A month's pace: what moved in, on average, over the last three months; or its plan. */
  paceMinor: number;
  /** `moved` once it's three full months old; `plan` while it's newer. */
  basis: 'moved' | 'plan';
}

/** A savings goal up close: its history, its pace, and where that leads (#135, #137). */
export interface GoalProgress {
  goalId: string;
  thisMonth: string;
  /** Where today is in this month, from 0 (its first day) to 1, for the chart's "now". */
  monthFraction: number;
  /** Oldest first, through this month. A newer member's start at their window (#256). */
  months: GoalProgressMonth[];
  pace: GoalPace & GoalPaceBasis;
  /** At this pace, from the end of this month until it reaches the target (at most 10 years). */
  projection: { month: string; savedMinor: number }[];
  /** A steady line from where it began to the target by its date; null without a date. */
  steady: { fromMonth: string; fromMinor: number; toMonth: string; toMinor: number } | null;
  /** What to change, when it's at risk (walkthrough §4). */
  fixes: {
    /** The monthly amount that makes its date, from this month. */
    planMinor: number | null;
    /** The month its pace makes, as a new date. */
    month: string | null;
  };
}

export const monthIndex = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return y * 12 + m - 1;
};
export const monthOf = (index: number) =>
  `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

/** The most a projection runs to: ten years. */
const MAX_MONTHS = 120;

/**
 * A goal's pace (G18): the average that moved in over the last three full months, or its plan
 * while it's newer than that. A plan nobody follows doesn't keep a goal on track, and the market
 * isn't in it (G12).
 */
export function paceOf(g: {
  thisMonth: string;
  /** Its first month: the budget month it was made in. */
  firstMonth: string;
  planMinor: number | null;
  /** What moved in, by month. */
  moved: ReadonlyMap<string, number>;
}): GoalPaceBasis {
  const now = monthIndex(g.thisMonth);
  if (monthIndex(g.firstMonth) > now - 3) return { paceMinor: g.planMinor ?? 0, basis: 'plan' };
  let sum = 0;
  for (let i = 1; i <= 3; i++) sum += g.moved.get(monthOf(now - i)) ?? 0;
  return { paceMinor: Math.max(0, Math.round(sum / 3)), basis: 'moved' };
}

/**
 * Where a steady pace from its start to its date would be at `at` (a month index, fractional
 * within a month; a month's index is its end). Before its first month's end it's where it began.
 */
export function steadyAt(
  s: { fromMonth: string; fromMinor: number; toMonth: string; toMinor: number },
  at: number,
): number {
  const from = monthIndex(s.fromMonth);
  const to = monthIndex(s.toMonth);
  if (at <= from) return s.fromMinor;
  if (at >= to || to <= from) return s.toMinor;
  return s.fromMinor + ((s.toMinor - s.fromMinor) * (at - from)) / (to - from);
}

/**
 * Splits each month's change in what a goal has (G11, G12): a claim whose terms stayed put and is
 * a percentage moved with its balance, which is what moved in plus the market; a claim set,
 * changed or taken off is earmarking, progress but not saving; a fixed claim that stayed put
 * didn't change. `before` is the claims as the month before the first ended; null when that's
 * not known (outside a newer member's window), and the first month then only shows its total.
 */
export function goalHistory(input: {
  before: ClaimAt[] | null;
  ends: { month: string; claims: ClaimAt[] }[];
  /** What moved in to each of its accounts, by month then account. */
  moved: ReadonlyMap<string, ReadonlyMap<string, number>>;
}): GoalProgressMonth[] {
  const out: GoalProgressMonth[] = [];
  let prev = input.before;
  for (const end of input.ends) {
    const movedIn = input.moved.get(end.month) ?? new Map<string, number>();
    const savedMinor = end.claims.reduce((s, c) => s + c.valueMinor, 0);
    const movedMinor = [...movedIn.values()].reduce((s, v) => s + v, 0);
    let marketMinor = 0;
    let claimsMinor = 0;
    if (prev) {
      const was = new Map(prev.map((c) => [c.accountId, c]));
      const is = new Map(end.claims.map((c) => [c.accountId, c]));
      for (const accountId of new Set([...was.keys(), ...is.keys()])) {
        const p = was.get(accountId);
        const e = is.get(accountId);
        const change = (e?.valueMinor ?? 0) - (p?.valueMinor ?? 0);
        const same = p && e && p.amountMinor === e.amountMinor && p.percentBps === e.percentBps;
        if (!same) claimsMinor += change;
        else if (e.percentBps !== null) marketMinor += change - (movedIn.get(accountId) ?? 0);
      }
    }
    out.push({ month: end.month, savedMinor, movedMinor, marketMinor, claimsMinor });
    prev = end.claims;
  }
  return out;
}

/**
 * Status and projection (walkthrough §4, #137), as `goalPace` works it out, with `ahead` when it's
 * a month's plan or more past the steady line (a month's steady amount, without a plan).
 */
export function goalProgress(g: {
  goalId: string;
  thisMonth: string;
  monthFraction: number;
  firstMonth: string;
  targetMinor: number;
  targetDate: string | null;
  planMinor: number | null;
  shortMinor: number;
  /** What it has now. */
  progressMinor: number;
  months: GoalProgressMonth[];
  /** What moved in, by month. */
  moved: ReadonlyMap<string, number>;
  /** Where it began: what it had as its first month ended (or its reader's window's first). */
  start: { month: string; minor: number };
}): GoalProgress {
  const pace = paceOf(g);
  const now = monthIndex(g.thisMonth);
  const steady = g.targetDate
    ? {
        fromMonth: g.start.month,
        fromMinor: Math.min(g.start.minor, g.targetMinor),
        toMonth: g.targetDate.slice(0, 7),
        toMinor: g.targetMinor,
      }
    : null;
  const status = savingsPace({
    progressMinor: g.progressMinor,
    targetMinor: g.targetMinor,
    targetDate: g.targetDate,
    planMinor: g.planMinor,
    shortMinor: g.shortMinor,
    thisMonth: g.thisMonth,
    paceMinor: pace.paceMinor,
    steady: steady ? { ...steady, at: now - 1 + g.monthFraction } : null,
  });
  // This month counts, as the status's projection does.
  const projection: GoalProgress['projection'] = [];
  const left = g.targetMinor - g.progressMinor;
  if (left > 0 && pace.paceMinor > 0) {
    for (let k = 0; k < MAX_MONTHS; k++) {
      const savedMinor = Math.min(g.targetMinor, g.progressMinor + pace.paceMinor * (k + 1));
      projection.push({ month: monthOf(now + k), savedMinor });
      if (savedMinor >= g.targetMinor) break;
    }
  }
  const atRisk = status.status === 'at_risk';
  let planMinor: number | null = null;
  if (atRisk && g.targetDate) {
    const months = monthIndex(g.targetDate.slice(0, 7)) - now + 1;
    if (months >= 1) planMinor = Math.ceil(left / months);
  }
  return {
    goalId: g.goalId,
    thisMonth: g.thisMonth,
    monthFraction: g.monthFraction,
    months: g.months,
    pace: { ...status, ...pace },
    projection,
    steady,
    fixes: {
      planMinor: planMinor !== null && planMinor > (g.planMinor ?? 0) ? planMinor : null,
      month: atRisk ? status.projectedMonth : null,
    },
  };
}

/**
 * A savings goal's status and where its pace leads (walkthrough §4): `done`, `short` (an account
 * backing it holds less than its claims, G3), and for a goal with a date, `on_track`, `ahead` or
 * `at_risk` at its pace. Without a date there's no status, just progress. This month counts: a
 * pace that covers what's left reaches the target this month.
 */
export function savingsPace(g: PaceInput): GoalPace {
  const left = g.targetMinor - g.progressMinor;
  if (left <= 0) return { status: 'done', projectedMonth: null, monthsLate: null };
  const pace = g.paceMinor ?? g.planMinor ?? 0;
  const projected = pace > 0 ? monthIndex(g.thisMonth) + Math.ceil(left / pace) - 1 : null;
  const projectedMonth = projected === null ? null : monthOf(projected);
  if (g.shortMinor > 0) return { status: 'short', projectedMonth, monthsLate: null };
  if (!g.targetDate) return { status: null, projectedMonth, monthsLate: null };
  const due = monthIndex(g.targetDate.slice(0, 7));
  if (projected === null) return { status: 'at_risk', projectedMonth: null, monthsLate: null };
  const late = Math.max(0, projected - due);
  if (late) return { status: 'at_risk', projectedMonth, monthsLate: late };
  // Ahead: a month's plan or more past where a steady pace would be by now.
  const s = g.steady;
  if (s) {
    const span = monthIndex(s.toMonth) - monthIndex(s.fromMonth);
    const month = g.planMinor || (span > 0 ? (s.toMinor - s.fromMinor) / span : 0);
    if (month > 0 && g.progressMinor - steadyAt(s, s.at) >= month) {
      return { status: 'ahead', projectedMonth, monthsLate: 0 };
    }
  }
  return { status: 'on_track', projectedMonth, monthsLate: 0 };
}

/** What `savingsPace` takes. */
export interface PaceInput {
  progressMinor: number;
  targetMinor: number;
  targetDate: string | null;
  planMinor: number | null;
  shortMinor: number;
  thisMonth: string;
  /** A month's pace (G18); its plan when not given. */
  paceMinor?: number;
  /** The steady line, and where now is on it, for `ahead`. */
  steady?: {
    fromMonth: string;
    fromMinor: number;
    toMonth: string;
    toMinor: number;
    at: number;
  } | null;
}
