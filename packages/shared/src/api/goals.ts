// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { payoff } from '../payoff.js';
import { type InstitutionSummary, isoDateSchema } from './accounts.js';

// Goals (#131; goals walkthrough, goals and budgets G1–G22). Money in minor units of the
// household's currency.

/** Whose goal: the household's, or your own (G15). Viewer-relative, as for budgets. */
export const goalScopeSchema = z.enum(['household', 'mine']);
export type GoalScope = z.infer<typeof goalScopeSchema>;

/** Saving up, by claims on accounts (G2); or paying down a loan or card's balance (G9). */
export type GoalKind = 'save' | 'pay_down';

const money = z.number().int().min(1).max(1_000_000_000_00);

/** The icons a goal can wear instead of a photo: lucide's names. */
export const GOAL_ICONS = [
  'piggy-bank',
  'plane',
  'house',
  'car',
  'graduation-cap',
  'heart',
  'gift',
  'umbrella',
  'baby',
  'sprout',
  'shield',
  'briefcase',
  'palmtree',
  'gem',
  'bike',
  'paw-print',
] as const;
export type GoalIconName = (typeof GOAL_ICONS)[number];

/** The colors a goal's icon tile can be: `#rrggbb`, each readable under white or black. */
export const GOAL_COLORS = [
  '#2f9e77',
  '#2b7bb9',
  '#6f5bd3',
  '#c2417a',
  '#d9622b',
  '#c99a1e',
  '#5f7d3a',
  '#5b6472',
] as const;

const goalLook = {
  icon: z.enum(GOAL_ICONS).nullable(),
  color: z.enum(GOAL_COLORS).nullable(),
};

/** A goal's photo, as the browser made it: a small square, base64. */
export const GOAL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** The largest photo kept, in bytes: the browser shrinks it to 256 pixels square first. */
export const GOAL_IMAGE_MAX_BYTES = 200_000;
export const goalImageSchema = z
  .object({
    type: z.enum(GOAL_IMAGE_TYPES),
    dataBase64: z
      .string()
      .max(Math.ceil(GOAL_IMAGE_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

/** Part of an account's balance (G2): a fixed amount, or a percentage in basis points. */
export const goalClaimSchema = z
  .object({
    amountMinor: money.optional(),
    percentBps: z.number().int().min(1).max(10_000).optional(),
  })
  .refine(
    (c) => (c.amountMinor === undefined) !== (c.percentBps === undefined),
    'A fixed amount, or a percentage',
  );

export const createGoalSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Defaults to the household's with two or more of you, else yours. */
  scope: goalScopeSchema.optional(),
  targetMinor: money,
  targetDate: isoDateSchema.nullable().optional(),
  planMinor: z.number().int().min(0).max(1_000_000_000_00).nullable().optional(),
  icon: goalLook.icon.optional(),
  color: goalLook.color.optional(),
  claims: z
    .array(goalClaimSchema.and(z.object({ accountId: z.uuid() })))
    .max(20)
    .refine((c) => new Set(c.map((x) => x.accountId)).size === c.length, 'Each account once')
    .default([]),
});

/** A rate you enter for a debt, in basis points (24.99% = 2499), when the bank doesn't say. */
const aprBps = z.number().int().min(0).max(10_000);
/** A minimum payment you enter, when the bank doesn't say. */
const minimum = z.number().int().min(0).max(1_000_000_000_00);

/**
 * Pay down a loan or card (G9): one goal per debt. Its target is what's owed when it starts,
 * unless you say otherwise; its plan is the extra over the minimum each month.
 */
export const createPayDownSchema = z
  .object({
    accountId: z.uuid(),
    /** Defaults to the account's name. */
    name: z.string().trim().min(1).max(80).optional(),
    scope: goalScopeSchema.optional(),
    targetMinor: money.optional(),
    targetDate: isoDateSchema.nullable().optional(),
    planMinor: z.number().int().min(0).max(1_000_000_000_00).nullable().optional(),
    aprBps: aprBps.nullable().optional(),
    minimumMinor: minimum.nullable().optional(),
    icon: goalLook.icon.optional(),
    color: goalLook.color.optional(),
  })
  .strict();

export const updateGoalSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    targetMinor: money,
    targetDate: isoDateSchema.nullable(),
    planMinor: z.number().int().min(0).max(1_000_000_000_00).nullable(),
    /** A debt's rate and minimum as you enter them; null goes back to the bank's (G9). */
    aprBps: aprBps.nullable(),
    minimumMinor: minimum.nullable(),
    ...goalLook,
  })
  .partial()
  .strict()
  .refine((g) => Object.keys(g).length > 0, 'Nothing to change');

/** Priority (G19): every goal you see, highest first. */
export const orderGoalsSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200) });

/** Which goals give way to a shortfall, and by how much (G3, G19): fixed claims on the account. */
export const giveWaySchema = z.object({
  accountId: z.uuid(),
  take: z
    .array(z.object({ goalId: z.uuid(), amountMinor: money }))
    .min(1)
    .max(50)
    .refine((t) => new Set(t.map((x) => x.goalId)).size === t.length, 'Each goal once'),
});

export interface GoalClaim {
  accountId: string;
  /** Null when it's an account you can't see: only the claim shows (G7). */
  accountName: string | null;
  /** Whose account it is, for "Alex's account". */
  ownerIds: string[];
  amountMinor: number | null;
  percentBps: number | null;
  /** What it's worth now: the amount, or its share of the balance (G3). */
  valueMinor: number;
  /** How far its account falls below its fixed claims; 0 when it doesn't. */
  shortMinor: number;
  /** Whether you can change it: you own the account (G7). */
  yours: boolean;
  /** The bank its account syncs from, for its logo; null when you can't see it, or it has none. */
  institution: InstitutionSummary | null;
}

/**
 * Where a goal stands (walkthrough §4, #137): `done`, `short` (an account backing it holds less
 * than its claims, G3), and for a goal with a date, `on_track` or `at_risk` at its pace. Without
 * a date there's no status, just progress.
 */
export type GoalStatus = 'done' | 'short' | 'on_track' | 'at_risk';

export interface GoalPace {
  status: GoalStatus | null;
  /** The month it reaches its target at this pace, `YYYY-MM`; null when it never would. */
  projectedMonth: string | null;
  /** How many months after its date that is; 0 when on time. Null without a date or a pace. */
  monthsLate: number | null;
}

const monthIndex = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return y * 12 + m - 1;
};
const monthOf = (index: number) =>
  `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

/**
 * A goal's status and where its pace leads. The pace is its monthly plan: what moved in is the
 * walkthrough's pace (G18), and stands in for the plan once contributions are counted (#133).
 * This month counts: a plan that covers what's left reaches the target this month.
 */
export function goalPace(g: {
  progressMinor: number;
  targetMinor: number;
  targetDate: string | null;
  planMinor: number | null;
  shortMinor: number;
  thisMonth: string;
}): GoalPace {
  const left = g.targetMinor - g.progressMinor;
  if (left <= 0) return { status: 'done', projectedMonth: null, monthsLate: null };
  const pace = g.planMinor ?? 0;
  const projected = pace > 0 ? monthIndex(g.thisMonth) + Math.ceil(left / pace) - 1 : null;
  const projectedMonth = projected === null ? null : monthOf(projected);
  if (g.shortMinor > 0) return { status: 'short', projectedMonth, monthsLate: null };
  if (!g.targetDate) return { status: null, projectedMonth, monthsLate: null };
  const due = monthIndex(g.targetDate.slice(0, 7));
  if (projected === null) return { status: 'at_risk', projectedMonth: null, monthsLate: null };
  const late = Math.max(0, projected - due);
  return { status: late ? 'at_risk' : 'on_track', projectedMonth, monthsLate: late };
}

/**
 * A debt a pay-down goal is on (G9): what's owed now, and its rate and minimum, from the bank
 * (Plaid's liabilities) or as entered, the entered one first.
 */
export interface GoalDebt {
  accountId: string;
  /** Null when you can't see the account: it was made private since (only its owners see it). */
  accountName: string | null;
  type: 'credit' | 'loan' | null;
  institution: InstitutionSummary | null;
  /** Owed now, positive; null when you can't see it. */
  owedMinor: number | null;
  /** What the bank says, when it does. */
  bank: { aprBps: number | null; minimumMinor: number | null; nextDueDate: string | null } | null;
  /** What's been entered on the goal. */
  entered: { aprBps: number | null; minimumMinor: number | null };
  /** What counts: the entered value, else the bank's. */
  aprBps: number | null;
  minimumMinor: number | null;
}

/**
 * A pay-down goal's status (walkthrough §8): `done` once nothing's owed, and with a date,
 * `on_track` or `at_risk` by when its minimum and its plan pay it off. Interest counts.
 */
export function debtPace(g: {
  owedMinor: number;
  aprBps: number | null;
  minimumMinor: number;
  planMinor: number | null;
  targetDate: string | null;
  thisMonth: string;
}): GoalPace {
  if (g.owedMinor <= 0) return { status: 'done', projectedMonth: null, monthsLate: null };
  const projected = payoff(
    [
      {
        id: 'debt',
        owedMinor: g.owedMinor,
        aprBps: g.aprBps,
        minimumMinor: g.minimumMinor,
        extraMinor: g.planMinor ?? 0,
      },
    ],
    'planned',
    g.thisMonth,
  ).debtFreeMonth;
  if (!g.targetDate) return { status: null, projectedMonth: projected, monthsLate: null };
  if (projected === null) return { status: 'at_risk', projectedMonth: null, monthsLate: null };
  const late = Math.max(0, monthIndex(projected) - monthIndex(g.targetDate.slice(0, 7)));
  return { status: late ? 'at_risk' : 'on_track', projectedMonth: projected, monthsLate: late };
}

export interface Goal {
  id: string;
  scope: GoalScope;
  kind: GoalKind;
  name: string;
  targetMinor: number;
  targetDate: string | null;
  planMinor: number | null;
  /** Priority: 0 comes first, and gives way last (G19). */
  position: number;
  /** The claims added up (G2); for a debt, how far it's come down from its target (G9). */
  progressMinor: number;
  /** What its accounts with fixed claims on it fall short by (G3). */
  shortMinor: number;
  /** A month's amount that reaches the target by its date, from this month; null without one. */
  toMakeDateMinor: number | null;
  done: boolean;
  pace: GoalPace;
  /** An icon and color, or null for the default; a photo, when it has one, shows instead. */
  icon: GoalIconName | null;
  color: string | null;
  /** Changes when the photo does, for its URL; null without one. */
  imageVersion: string | null;
  /** Put away (archived): its claims ended, and progress is what it had then. */
  archivedAt: string | null;
  claims: GoalClaim[];
  /** The loan or card a pay-down goal is on; null for saving up. */
  debt: GoalDebt | null;
  /** Whether you can change it (GOAL-03, GOAL-04); claims are changed by account owners. */
  canEdit: boolean;
  version: number;
  createdAt: string;
}

/** An account you own that a savings goal can draw on, and how much of it is free. */
export interface GoalAccount {
  accountId: string;
  name: string;
  type: 'depository' | 'investment';
  balanceMinor: number;
  /** Every goal's claims on it, yours or not (G3). */
  claimedMinor: number;
  unclaimedMinor: number;
}

/** A loan or card you see the balance of, for Pay down's Manage (G9). */
export interface DebtAccount {
  accountId: string;
  name: string;
  type: 'credit' | 'loan';
  institution: InstitutionSummary | null;
  owedMinor: number;
  aprBps: number | null;
  minimumMinor: number | null;
  /** Private: only an own (Mine) goal can be on it, as everyone sees the household's. */
  private: boolean;
  /** The goal you see on it, when there is one (archived ones aside). */
  goalId: string | null;
}

/** An account below its fixed claims (G3), as someone who sees its goals sees it. */
export interface GoalShortfall {
  accountId: string;
  accountName: string | null;
  shortMinor: number;
  /** Its fixed claims on goals you see, lowest priority first. */
  goals: { goalId: string; name: string; amountMinor: number }[];
  /** What priority suggests taking from which goal (G19). */
  suggestion: { goalId: string; amountMinor: number }[];
  /** Whether you can choose: you own the account. */
  canResolve: boolean;
}

export interface GoalsOverview {
  /** In priority order; archived ones aren't here. */
  goals: Goal[];
  /** Put away, newest first. */
  archived: Goal[];
  /** Accounts you own that goals can draw on. */
  accounts: GoalAccount[];
  /** Loans and cards you see, to pay down. */
  debts: DebtAccount[];
  shortfalls: GoalShortfall[];
  totals: {
    /** What saving-up goals have. */
    savedMinor: number;
    /** Saving-up goals' monthly plans. */
    plannedMinor: number;
    /** What pay-down goals still owe, where you see it. */
    owedMinor: number;
    /** Unclaimed money in the accounts you own. */
    unclaimedMinor: number;
  };
  /** Whether you can create goals: not a viewer. */
  canCreate: boolean;
}
