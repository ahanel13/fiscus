// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CategoryGroup, Rule, RuleActions, RuleConditions } from '@fiscus/shared';
import { formatMoney, ruleMatches } from '@fiscus/shared';

// Rules in words, for the list and the editor (docs/design/imports.md §3).

const OPS = { contains: 'contains', equals: 'is', starts_with: 'starts with' } as const;

/** "Description contains “trader joe” · money out · over $40.00" */
export function describeConditions(
  c: RuleConditions,
  names: { accounts: Map<string, string>; categories: Map<string, string> },
  currency: string,
): string {
  const parts: string[] = [];
  if (c.description) parts.push(`Description ${OPS[c.description.op]} “${c.description.value}”`);
  if (c.direction) parts.push(c.direction === 'in' ? 'money in' : 'money out');
  const money = (m: number) => formatMoney(m, currency);
  if (c.amount) {
    const { min, max } = c.amount;
    parts.push(
      min !== undefined && max !== undefined
        ? min === max
          ? `amount ${money(min)}`
          : `between ${money(min)} and ${money(max)}`
        : min !== undefined
          ? `${money(min)} or more`
          : `up to ${money(max!)}`,
    );
  }
  if (c.accountIds) {
    parts.push(
      `in ${c.accountIds.map((id) => names.accounts.get(id) ?? 'an account').join(' or ')}`,
    );
  }
  if (c.categoryId !== undefined) {
    parts.push(
      c.categoryId === null
        ? 'uncategorized'
        : `in ${names.categories.get(c.categoryId) ?? 'a category'}`,
    );
  }
  return parts.join(' · ');
}

/** "Rename to “Trader Joe’s” · Groceries · tag Food · mark reviewed" */
export function describeActions(
  a: RuleActions,
  names: {
    categories: Map<string, string>;
    tags: Map<string, string>;
    members: Map<string, string>;
  },
): string {
  const parts: string[] = [];
  if (a.rename) parts.push(`rename to “${a.rename}”`);
  if (a.categoryId) parts.push(names.categories.get(a.categoryId) ?? 'a category');
  if (a.addTagIds) {
    parts.push(`tag ${a.addTagIds.map((id) => names.tags.get(id) ?? 'a tag').join(', ')}`);
  }
  if (a.attribution) {
    parts.push(
      `for ${a.attribution.map((x) => names.members.get(x.memberId) ?? 'someone').join(' and ')}`,
    );
  }
  if (a.markReviewed) parts.push('mark reviewed');
  if (a.exclude) parts.push('exclude from reports');
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const categoryNames = (groups: CategoryGroup[]) =>
  new Map(groups.flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)));

/** Card processors put their name before the merchant's: "SQ *BLUE BOTTLE", "TST* SHAKE SHACK". */
const PROCESSOR =
  /^(sq|tst|sp|pp|paypal|gglpay|google|apl|apple pay|py|in|dd|bt|ck|wpy|pos)\s?\*\s?/i;

const STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(
    ' ',
  ),
);

/**
 * The part of a bank description that names the merchant, to match others from it: processor
 * prefix and store numbers removed, a trailing state dropped, at most three words
 * ("TRADER JOE S #123 SALT LAKE" → "TRADER JOE", "SQ *BLUE BOTTLE" → "BLUE BOTTLE").
 */
export function suggestMatchText(description: string): string {
  const words = description.trim().replace(PROCESSOR, '').replace(/\*/g, ' ').trim().split(/\s+/);
  let i = 0;
  while (i < words.length - 1 && /\d/.test(words[i]!)) i++; // "9640 AMC"
  const kept: string[] = [];
  for (const w of words.slice(i)) {
    if (/[\d#]/.test(w)) break;
    kept.push(w);
  }
  while (kept.length > 1 && STATES.has(kept.at(-1)!)) kept.pop();
  while (kept.length > 1 && kept.at(-1)!.length === 1) kept.pop(); // "EBAY O"
  const out = kept.slice(0, 3);
  return (out.length ? out : words.slice(0, 2)).join(' ');
}

/** Descriptions you asked not to be offered rules for, kept per member (a preference). */
export const MUTED_KEY = 'rules:muted';

export interface SuggestedRule {
  matchText: string;
  conditions: RuleConditions;
  actions: RuleActions;
}

/**
 * After you rename or recategorize a transaction: a rule that would do the same for others with
 * that description, unless one already does or you muted the description.
 */
export function suggestRule(
  t: { originalDescription: string; accountId: string | null; amountMinor: number },
  change: { displayName?: string; categoryId?: string | null },
  rules: Rule[],
  muted: string[],
  uncategorizedId: string | null,
): SuggestedRule | null {
  const matchText = suggestMatchText(t.originalDescription);
  if (!matchText || muted.some((m) => m.toLowerCase() === matchText.toLowerCase())) return null;
  const actions: RuleActions = {};
  if (change.displayName && change.displayName.trim() !== t.originalDescription.trim()) {
    actions.rename = change.displayName.trim();
  }
  if (change.categoryId && change.categoryId !== uncategorizedId) {
    actions.categoryId = change.categoryId;
  }
  if (Object.keys(actions).length === 0) return null;
  // An enabled rule that matches this transaction and already does all of it: nothing to add.
  const subject = {
    displayName: t.originalDescription,
    originalDescription: t.originalDescription,
    amountMinor: t.amountMinor,
    accountId: t.accountId ?? '',
    categoryId: null,
  };
  const covered = rules.some(
    (r) =>
      r.enabled &&
      ruleMatches(r.conditions, subject, uncategorizedId) &&
      (!actions.rename || r.actions.rename === actions.rename) &&
      (!actions.categoryId || r.actions.categoryId === actions.categoryId),
  );
  if (covered) return null;
  return {
    matchText,
    conditions: { description: { op: 'contains', value: matchText } },
    actions,
  };
}
