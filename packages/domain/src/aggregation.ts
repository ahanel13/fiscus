// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bank aggregation providers (ADR 0004, #78): the one interface Plaid and SimpleFIN both sit
 * behind (bank connections walkthrough D1). Adapters live in `@fiscus/aggregation`, and every one
 * must pass its conformance suite.
 *
 * Everything here is in Fiscus's terms: amounts in minor units with Fiscus's sign (positive =
 * money in, negative = money out; data model §1), dates as `YYYY-MM-DD`, and timestamps as ISO
 * 8601. Adapters translate; nothing past them sees a provider's own conventions.
 */

/** A provider's stored access (a Plaid access token, a SimpleFIN access URL). Never logged. */
export type ProviderSecret = string;

/** What a provider can do, so callers don't branch on its id (Plaid and SimpleFIN in comments). */
export interface ProviderCapabilities {
  /** Sync returns changes since a cursor (`delta` pages). Plaid yes, SimpleFIN no. */
  cursorSync: boolean;
  /** Posted transactions name the pending transaction they replace. Plaid yes, SimpleFIN no. */
  pendingLinks: boolean;
  /** A broken sign-in can be fixed from Fiscus (Plaid Link's update mode). Plaid yes, SimpleFIN no. */
  updateModeReauth: boolean;
  /** The provider can push change notices (ADR 0008). Plaid yes, SimpleFIN no. */
  webhooks: boolean;
  /** `liabilities()` is available. Plaid yes, SimpleFIN no. */
  liabilities: boolean;
  /** The shortest gap between refreshes, in ms. Plaid 15 minutes, SimpleFIN 6 hours (D10). */
  minRefreshMs: number;
  /** How far back history can go, in days. Plaid 730, SimpleFIN about 90 (D6). */
  maxHistoryDays: number;
}

/** The account types a provider reports, a subset of Fiscus's own. */
export type ProviderAccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'other';

export interface ProviderAccount {
  providerAccountId: string;
  name: string;
  officialName?: string;
  type: ProviderAccountType;
  /** The provider's finer type (`checking`, `savings`, `credit card`), as text. */
  subtype?: string;
  /** ISO 4217. */
  currency: string;
  /** The last 4 digits, used to suggest linking to an account already in Fiscus (D5). */
  mask?: string;
  /** Closed at the bank: offered as "Don't track" when connecting. */
  closed?: boolean;
}

/** An account's balance, in Fiscus's sign: what a card or loan is owed is negative. */
export interface ProviderBalance {
  providerAccountId: string;
  currency: string;
  currentMinor: number;
  availableMinor?: number;
  creditLimitMinor?: number;
  /** When the provider last had it from the bank (stale balances show their date, D12). */
  asOf: string;
}

export interface ProviderTransaction {
  /** Unique per account at the provider; the upsert key (data model §5). */
  providerTransactionId: string;
  providerAccountId: string;
  /** Minor units in **Fiscus's sign**: negative = money out. Plaid's sign is the opposite. */
  amountMinor: number;
  currency: string;
  pending: boolean;
  /** On a posted transaction: the pending one it replaces, so edits carry over (D8). */
  pendingTransactionId?: string;
  /** Absent while pending. */
  postedDate?: string;
  authorizedDate: string;
  /** As the bank reports it. Untrusted text (ADR 0009). */
  description: string;
  merchantName?: string;
  /** The original amount when the bank converted a foreign purchase (€42.00 on a USD card). */
  foreignAmountMinor?: number;
  foreignCurrency?: string;
}

export interface ProviderRemovedTransaction {
  providerTransactionId: string;
  providerAccountId: string;
}

export type ProviderLiabilityKind = 'credit' | 'student' | 'mortgage';

/** Statement and loan details (Plaid's `/liabilities/get`). */
export interface ProviderLiability {
  providerAccountId: string;
  kind: ProviderLiabilityKind;
  currency: string;
  /** Annual rate in basis points (24.99% = 2499). */
  aprBps?: number;
  /** In Fiscus's sign: what was owed is negative. */
  lastStatementBalanceMinor?: number;
  lastStatementDate?: string;
  /** The amount due, as a positive number. */
  minimumPaymentMinor?: number;
  nextPaymentDueDate?: string;
}

/** The dates a `window` page covers in full, and for which accounts. */
export interface SyncWindow {
  from: string;
  to: string;
  /**
   * The accounts the window covers. An account the bank didn't return this time is not in the
   * list, and its transactions must be kept, not dropped.
   */
  providerAccountIds: string[];
}

export interface SyncRequest {
  /** The `nextCursor` of the last page applied, or null for the first sync. */
  cursor: string | null;
  /** The earliest date wanted (D6). Providers without a cursor ask for it every time. */
  since?: string;
  /**
   * The household's IANA time zone, for providers that report instants rather than dates
   * (SimpleFIN): a transaction's date is the day it happened there. Defaults to UTC.
   */
  timeZone?: string;
}

/** An account the provider couldn't update this time, and its code (SimpleFIN's `errlist`). */
export interface ProviderAccountError {
  providerAccountId: string;
  /** The provider's code, safe to store (`act.auth`). Never its message. */
  code: string;
}

/**
 * One page of changes.
 *
 * - `delta`: `added`, `modified` and `removed` are changes since the cursor. Apply them in order.
 * - `window`: "this is everything in `window`": `added` holds every transaction dated in it, for
 *   the accounts it lists, and `modified` and `removed` are empty. Ingest drops the provider's
 *   rows in the window that weren't returned (SimpleFIN never reports removals).
 *
 * `hasMore` means another page follows from `nextCursor` now. A delta page always has a
 * `nextCursor`, to store once the page is applied; a window page may have none.
 */
export interface SyncPage {
  mode: 'delta' | 'window';
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: ProviderRemovedTransaction[];
  window?: SyncWindow;
  accounts?: ProviderAccount[];
  balances?: ProviderBalance[];
  nextCursor: string | null;
  hasMore: boolean;
  /** All the history the provider will send has arrived (Plaid's `HISTORICAL_UPDATE`). */
  historicalComplete?: boolean;
  /**
   * Accounts the provider reported a problem with. They're left out of `window`, so what they
   * had is kept, and their connection can say which need attention at the provider (D12).
   */
  accountErrors?: ProviderAccountError[];
}

export interface AggregationProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  listAccounts(secret: ProviderSecret): Promise<ProviderAccount[]>;
  sync(secret: ProviderSecret, request: SyncRequest): Promise<SyncPage>;
  /** Asks the provider to fetch from the bank now ("Refresh now"); a later sync sees the result. */
  refresh?(secret: ProviderSecret): Promise<void>;
  /** Present when `capabilities.liabilities`. */
  liabilities?(secret: ProviderSecret): Promise<ProviderLiability[]>;
  /** Ends the connection at the provider (Plaid's `/item/remove`, D14). */
  remove(secret: ProviderSecret): Promise<void>;
  /** A bank's name, logo and color, for providers that have them (#423); needs no connection. */
  institution?(providerInstitutionId: string): Promise<ProviderInstitution>;
}

export interface ProviderInstitution {
  providerInstitutionId?: string;
  name: string;
  url?: string;
  /** The bank's logo, a PNG, when the provider has one (#423). */
  logoPng?: Uint8Array;
  /** The bank's color, `#RRGGBB`, when the provider has one. */
  color?: string;
}

/** What connecting a bank produces, for the connections table and the choose-accounts step. */
export interface ProviderConnection {
  providerItemId: string;
  secret: ProviderSecret;
  institution: ProviderInstitution;
  accounts: ProviderAccount[];
}

/**
 * Connecting is per provider, outside `AggregationProvider`: Plaid Link's public token and a
 * SimpleFIN setup token have too little in common to share a method.
 */
export interface ProviderConnectFlow<Input> {
  readonly providerId: string;
  connect(input: Input): Promise<ProviderConnection>;
}

export const PROVIDER_ERROR_KINDS = [
  'login_required',
  'consent_expired',
  'rate_limited',
  'institution_down',
  'invalid_credentials',
  'mutation_during_pagination',
  'transient',
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export interface ProviderErrorOptions {
  /** The provider's own code (`ITEM_LOGIN_REQUIRED`), safe to log and store. */
  providerCode: string;
  retryAfterMs?: number;
  /** The provider's id for the request (Plaid's `request_id`), safe to log, for its support. */
  providerRequestId?: string;
  /** The provider's message. Untrusted display text: never logged. */
  providerMessage?: string;
}

/**
 * What every adapter throws for a provider failure. `message` holds only the kind and code;
 * the provider's own message is kept apart, out of `message` and out of JSON, so logging the
 * error can't log it.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerCode: string;
  readonly retryAfterMs?: number;
  readonly providerRequestId?: string;
  declare readonly providerMessage?: string;

  constructor(kind: ProviderErrorKind, options: ProviderErrorOptions) {
    super(`Provider error: ${kind} (${options.providerCode})`);
    this.name = 'ProviderError';
    this.kind = kind;
    this.providerCode = options.providerCode;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.providerRequestId !== undefined) {
      this.providerRequestId = options.providerRequestId;
    }
    Object.defineProperty(this, 'providerMessage', {
      value: options.providerMessage,
      enumerable: false,
    });
  }
}

export const isProviderError = (error: unknown): error is ProviderError =>
  error instanceof ProviderError;
