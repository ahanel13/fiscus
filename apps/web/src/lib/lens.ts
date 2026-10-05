// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Household, HouseholdMember } from '@fiscus/shared';

export type Lens = 'all' | 'me' | 'shared' | `member:${string}`;

export interface LensOption {
  value: Lens;
  label: string;
}

/**
 * The lens answers "whose money am I looking at?" (ADR 0006 §5). It's hidden when there is no
 * choice to make: single-member households and the Combined style (everything is "ours").
 */
export function lensVisible(
  household: Pick<Household, 'financeStyle'>,
  memberCount: number,
): boolean {
  return memberCount > 1 && household.financeStyle !== 'combined';
}

/** Viewer-relative, name-based labels: Mine · [name] · Ours · All. */
export function lensOptions(
  members: Pick<HouseholdMember, 'id' | 'displayName' | 'isYou'>[],
): LensOption[] {
  return [
    { value: 'me', label: 'Mine' },
    ...members
      .filter((m) => !m.isYou)
      .map((m) => ({ value: `member:${m.id}` as Lens, label: m.displayName })),
    { value: 'shared', label: 'Ours' },
    { value: 'all', label: 'All' },
  ];
}

export const parseLens = (value: unknown): Lens =>
  value === 'me' ||
  value === 'shared' ||
  value === 'all' ||
  (typeof value === 'string' && /^member:[0-9a-f-]{36}$/.test(value))
    ? (value as Lens)
    : 'all';
