// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { isoDateSchema } from './accounts.js';

// Goals (#131; goals walkthrough, goals and budgets G1–G22). Money in minor units of the
// household's currency.

/** Whose goal: the household's, or your own (G15). Viewer-relative, as for budgets. */
export const goalScopeSchema = z.enum(['household', 'mine']);
export type GoalScope = z.infer<typeof goalScopeSchema>;

const money = z.number().int().min(1).max(1_000_000_000_00);

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
  claims: z
    .array(goalClaimSchema.and(z.object({ accountId: z.uuid() })))
    .max(20)
    .refine((c) => new Set(c.map((x) => x.accountId)).size === c.length, 'Each account once')
    .default([]),
});

export const updateGoalSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    targetMinor: money,
    targetDate: isoDateSchema.nullable(),
    planMinor: z.number().int().min(0).max(1_000_000_000_00).nullable(),
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
}

export interface Goal {
  id: string;
  scope: GoalScope;
  kind: 'save';
  name: string;
  targetMinor: number;
  targetDate: string | null;
  planMinor: number | null;
  /** Priority: 0 comes first, and gives way last (G19). */
  position: number;
  /** The claims added up (G2). */
  progressMinor: number;
  /** What its accounts with fixed claims on it fall short by (G3). */
  shortMinor: number;
  /** A month's amount that reaches the target by its date, from this month; null without one. */
  toMakeDateMinor: number | null;
  done: boolean;
  claims: GoalClaim[];
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
  goals: Goal[];
  /** Accounts you own that goals can draw on. */
  accounts: GoalAccount[];
  shortfalls: GoalShortfall[];
  totals: {
    savedMinor: number;
    plannedMinor: number;
    /** Unclaimed money in the accounts you own. */
    unclaimedMinor: number;
  };
  /** Whether you can create goals: not a viewer. */
  canCreate: boolean;
}
