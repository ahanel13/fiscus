// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PlaidLinkExit, plaidLinkMetadataSchema } from '@fiscus/shared';
import type {
  PlaidLinkError,
  PlaidLinkOnExitMetadata,
  PlaidLinkOnSuccessMetadata,
} from 'react-plaid-link';
import type { z } from 'zod';

// Plaid Link (#79, D2), through Plaid's react-plaid-link: its script comes from Plaid at runtime,
// and runs only on the connect pages, the only ones whose Content-Security-Policy allows it
// (nginx.conf, threat model T4). They're entered and left with full page loads, so the script
// never outlives them.

/**
 * Where Link comes back to after a bank's own sign-in page (OAuth), on any household: Plaid
 * matches the redirect URI exactly, so it can't carry the household. `PLAID_REDIRECT_URI` is this
 * path on the server's https origin, and is listed in Plaid's dashboard.
 */
export const PLAID_OAUTH_PATH = '/connect/plaid/oauth';

/** What the OAuth return needs to pick Link up where it left off: the same link token. */
export interface PlaidOAuthState {
  linkToken: string;
  householdId: string;
  /** Update mode: the connection being signed in to again. */
  connection?: string;
  savedAt: number;
}

const KEY = 'fiscus.plaid-oauth';
/** A link token lasts 4 hours (30 minutes in update mode): older ones can't resume. */
const MAX_AGE_MS = 4 * 60 * 60_000;

/** Kept before Link opens, since a bank's OAuth page may send the browser away and back. */
export function saveOAuthState(state: Omit<PlaidOAuthState, 'savedAt'>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
  } catch {
    // Storage is off: Link still works, only an OAuth bank's return can't resume.
  }
}

export function readOAuthState(now = Date.now()): PlaidOAuthState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<PlaidOAuthState>;
    if (
      typeof s.linkToken !== 'string' ||
      typeof s.householdId !== 'string' ||
      typeof s.savedAt !== 'number' ||
      now - s.savedAt > MAX_AGE_MS ||
      (s.connection !== undefined && typeof s.connection !== 'string')
    ) {
      clearOAuthState();
      return null;
    }
    return s as PlaidOAuthState;
  } catch {
    return null;
  }
}

/** Once Link finishes or stops: the token is spent. */
export function clearOAuthState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}

type LinkMetadata = z.input<typeof plaidLinkMetadataSchema>;

/** Link's word on what was connected, for the exchange: the session, the bank, the last 4s. */
export const linkMetadata = (m: PlaidLinkOnSuccessMetadata): LinkMetadata => ({
  sessionId: m.link_session_id,
  institutionId: m.institution?.institution_id ?? null,
  accounts: m.accounts.map((a) => ({ mask: a.mask ?? null, subtype: a.subtype ?? null })),
});

/**
 * What's recorded when Link stops: Plaid's codes and its request id, never its messages (they
 * may name the person or the bank, and are for the person, not the server).
 */
export const linkExit = (
  error: PlaidLinkError | null,
  m: PlaidLinkOnExitMetadata,
): PlaidLinkExit | null =>
  m.link_session_id
    ? {
        sessionId: m.link_session_id,
        status: m.status ?? null,
        institutionId: m.institution?.institution_id ?? null,
        errorType: error?.error_type ?? null,
        errorCode: error?.error_code ?? null,
        requestId: m.request_id || null,
      }
    : null;
