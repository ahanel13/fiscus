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
