// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CategoryGroup, RuleActions, RuleConditions } from '@fiscus/shared';
import { formatMoney } from '@fiscus/shared';

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
