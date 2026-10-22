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

// The last 4 digits written at the end of a name, as exports and imports often do: "SOFI
// (...8884)", "Visa (…0963)", "Checking ••4410", "Savings x2124", "Card ending in 1234". A marker
// is needed without brackets, so "Roth IRA 2024" isn't read as one.
const MARKER = String.raw`(?:\.{2,}|…|•+|\*+|x+|#|ending in)`;
const IN_BRACKETS = new RegExp(String.raw`\s*[(\[]\s*(?:${MARKER}\s*)?([0-9]{4})\s*[)\]]\s*$`, 'i');
const AFTER_MARKER = new RegExp(String.raw`\s*${MARKER}\s*([0-9]{4})\s*$`, 'i');

/** The last 4 digits a name ends with ("SOFI (...8884)" → "8884"), or null. */
export function maskInName(name: string): string | null {
  return (IN_BRACKETS.exec(name) ?? AFTER_MARKER.exec(name))?.[1] ?? null;
}

/** A name without the last 4 digits it ends with ("SOFI (...8884)" → "SOFI"). */
export const nameWithoutMask = (name: string): string =>
  name.replace(IN_BRACKETS, '').replace(AFTER_MARKER, '').trim() || name.trim();

/**
 * For each wanted account, one of the candidates with the same last 4 digits and the same type
 * (a candidate without them may have them at the end of its name), else one with one of its
 * names, compared without such last 4s, else null. Each candidate is matched once at most, in order,
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
    // Its last 4, or else the ones written in its name.
    const byMask = w.mask
      ? sorted.find(
          (c) => fits(c) && (c.mask ?? maskInName(c.name)) === w.mask && c.type === w.type,
        )
      : undefined;
    const names = new Set(w.names.map(lower).filter(Boolean));
    // By name: the same name, or, for one of the same type, the same once the last 4 its name
    // ends with are left out ("SOFI (...8884)" is "SOFI"). Never two accounts whose last 4 say
    // they're different ones.
    const byName = byMask
      ? undefined
      : sorted.find((c) => {
          if (!fits(c)) return false;
          const cMask = c.mask ?? maskInName(c.name);
          if (w.mask && cMask && cMask !== w.mask) return false;
          return (
            names.has(lower(c.name)) ||
            (c.type === w.type && names.has(lower(nameWithoutMask(c.name))))
          );
        });
    const match = byMask ?? byName;
    if (!match) return null;
    taken.add(match.id);
    return { accountId: match.id, by: byMask ? 'mask' : 'name' };
  });
}
