// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  AccountLayout,
  AccountLayoutInput,
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

// ── Your arrangement of the accounts list (#48) ────────────────────────────────────────────────

/** A section of the Accounts page: one of your groups, or a type's section. */
export interface Section {
  key: string;
  label: string;
  /** Set for your own groups; null for the type sections. */
  groupId: string | null;
  accounts: Account[];
}

/**
 * The Accounts page's sections: your groups first, in your order, then each type's section with
 * the rest, in the order the api returns them (yours, then the household's). Empty sections are
 * left out, except your groups while you arrange them.
 */
export function buildSections(
  accounts: Account[],
  layout: AccountLayout | undefined,
  { keepEmptyGroups = false } = {},
): Section[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const grouped = new Set<string>();
  const groups = (layout?.groups ?? []).map((g) => {
    const items = g.accountIds.flatMap((id) => byId.get(id) ?? []);
    for (const a of items) grouped.add(a.id);
    return { key: `group:${g.id}`, label: g.name, groupId: g.id, accounts: items };
  });
  const types = GROUPS.map((t) => ({
    key: `type:${t.id}`,
    label: t.label,
    groupId: null,
    accounts: accounts.filter((a) => !grouped.has(a.id) && t.types.includes(a.type)),
  }));
  return [...groups.filter((g) => keepEmptyGroups || g.accounts.length), ...types].filter(
    (s) => s.groupId !== null || s.accounts.length,
  );
}

/** The type section an account goes back to when it leaves a group. */
export const typeSectionKey = (account: Account) =>
  `type:${GROUPS.find((g) => g.types.includes(account.type))!.id}`;

/** A section's total: its balances summed, liabilities negative, as net worth counts them. */
export function sectionTotal(section: Section) {
  return {
    minor: section.accounts.reduce((sum, a) => sum + (a.balance?.amountMinor ?? 0), 0),
    kind: section.accounts.every((a) => isLiability(a.type))
      ? ('liability' as const)
      : ('balance' as const),
  };
}

/**
 * The layout to save for these sections. Accounts placed somewhere but not on the page (closed,
 * or outside the lens) keep their place; the api keeps those hidden from you on its own.
 */
export function layoutFrom(
  sections: Section[],
  previous: AccountLayout | undefined,
  newGroup?: string,
): AccountLayoutInput {
  const shown = new Set(sections.flatMap((s) => s.accounts.map((a) => a.id)));
  const offPage = (ids: string[]) => ids.filter((id) => !shown.has(id));
  const before = new Map((previous?.groups ?? []).map((g) => [g.id, g.accountIds]));
  const groups: AccountLayoutInput['groups'] = sections.flatMap((s) =>
    s.groupId === null
      ? []
      : [
          {
            id: s.groupId,
            name: s.label,
            accountIds: [...s.accounts.map((a) => a.id), ...offPage(before.get(s.groupId) ?? [])],
          },
        ],
  );
  if (newGroup) groups.push({ name: newGroup, accountIds: [] });
  // Groups deleted here hand their off-page accounts back to the type sections.
  const kept = new Set(groups.flatMap((g) => (g.id ? [g.id] : [])));
  const released = (previous?.groups ?? [])
    .filter((g) => !kept.has(g.id))
    .flatMap((g) => offPage(g.accountIds));
  return {
    groups,
    ungrouped: [
      ...sections.filter((s) => s.groupId === null).flatMap((s) => s.accounts.map((a) => a.id)),
      ...offPage(previous?.ungrouped ?? []),
      ...released,
    ],
  };
}

/** Moves an account up or down within its section. */
export function moveWithin(sections: Section[], accountId: string, by: -1 | 1): Section[] {
  return sections.map((s) => {
    const i = s.accounts.findIndex((a) => a.id === accountId);
    const j = i + by;
    if (i < 0 || j < 0 || j >= s.accounts.length) return s;
    const accounts = [...s.accounts];
    [accounts[i], accounts[j]] = [accounts[j]!, accounts[i]!];
    return { ...s, accounts };
  });
}

/** Moves an account to the end of another section: one of your groups, or its type's section. */
export function moveTo(sections: Section[], accountId: string, key: string): Section[] {
  const account = sections.flatMap((s) => s.accounts).find((a) => a.id === accountId);
  if (!account) return sections;
  const target = key.startsWith('type:') ? typeSectionKey(account) : key;
  const next = sections.map((s) => ({
    ...s,
    accounts: s.accounts.filter((a) => a.id !== accountId),
  }));
  const at = next.find((s) => s.key === target);
  if (at) at.accounts.push(account);
  else {
    const label = GROUPS.find((g) => `type:${g.id}` === target)?.label ?? '';
    next.push({ key: target, label, groupId: null, accounts: [account] });
  }
  return next;
}

/** Moves one of your groups up or down among your groups. */
export function moveGroup(sections: Section[], groupId: string, by: -1 | 1): Section[] {
  const groups = sections.filter((s) => s.groupId !== null);
  const i = groups.findIndex((s) => s.groupId === groupId);
  const j = i + by;
  if (i < 0 || j < 0 || j >= groups.length) return sections;
  [groups[i], groups[j]] = [groups[j]!, groups[i]!];
  return [...groups, ...sections.filter((s) => s.groupId === null)];
}

/** Renames one of your groups. */
export const renameGroup = (sections: Section[], groupId: string, label: string) =>
  sections.map((s) => (s.groupId === groupId ? { ...s, label } : s));

/** Deletes one of your groups; its accounts go back to their type's sections. */
export function deleteGroup(sections: Section[], groupId: string): Section[] {
  const group = sections.find((s) => s.groupId === groupId);
  return (group?.accounts ?? [])
    .reduce((next, a) => moveTo(next, a.id, typeSectionKey(a)), sections)
    .filter((s) => s.groupId !== groupId);
}
