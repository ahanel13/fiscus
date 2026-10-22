// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AccountType } from './api/accounts.js';

// Finding the account a statement or a bank's account already is in Fiscus: used by OFX import
// (#74) and by connecting a bank (#79, the bank connections walkthrough §3, D5).

/** An account in Fiscus that something could be matched to. Pass only the caller's own. */
export interface MatchCandidate {
  id: string;
  name: string;
  type: AccountType;
  mask: string | null;
  currency: string | null;
  closedAt: string | null;
}

/** What is being matched: a statement's account, or a bank's. */
export interface MatchWanted {
  /** Names it could have in Fiscus, compared ignoring case and surrounding spaces. */
  names: string[];
  type: AccountType;
  /** The last 4 digits, when known. */
  mask: string | null;
  currency: string | null;
}

export interface AccountMatch {
  accountId: string;
  by: 'mask' | 'name';
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * For each wanted account, one of the candidates with the same last 4 digits and the same type,
 * else one with one of its names, else null. Each candidate is matched once at most, in order,
 * and never across currencies; an open account is preferred to a closed one.
 */
export function matchAccounts(
  wanted: MatchWanted[],
  candidates: MatchCandidate[],
): (AccountMatch | null)[] {
  // An open account first; a closed one only when no open one matches.
  const sorted = [...candidates].sort((a, b) => Number(!!a.closedAt) - Number(!!b.closedAt));
  const taken = new Set<string>();
  return wanted.map((w) => {
    const fits = (c: MatchCandidate) =>
      !taken.has(c.id) && (!w.currency || !c.currency || c.currency === w.currency);
    const byMask = w.mask
      ? sorted.find((c) => fits(c) && c.mask === w.mask && c.type === w.type)
      : undefined;
    const names = new Set(w.names.map(lower).filter(Boolean));
    const byName = byMask ? undefined : sorted.find((c) => fits(c) && names.has(lower(c.name)));
    const match = byMask ?? byName;
    if (!match) return null;
    taken.add(match.id);
    return { accountId: match.id, by: byMask ? 'mask' : 'name' };
  });
}
