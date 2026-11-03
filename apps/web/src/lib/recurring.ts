// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HouseholdMember, RecurringKind, StatementPaid } from '@fiscus/shared';

// Bills & recurring (#121, #122): who looks after what, and how far a card statement is paid.

/** Their names, in words: "Alex", "Alex and Sam". Members who've left are left out. */
export const namesOf = (ids: readonly string[], members: readonly HouseholdMember[]) =>
  ids
    .map((id) => members.find((m) => m.id === id)?.displayName)
    .filter((n): n is string => !!n)
    .join(' and ');

/** What the avatars on a row say: who looks after it, who it's for, or whose card it is. */
export function whoLabel(kind: RecurringKind | 'statement', names: string): string {
  if (kind === 'income') return `For ${names}`;
  if (kind === 'statement') return `${names}’s card`;
  return `${names} looks after it`;
}

/** A card statement's badge (D9): paid, minimum paid, or partly paid. */
export function statementBadge(paid: StatementPaid | undefined): string | null {
  if (paid === 'paid') return 'Paid';
  if (paid === 'minimum') return 'Minimum paid';
  if (paid === 'part') return 'Partly paid';
  return null;
}
