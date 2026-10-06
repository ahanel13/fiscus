// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  AccountType,
  AccountVisibility,
  Household,
  HouseholdMember,
} from '@fiscus/shared';

// Account wording and grouping (design §8, ADR 0006 naming: viewer-relative, gender-neutral).

export const TYPE_LABELS: Record<AccountType, string> = {
  depository: 'Cash (checking, savings)',
  credit: 'Credit card',
  loan: 'Loan or mortgage',
  investment: 'Investment',
  property: 'Property',
  vehicle: 'Vehicle',
  crypto: 'Crypto',
  other: 'Other asset',
};

export const GROUPS: { id: string; label: string; types: AccountType[] }[] = [
  { id: 'cash', label: 'Cash', types: ['depository'] },
  { id: 'credit', label: 'Credit cards', types: ['credit'] },
  { id: 'loans', label: 'Loans', types: ['loan'] },
  { id: 'investments', label: 'Investments', types: ['investment', 'crypto'] },
  { id: 'property', label: 'Property and vehicles', types: ['property', 'vehicle'] },
  { id: 'other', label: 'Other', types: ['other'] },
];

export const VISIBILITY: Record<AccountVisibility, { label: string; description: string }> = {
  full: {
    label: 'Shared',
    description: 'Everyone in the household sees it and can categorize its transactions.',
  },
  view_only: {
    label: 'View only',
    description: 'Others see its balance and transactions, but can’t change anything.',
  },
  balance_only: {
    label: 'Balance only',
    description: 'Others see the balance and its part of net worth, but no transactions.',
  },
  private: {
    label: 'Private',
    description: 'Only its owners see it. It’s left out of everyone else’s totals.',
  },
};

/** New-account default per finance style; mirrors the API (ADR 0006 §8). */
export const DEFAULT_VISIBILITY: Record<Household['financeStyle'], AccountVisibility> = {
  combined: 'full',
  hybrid: 'full',
  separate: 'view_only',
  roommates: 'private',
};

/** "Mine", "Bea's", "Ours", or "Bea & Cal's", from the viewer's point of view. */
export function ownerLabel(
  account: Pick<Account, 'owners'>,
  members: Pick<HouseholdMember, 'id' | 'displayName' | 'isYou'>[],
): string {
  const owners = account.owners
    .map((o) => members.find((m) => m.id === o.memberId))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  if (owners.some((m) => m.isYou)) return owners.length === 1 ? 'Mine' : 'Ours';
  if (owners.length === 0) return 'Shared';
  const names = owners.map((m) => m.displayName);
  const joined =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
  return `${joined}’s`;
}

/** A joint account can't be private when the household has exactly two members (F2). */
export function privateAllowed(ownerCount: number, activeMembers: number): boolean {
  return !(ownerCount >= 2 && activeMembers === 2);
}

/** Liabilities (credit, loans) are usually entered as what you owe; store them as negatives. */
export const isLiability = (type: AccountType) => type === 'credit' || type === 'loan';

/** How a balance is shown: liabilities without alarm, cash overdrafts in red (style guide §4). */
export const balanceKind = (type: AccountType) => (isLiability(type) ? 'liability' : 'balance');

/** Trend values from the first day with data, so a new account doesn't look like a windfall. */
export function trend(values: number[]): number[] {
  const first = values.findIndex((v) => v !== 0);
  return first < 0 ? [] : values.slice(first);
}
