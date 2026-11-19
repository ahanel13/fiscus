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
 * - `income_proportional`: in proportion to their incomes (F4, #110). It counts for an expense
 *   only once everyone it's for has agreed (`IncomeSplit`); until then, the household default
 *   applies, or an equal split for the default itself.
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
  z.object({ method: z.literal('income_proportional') }),
]);
export type SplitRule = z.infer<typeof splitRuleSchema>;
export type SplitMethod = SplitRule['method'];

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

/**
 * Agreeing to a split by income (F4, #110, walkthrough D19), from today: with a monthly figure you
 * enter, or with your actual income, the income attributed to you over the 3 months before each
 * month. Nobody else sees either, only the split it makes.
 */
export const incomeSplitConsentSchema = z.discriminatedUnion('basis', [
  z.object({ basis: z.literal('declared'), declaredMonthlyMinor: minorUnitsSchema.min(0) }),
  z.object({ basis: z.literal('actual') }),
]);
export type IncomeSplitConsent = z.infer<typeof incomeSplitConsentSchema>;

/** Where a split by income stands today (F4, #110). */
export interface IncomeSplit {
  /** Today, in the household's time zone: consent counts from the day it's given. */
  today: string;
  /** Each current member who isn't a viewer, and whether they've agreed. Never their income. */
  members: { memberId: string; consented: boolean }[];
  /**
   * Today's split between those who've agreed, in basis points; empty when nobody has. It counts
   * for an expense only when everyone it's for is in it.
   */
  shares: { memberId: string; shareBps: number }[];
  /** Your own consent: the income you chose. Null when you haven't agreed. */
  yours: IncomeSplitConsent | null;
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
  /**
   * Shared expenses whose attribution is flagged (#60, D18), from any month: left out of
   * `balances` and `carried` until the paying account's owners resolve them. Newest first.
   */
  disputed: (SharedExpenseLine & { flag: AttributionFlag })[];
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

/** An open flag on who a transaction is for (#60, ADR 0006 F6). */
export interface AttributionFlag {
  id: string;
  flaggedByMemberId: string;
  note: string | null;
  createdAt: string;
}

/** A transaction's flag, and what you may do about it (ATT-03, ATT-04). */
export interface AttributionFlagStatus {
  flag: AttributionFlag | null;
  /** You're involved (attributed before or after the last change) and it isn't flagged. */
  canFlag: boolean;
  /** You own the paying account, or raised the flag (to withdraw it). */
  canResolve: boolean;
  /** Who last changed who it's for, when you can see that change. */
  changedByMemberId: string | null;
}

export const flagAttributionSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
});

// Joint-account funding targets (ADR 0006 §7.3, #113).

export const FUNDING_CADENCES = ['weekly', 'every_two_weeks', 'monthly'] as const;
export type FundingCadence = (typeof FUNDING_CADENCES)[number];

export const FUNDING_CADENCE_LABELS: Record<FundingCadence, string> = {
  weekly: 'a week',
  every_two_weeks: 'every two weeks',
  monthly: 'a month',
};

/**
 * Sets what a member moves into a joint account each period. Only a fixed amount for now: a
 * share of income (`percent_of_income`) would show others that member's income, so it waits for
 * their consent (#110, F4). `startsOn` defaults to the start of this period; a monthly target
 * starts on the first of a month.
 */
export const setFundingTargetSchema = z
  .object({
    method: z.literal('fixed'),
    amountMinor: minorUnitsSchema.min(1),
    cadence: z.enum(FUNDING_CADENCES),
    startsOn: z.iso.date().optional(),
  })
  .strict()
  .refine((t) => t.cadence !== 'monthly' || !t.startsOn || t.startsOn.endsWith('-01'), {
    message: 'A monthly target starts on the first of a month',
    path: ['startsOn'],
  });
export type SetFundingTarget = z.infer<typeof setFundingTargetSchema>;

/** `not_started`: its first period hasn't begun. */
export type FundingStatus = 'on_track' | 'behind' | 'ahead' | 'not_started';

export interface FundingPeriodProgress {
  from: string;
  to: string;
  targetMinor: number;
  contributedMinor: number;
}

/** One member's target for a joint account, and how it's going. */
export interface FundingTarget {
  id: string;
  accountId: string;
  memberId: string;
  method: 'fixed';
  amountMinor: number;
  cadence: FundingCadence;
  startsOn: string;
  status: FundingStatus;
  /** Moved in from their own accounts since it started. */
  contributedMinor: number;
  /** Behind: short of what was due by now. Ahead: over what's due by the end of this period. */
  differenceMinor: number;
  /** Still to move in this period, catching up included. */
  leftThisPeriodMinor: number;
  /** The period today is in; null before it starts. */
  current: FundingPeriodProgress | null;
  /** The latest periods, newest first, this one included. */
  recent: FundingPeriodProgress[];
  setByMemberId: string;
}

/** A joint account you own, its owners, and the targets for funding it. */
export interface FundingAccount {
  accountId: string;
  accountName: string;
  currency: string;
  ownerIds: string[];
  targets: FundingTarget[];
}

export interface FundingTargets {
  /** Today, in the household's time zone. */
  today: string;
  /** Joint accounts you own, by name. */
  accounts: FundingAccount[];
}
