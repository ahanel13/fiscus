// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CategoryGroup, HouseholdMember, Transaction } from '@fiscus/shared';
import { ownerLabel } from './accounts.js';

/** Who a transaction is for, from the viewer's side: "Mine", "Ours", "Bea's" (ADR 0006 naming). */
export function forLabel(
  t: Pick<Transaction, 'attribution'>,
  members: Pick<HouseholdMember, 'id' | 'displayName' | 'isYou'>[],
): string {
  return ownerLabel({ owners: t.attribution }, members);
}

/** "Paid by Ada" for purchases shared with you from an account you can't see (F1). */
export function paidByLabel(
  t: Pick<Transaction, 'paidBy'>,
  members: Pick<HouseholdMember, 'id' | 'displayName' | 'isYou'>[],
): string {
  const names = t.paidBy.map(
    (id) => members.find((m) => m.id === id)?.displayName ?? 'a former member',
  );
  return `Paid by ${names.join(' & ')}`;
}

/** Category id → name, and the system "uncategorized" id. */
export function categoryIndex(groups: CategoryGroup[] | undefined) {
  const names = new Map<string, string>();
  let uncategorized: string | undefined;
  for (const g of groups ?? []) {
    for (const c of g.categories) {
      names.set(c.id, c.name);
      if (c.systemKey === 'uncategorized') uncategorized = c.id;
    }
  }
  return { names, uncategorized };
}

/** Groups transactions by day, keeping the server's newest-first order. */
export function byDay<T extends Pick<Transaction, 'date'>>(items: T[]): [string, T[]][] {
  const days = new Map<string, T[]>();
  for (const t of items) days.set(t.date, [...(days.get(t.date) ?? []), t]);
  return [...days];
}
