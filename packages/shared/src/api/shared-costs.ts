// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { minorUnitsSchema } from './accounts.js';

// Shared costs: split rules (ADR 0006 §7, budgeting walkthrough §9, #109).

/** A month, as the first of it: `YYYY-MM-01`. */
export const monthStartSchema = z.iso
  .date()
  .refine((d) => d.endsWith('-01'), 'The first of a month');

const memberShares = z
  .array(z.object({ memberId: z.uuid(), shareBps: z.number().int().min(1).max(10000) }))
  .min(2)
  .max(20)
  .refine((s) => new Set(s.map((x) => x.memberId)).size === s.length, 'Each member once')
  .refine((s) => s.reduce((sum, x) => sum + x.shareBps, 0) === 10000, 'Shares must add up to 100%');

/**
 * How a shared expense is split between the people it's for.
 * - `equal`: the same share each.
 * - `fixed_percent`: each member's share, adding up to 100%. For an expense that's for only some
 *   of them, their shares are scaled to add up to 100% between them.
 * - `fixed_amount`: some members pay a fixed amount a month for the category; whatever's left is
 *   split equally between the others ("You $400 · Sam the rest").
 *
 * Split by income (`income_proportional`) comes with members' consent (#110).
 */
export const splitRuleSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('equal') }),
  z.object({ method: z.literal('fixed_percent'), shares: memberShares }),
  z.object({
    method: z.literal('fixed_amount'),
    amounts: z
      .array(z.object({ memberId: z.uuid(), amountMinor: minorUnitsSchema.min(1) }))
      .min(1)
      .max(19)
      .refine((s) => new Set(s.map((x) => x.memberId)).size === s.length, 'Each member once'),
  }),
]);
export type SplitRule = z.infer<typeof splitRuleSchema>;
export type SplitMethod = SplitRule['method'] | 'income_proportional';

/** Sets the household's default from a month on. */
export const setDefaultSplitSchema = z.object({
  rule: splitRuleSchema,
  effectiveFrom: monthStartSchema,
});

/** Sets a category's rule from a month on; `rule: null` goes back to the household's default. */
export const setCategorySplitSchema = z.object({
  rule: splitRuleSchema.nullable(),
  effectiveFrom: monthStartSchema,
});

/** One row of the household's split rules: what applies from `effectiveFrom` on. */
export interface SplitPolicy {
  id: string;
  /** Null for the household's default. */
  categoryId: string | null;
  effectiveFrom: string;
  /** Null: the category goes back to the household's default. */
  rule: SplitRule | null;
  createdByMemberId: string;
}

export interface SplitPolicies {
  /** The first month a change can start from: this one, in the household's time zone. */
  earliestMonth: string;
  /** Every rule, oldest first: what applies now, what applied before, and what's scheduled. */
  policies: SplitPolicy[];
}

/** One shared expense in a month's statement (walkthrough §8). */
export interface SharedExpenseLine {
  transactionId: string;
  date: string;
  displayName: string;
  categoryId: string | null;
  /** What it cost, positive (a refund is negative). */
  costMinor: number;
  /** Who paid: the account's owners on its date, as people (F1). */
  paidBy: string[];
  /** Who it's for. */
  forMembers: string[];
  /** Its effect from your side, per person: positive, they owe you; negative, you owe them. */
  effect: { memberId: string; amountMinor: number }[];
}

/** Where you stand with each person you share costs with (#111, D17). */
export interface SharedCosts {
  month: string;
  currency: string;
  /** Your balance with each person at the end of `month`: positive, they owe you. */
  balances: { memberId: string; amountMinor: number }[];
  /** The same, carried in from the months before. */
  carried: { memberId: string; amountMinor: number }[];
  /** The month's shared expenses that you're part of, newest first. */
  expenses: SharedExpenseLine[];
  /** Settle-ups between you and others this month, newest first (#112). */
  settlements: Settlement[];
  /** Shared spending you can see this month, and how much of it evens out. */
  sharedSpendingMinor: number;
  evensOutMinor: number;
}

/** A settle-up between you and someone else (#112, D20). */
export interface Settlement {
  id: string;
  date: string;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  /** `transfer`: a transfer in Fiscus paid it; `paid`: paid another way; `adjustment`. */
  kind: 'transfer' | 'paid' | 'adjustment';
  transactionId: string | null;
  note: string | null;
}

/**
 * Records a settle-up between you and `memberId`. `direction` is from your side: `they_paid` (they
 * paid you) or `you_paid`. A `transfer` names the transaction in your account that paid it.
 */
export const recordSettlementSchema = z
  .object({
    memberId: z.uuid(),
    direction: z.enum(['they_paid', 'you_paid']),
    amountMinor: minorUnitsSchema.min(1),
    date: z.iso.date(),
    kind: z.enum(['transfer', 'paid', 'adjustment']),
    transactionId: z.uuid().optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine((s) => (s.kind === 'transfer') === (s.transactionId !== undefined), {
    message: 'A transfer names its transaction; other kinds don’t',
    path: ['transactionId'],
  })
  .refine((s) => s.kind !== 'adjustment' || s.note !== undefined, {
    message: 'Say what the adjustment is for',
    path: ['note'],
  });

/** A transfer that could be a settle-up with someone: in your account, close to the balance. */
export interface SettlementCandidate {
  transactionId: string;
  date: string;
  displayName: string;
  accountName: string;
  /** Positive: money in (they paid you); negative: money out (you paid them). */
  amountMinor: number;
}
