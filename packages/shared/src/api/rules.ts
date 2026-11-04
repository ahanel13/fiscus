// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { minorUnitsSchema } from './accounts.js';
import { attributionSchema } from './ledger.js';

// Rules: conditions → actions on transactions as they arrive (docs/design/imports.md §3, #41,
// permissions RULE-01–07). The matcher is here so the web app can show what a rule matches.

const textMatchSchema = z.object({
  op: z.enum(['contains', 'equals', 'starts_with']),
  value: z.string().trim().min(1).max(200),
});

export const ruleConditionsSchema = z
  .object({
    /** Whether every condition must hold (and), or any one of them (or). Every, by default. */
    match: z.enum(['all', 'any']).optional(),
    /** Matches the bank's description or the transaction's name, ignoring case and spacing. */
    description: textMatchSchema.optional(),
    /** Several description checks, each one condition. Rules saved before these have `description`. */
    descriptions: z.array(textMatchSchema).min(1).max(20).optional(),
    /** Size of the amount, either direction, in minor units: equals is min = max. */
    amount: z
      .object({ min: minorUnitsSchema.min(0).optional(), max: minorUnitsSchema.min(0).optional() })
      .refine((a) => a.min !== undefined || a.max !== undefined, 'Give a minimum or a maximum')
      .refine(
        (a) => a.min === undefined || a.max === undefined || a.min <= a.max,
        'Minimum is above maximum',
      )
      .optional(),
    direction: z.enum(['in', 'out']).optional(),
    accountIds: z.array(z.uuid()).min(1).max(50).optional(),
    /** The current category; null = uncategorized. */
    categoryId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((c) => Object.keys(c).some((k) => k !== 'match'), 'Add at least one condition')
  .refine((c) => !(c.description && c.descriptions), 'Give description or descriptions, not both');
export type RuleConditions = z.infer<typeof ruleConditionsSchema>;
export type RuleTextMatch = z.infer<typeof textMatchSchema>;

/** A rule's description checks, whichever way it was saved. */
export const descriptionChecks = (c: RuleConditions): RuleTextMatch[] =>
  c.descriptions ?? (c.description ? [c.description] : []);

/** How far apart the two sides of a rule's transfer may be, unless the rule says otherwise. */
export const TRANSFER_RULE_DEFAULT_DAYS = 5;

export const ruleActionsSchema = z
  .object({
    rename: z.string().trim().min(1).max(200).optional(),
    categoryId: z.uuid().optional(),
    addTagIds: z.array(z.uuid()).min(1).max(20).optional(),
    /** Who it's for (ATT-01): needs the author to own the account. */
    attribution: attributionSchema.optional(),
    markReviewed: z.literal(true).optional(),
    /** Leave out of reports and budgets: needs the author to own the account. */
    exclude: z.literal(true).optional(),
    /**
     * A transfer to this account (transfers.md §3): links to its other side there, within
     * `withinDays` either way, or waits that long for it. Needs the author to own both accounts.
     */
    transferTo: z
      .object({
        accountId: z.uuid(),
        withinDays: z.number().int().min(1).max(31).default(TRANSFER_RULE_DEFAULT_DAYS),
        /** No other side there yet: record it (manual accounts that follow their transactions). */
        recordIfMissing: z.boolean().default(false),
      })
      .optional(),
  })
  .strict()
  .refine((a) => Object.keys(a).length > 0, 'Add at least one action');
export type RuleActions = z.infer<typeof ruleActionsSchema>;

const ruleName = z.string().trim().min(1).max(80);

/**
 * Whose rule it is (#58): the household's, which everyone sees, or yours, which only you see and
 * which runs on the accounts you own, after the household's. Chosen when it's created.
 */
export const ruleScopeSchema = z.enum(['household', 'mine']);
export type RuleScope = z.infer<typeof ruleScopeSchema>;

export const createRuleSchema = z.object({
  scope: ruleScopeSchema.default('household'),
  name: ruleName.optional(),
  enabled: z.boolean().optional(),
  conditions: ruleConditionsSchema,
  actions: ruleActionsSchema,
});
export const updateRuleSchema = z
  .object({
    name: ruleName.nullable(),
    enabled: z.boolean(),
    conditions: ruleConditionsSchema,
    actions: ruleActionsSchema,
  })
  .partial()
  .strict();
export const reorderRulesSchema = z.object({ ids: z.array(z.uuid()).min(1).max(1000) });

export interface Rule {
  id: string;
  /** Listing returns the household's rules and yours, never another member's (RULE-02). */
  scope: RuleScope;
  name: string | null;
  position: number;
  enabled: boolean;
  conditions: RuleConditions;
  actions: RuleActions;
  /** Whose access it acts with: its author, or whoever last edited it (RULE-05). */
  authorMemberId: string;
  /** The author left: the rule doesn't run until someone edits it (RULE-07). */
  authorLeft: boolean;
  version: number;
  updatedAt: string;
}

/** A change a rule would make (preview) or made (apply). */
export interface RuleChange {
  transactionId: string;
  date: string;
  amountMinor: number;
  currency: string;
  displayName: string;
  /** Field → [before, after]. Tags list only the ones added. */
  changes: Partial<{
    displayName: [string, string];
    categoryId: [string | null, string];
    tagIds: [string[], string[]];
    attribution: [string[], string[]];
    reviewStatus: [string, 'reviewed'];
    excluded: [boolean, true];
    /**
     * Linked to its other side in that account, its other side recorded there, or waiting for
     * it to arrive.
     */
    transfer: [null, { accountId: string; outcome: 'link' | 'record' | 'wait' }];
  }>;
}

export interface RulePreview {
  /** Every transaction the rule would change, of those you can see. */
  total: number;
  /** The first 200. */
  changes: RuleChange[];
}

/** The parts of a transaction rules look at. */
export interface RuleSubject {
  displayName: string;
  originalDescription: string;
  amountMinor: number;
  accountId: string;
  categoryId: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const textMatches = (m: z.infer<typeof textMatchSchema>, text: string) => {
  const t = norm(text);
  const v = norm(m.value);
  return m.op === 'equals' ? t === v : m.op === 'starts_with' ? t.startsWith(v) : t.includes(v);
};

/**
 * Whether the conditions hold: every one, or any one with `match: 'any'`. Each description check
 * is a condition. `uncategorizedId` is the system "Uncategorized" category, which counts as no
 * category.
 */
export function ruleMatches(
  c: RuleConditions,
  t: RuleSubject,
  uncategorizedId: string | null = null,
): boolean {
  const checks: (() => boolean)[] = descriptionChecks(c).map(
    (d) => () => textMatches(d, t.originalDescription) || textMatches(d, t.displayName),
  );
  const size = Math.abs(t.amountMinor);
  if (c.amount) {
    const { min, max } = c.amount;
    checks.push(() => (min === undefined || size >= min) && (max === undefined || size <= max));
  }
  if (c.direction) {
    const direction = c.direction;
    checks.push(() => (direction === 'in' ? t.amountMinor > 0 : t.amountMinor < 0));
  }
  if (c.accountIds) {
    const ids = c.accountIds;
    checks.push(() => ids.includes(t.accountId));
  }
  if (c.categoryId !== undefined) {
    const want = c.categoryId;
    checks.push(() => (t.categoryId === uncategorizedId ? null : t.categoryId) === want);
  }
  return c.match === 'any' ? checks.some((f) => f()) : checks.every((f) => f());
}
