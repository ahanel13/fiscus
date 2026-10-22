// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import {
  type AccountType,
  type AccountVisibility,
  accountVisibilitySchema,
  setOwnersSchema,
} from './accounts.js';

// Bank connections (#78, the bank connections walkthrough §7). A connection is listed for its
// owner and for anyone who sees one of its accounts (ACC-02); its secret never leaves the server.

export type ConnectionProvider = 'plaid' | 'simplefin';
/** `setup`: owners and visibility not confirmed yet, so only its owner sees it (D4). */
export type ConnectionStatus = 'setup' | 'ok' | 'login_required' | 'error' | 'disconnected';

export interface Connection {
  id: string;
  provider: ConnectionProvider;
  status: ConnectionStatus;
  institutionName: string | null;
  /** Who linked it: the one who fixes or disconnects it (ACC-03, D11). */
  owner: { memberId: string; name: string };
  /** The accounts it syncs that you can see. */
  accountCount: number;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
}

// Connecting a bank through Plaid Link (#79, the walkthrough §2–§3, D2, D4–D6).

/** `POST /households/:id/plaid/link-token`: what the browser opens Plaid Link with. */
export interface PlaidLinkToken {
  linkToken: string;
  expiration: string;
}

/** `POST /households/:id/plaid/exchange`: the `public_token` Link handed the browser. */
export const plaidExchangeSchema = z.object({ publicToken: z.string().trim().min(1).max(500) });

/** What each account the bank offers is suggested to become (the walkthrough §3). */
export type ConnectSuggestion =
  /** One of your accounts, by its last 4 digits and type, or by name. Its history stays (D5). */
  | { choice: 'link'; accountId: string; by: 'mask' | 'name' }
  /** A new account, owned by you, with the household's default visibility (D4, ADR 0006 §8). */
  | { choice: 'new'; owners: { memberId: string }[]; visibility: AccountVisibility }
  /** Not tracked: it matches one of your accounts that you closed. */
  | { choice: 'skip'; reason: 'closed'; accountId: string };

/** An account the bank offers, from Plaid's `/accounts/get` (never Link's metadata). */
export interface OfferedAccount {
  providerAccountId: string;
  name: string;
  officialName: string | null;
  type: AccountType;
  subtype: string | null;
  /** The last 4 digits, as the bank shows them. */
  mask: string | null;
  currency: string;
  /** The bank's current balance, in Fiscus's sign (what a card owes is negative). */
  balance: { amountMinor: number; currency: string } | null;
  suggestion: ConnectSuggestion;
}

/** A connection being set up: only its owner sees it until they confirm (D4). */
export interface ConnectionSetup {
  connectionId: string;
  institutionName: string | null;
  accounts: OfferedAccount[];
}

const providerAccountId = z.string().min(1).max(200);

/** One choice per offered account (`POST /households/:id/connections/:id/confirm`). */
export const accountChoiceSchema = z.discriminatedUnion('choice', [
  z.object({ providerAccountId, choice: z.literal('link'), accountId: z.uuid() }),
  z.object({
    providerAccountId,
    choice: z.literal('new'),
    /** Defaults to the bank's name for it. */
    name: z.string().trim().min(1).max(120).optional(),
    /** Defaults to you alone (ACC-01). */
    owners: setOwnersSchema.shape.owners.optional(),
    /** Defaults to the household's finance style (ADR 0006 §8). */
    visibility: accountVisibilitySchema.optional(),
  }),
  z.object({ providerAccountId, choice: z.literal('skip') }),
]);
export type AccountChoiceInput = z.infer<typeof accountChoiceSchema>;

export const confirmConnectionSchema = z.object({
  accounts: z
    .array(accountChoiceSchema)
    .min(1)
    .max(100)
    .refine(
      (a) => new Set(a.map((c) => c.providerAccountId)).size === a.length,
      'One choice per account',
    ),
});

/** What confirming did: the accounts it tracks, linked or new. The first sync starts now. */
export interface ConnectionConfirmed {
  connectionId: string;
  accounts: { providerAccountId: string; accountId: string; linked: boolean; syncFrom: string }[];
}
