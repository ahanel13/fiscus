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
    /** Matches the bank's description or the transaction's name, ignoring case and spacing. */
    description: textMatchSchema.optional(),
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
  .refine((c) => Object.keys(c).length > 0, 'Add at least one condition');
export type RuleConditions = z.infer<typeof ruleConditionsSchema>;

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

export const createRuleSchema = z.object({
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
 * Whether every condition holds. `uncategorizedId` is the system "Uncategorized" category, which
 * counts as no category.
 */
export function ruleMatches(
  c: RuleConditions,
  t: RuleSubject,
  uncategorizedId: string | null = null,
): boolean {
  if (c.description) {
    const hit =
      textMatches(c.description, t.originalDescription) ||
      textMatches(c.description, t.displayName);
    if (!hit) return false;
  }
  const size = Math.abs(t.amountMinor);
  if (c.amount?.min !== undefined && size < c.amount.min) return false;
  if (c.amount?.max !== undefined && size > c.amount.max) return false;
  if (c.direction === 'in' && t.amountMinor <= 0) return false;
  if (c.direction === 'out' && t.amountMinor >= 0) return false;
  if (c.accountIds && !c.accountIds.includes(t.accountId)) return false;
  if (c.categoryId !== undefined) {
    const current = t.categoryId === uncategorizedId ? null : t.categoryId;
    if (current !== c.categoryId) return false;
  }
  return true;
}
