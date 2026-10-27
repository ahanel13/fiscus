// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import {
  type AccountType,
  type AccountVisibility,
  accountVisibilitySchema,
  type InstitutionSummary,
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
  /** The bank, with its color and whether it has a logo (#423); null for SimpleFIN. */
  institution: InstitutionSummary | null;
  /** Who linked it: the one who fixes or disconnects it (ACC-03, D11). */
  owner: { memberId: string; name: string };
  /** The accounts it syncs that you can see. */
  accountCount: number;
  /** Their ids, so the accounts it leaves stale can say so (D12). */
  accountIds: string[];
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  /** When the current run of failures began (`error` or `login_required`); null while it works. */
  failingSince: string | null;
  /** Failing for {@link NOT_WORKING_AFTER_MS} or more: it says so, and offers to disconnect. */
  notWorking: boolean;
  /**
   * When its owner may next press "Refresh now" (D10): null = now. Set by the provider's limit
   * ({@link REFRESH_LIMIT_MS}) from the last time it was asked for.
   */
  refreshAvailableAt: string | null;
  /**
   * The bank is still sending older history (Plaid's `HISTORICAL_UPDATE_COMPLETE` hasn't come,
   * TXN-008): a first sync can be empty, or recent only, for a few minutes. Only providers that
   * report it ({@link REPORTS_HISTORY}); a SimpleFIN window is everything at once.
   */
  importingHistory: boolean;
  /**
   * Made with Plaid keys the household no longer connects banks with (a set since replaced, or the
   * server's once it has its own): its owner can connect it again to move it, keeping its accounts
   * and history (#83, D15). It keeps syncing meanwhile.
   */
  onOldKeys: boolean;
}

/** Providers that say when the history they're sending is complete. */
export const REPORTS_HISTORY: Record<ConnectionProvider, boolean> = {
  plaid: true,
  simplefin: false,
};

/** "Refresh now" at most this often, per connection (D10). */
export const REFRESH_LIMIT_MS: Record<ConnectionProvider, number> = {
  // Plaid itself checks banks 1–4 times a day; more often would only re-read what it has.
  plaid: 15 * 60_000,
  // The Bridge refreshes daily and allows about 24 requests a day.
  simplefin: 6 * 60 * 60_000,
};

/** A connection failing this long is "not working" (walkthrough §6). */
export const NOT_WORKING_AFTER_MS = 3 * 24 * 60 * 60_000;

/** The 429 `refresh_too_soon` problem's extension: when "Refresh now" works again. */
export interface RefreshTooSoon {
  availableAt: string;
}

// Connecting a bank through Plaid Link (#79, the walkthrough §2–§3, D2, D4–D6).

/**
 * `GET /households/:id/plaid`: whether the household can connect a bank through Plaid, so "Connect
 * a bank" shows only when it can. The environment lets the connect page say "sandbox" (D17), and
 * `keys` whose Plaid account it goes through (#83).
 */
export type PlaidAvailability =
  | { available: true; env: 'sandbox' | 'production'; keys: 'household' | 'server' }
  | { available: false; reason: 'not_configured' | 'household_keys_unavailable' };

// A household's own Plaid keys (#83, ADR 0008 §Credentials 2–5, D15).

/** `PUT /households/:id/plaid-credentials`: write-only. The secret is never returned. */
export const plaidKeysSchema = z.strictObject({
  clientId: z.string().trim().min(1).max(64),
  secret: z.string().trim().min(1).max(128),
  env: z.enum(['sandbox', 'production']),
});
export type PlaidKeysInput = z.infer<typeof plaidKeysSchema>;

/** `GET /households/:id/plaid-credentials`, for household owners (HH-08). */
export interface HouseholdPlaidKeys {
  /** The server's admin lets households bring their own keys (`plaid.allowHouseholdKeys`). */
  allowed: boolean;
  /** The server has keys of its own, used when the household has none. */
  serverKeys: boolean;
  /** The household's own, as far as they're shown: the client id's last 4 only (HH-08). */
  keys: { clientIdEnding: string; env: 'sandbox' | 'production'; addedAt: string } | null;
  /**
   * Plaid connections you can see, and the keys each was made with: `current` is the household's
   * set now, `server` the server's, `previous` a set since replaced. Any but `current` has to be
   * connected again to move to the household's keys (D15).
   */
  connections: {
    id: string;
    institutionName: string | null;
    owner: { memberId: string; name: string };
    accountCount: number;
    keys: 'current' | 'server' | 'previous';
  }[];
}

// Connecting the SimpleFIN Bridge (#91, D3).

/** `GET /households/:id/simplefin`: whether the server's admin has SimpleFIN on. */
export interface SimpleFinAvailability {
  available: boolean;
}

/**
 * `POST /households/:id/simplefin/connect`: the setup token the Bridge showed, claimed once by
 * the server. Then the same choose step as Plaid's (`ConnectionSetup`).
 */
export const simpleFinConnectSchema = z.object({
  setupToken: z.string().trim().min(1).max(2000),
});

/** `POST /households/:id/plaid/link-token`: what the browser opens Plaid Link with. */
export interface PlaidLinkToken {
  linkToken: string;
  expiration: string;
}

const linkSessionId = z.string().trim().min(1).max(200);
const plaidInstitutionId = z.string().trim().min(1).max(100);
const plaidCode = z.string().trim().min(1).max(100);

/**
 * What Link's metadata says, passed on as is. It's the browser's word: kept for support (Plaid
 * asks for the `link_session_id`) and used to spot a bank that's already connected, but the
 * accounts and the institution Fiscus stores always come from Plaid's api.
 */
export const plaidLinkMetadataSchema = z.object({
  sessionId: linkSessionId,
  institutionId: plaidInstitutionId.nullish(),
  accounts: z
    .array(z.object({ mask: z.string().max(20).nullish(), subtype: z.string().max(60).nullish() }))
    .max(100)
    .default([]),
});

/** `POST /households/:id/plaid/exchange`: the `public_token` Link handed the browser. */
export const plaidExchangeSchema = z.object({
  publicToken: z.string().trim().min(1).max(500),
  link: plaidLinkMetadataSchema.optional(),
  /** Connect it even though you've connected this bank already: a separate login there. */
  duplicateOk: z.boolean().optional(),
  /**
   * One of your connections on old keys that this one moves to the household's keys now (#83,
   * D15): the same bank, whose accounts it's suggested to take over. Confirming ends that one.
   */
  replaces: z.uuid().optional(),
});

/**
 * `POST /households/:id/plaid/link-exit`: Link closed without connecting. Recorded, only for you,
 * so a failed connection can be traced with Plaid's support. Plaid's codes, never its messages.
 */
export const plaidLinkExitSchema = z
  .object({
    sessionId: linkSessionId,
    /** Link's `status`: the step it stopped at. */
    status: plaidCode.nullish(),
    institutionId: plaidInstitutionId.nullish(),
    errorType: plaidCode.nullish(),
    errorCode: plaidCode.nullish(),
    requestId: plaidCode.nullish(),
  })
  .strict();
export type PlaidLinkExit = z.infer<typeof plaidLinkExitSchema>;

/**
 * The 409 `bank_already_connected` problem's extensions: one of your connections already reaches
 * these accounts at this bank. Sign in again there, or finish its setup, rather than paying Plaid
 * for the same accounts twice.
 */
export interface BankAlreadyConnected {
  connectionId: string;
  status: ConnectionStatus;
}

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
  /** The connection this one moves to new keys, ended once this is confirmed (#83); else null. */
  replacesConnectionId: string | null;
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
