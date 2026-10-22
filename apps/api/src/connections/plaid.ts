// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import {
  type PlaidAccount,
  PlaidClient,
  type PlaidCredentials,
  type PlaidCredentialsResult,
  type PlaidInstanceConfig,
} from '@fiscus/aggregation';
import { isProviderError } from '@fiscus/domain';
import { type AccountType, minorUnitExponent } from '@fiscus/shared';
import { Problem } from '../common/problem.js';

// The api's side of Plaid (#79): a client per connection's keys, Plaid's failures as api
// problems, and Plaid's accounts in Fiscus's terms. Nothing here logs: a ProviderError's message
// holds only its kind and code, and Plaid's own message (untrusted text) is never passed on.

/** What every link token asks for (the issue's Decisions; ADR 0008). */
export const LINK_COUNTRY_CODES = ['US', 'CA'];
/** Always 730: it can't be raised once the Item exists. D6's 90 days is applied locally (#80). */
export const LINK_DAYS_REQUESTED = 730;
export const LINK_CLIENT_NAME = 'Fiscus';

/**
 * The `client_user_id` Plaid sees: stable per member, and opaque (not an email or a name, nor
 * the member id itself), as Plaid asks.
 */
export const plaidClientUserId = (memberId: string): string =>
  createHash('sha256').update(`fiscus/plaid-user/${memberId}`).digest('hex').slice(0, 32);

/** A client for these keys, or a 409 saying why Plaid isn't available to the household. */
export function plaidClientFor(result: PlaidCredentialsResult): {
  client: PlaidClient;
  credentials: PlaidCredentials;
} {
  if (!result.available) {
    throw new Problem(
      409,
      'plaid_unavailable',
      'Plaid isn’t available to this household',
      result.reason === 'not_configured'
        ? 'This server has no Plaid keys. Its admin can add them (PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV), or connect with SimpleFIN instead.'
        : 'This household uses its own Plaid keys, which this server can’t use yet.',
    );
  }
  return { client: new PlaidClient(result.credentials), credentials: result.credentials };
}

/** The redirect URI Link is given, only when the server has one (OAuth banks). */
export const linkRedirect = (config: PlaidInstanceConfig | undefined) =>
  config?.redirectUri ? { redirect_uri: config.redirectUri } : {};

/**
 * Plaid's failure as an api problem: its kind and Plaid's code, never Plaid's message (untrusted
 * text, which may name the bank or the person). Anything that isn't a ProviderError is rethrown.
 */
export function plaidProblem(err: unknown): never {
  if (!isProviderError(err)) throw err;
  const ext = { providerCode: err.providerCode };
  switch (err.kind) {
    case 'invalid_credentials':
      if (err.providerCode === 'INVALID_PUBLIC_TOKEN') {
        throw new Problem(
          422,
          'invalid_public_token',
          'This bank sign-in has expired or was already used',
          'Connect the bank again.',
          undefined,
          {},
          ext,
        );
      }
      if (err.providerCode === 'INVALID_ACCESS_TOKEN') {
        throw new Problem(
          409,
          'connection_gone',
          'Plaid no longer has this connection',
          'Disconnect it, then connect the bank again.',
          undefined,
          {},
          ext,
        );
      }
      throw new Problem(
        502,
        'plaid_keys_refused',
        'Plaid refused this server’s keys',
        'The server’s admin needs to check its Plaid keys and environment.',
        undefined,
        {},
        ext,
      );
    case 'login_required':
    case 'consent_expired':
      throw new Problem(
        409,
        'login_required',
        'The bank needs you to sign in again',
        undefined,
        undefined,
        {},
        ext,
      );
    case 'rate_limited': {
      const seconds = Math.max(1, Math.ceil((err.retryAfterMs ?? 60_000) / 1000));
      throw new Problem(
        429,
        'rate_limited',
        'Plaid asked us to slow down',
        'Try again in a minute.',
        undefined,
        { 'retry-after': String(seconds) },
        ext,
      );
    }
    case 'institution_down':
      throw new Problem(
        503,
        'institution_down',
        'The bank isn’t answering right now',
        'Try again later.',
        undefined,
        {},
        ext,
      );
    default:
      throw new Problem(
        502,
        'provider_unavailable',
        'Plaid isn’t answering right now',
        'Try again in a few minutes.',
        undefined,
        {},
        ext,
      );
  }
}

const TYPES: Record<string, AccountType> = {
  depository: 'depository',
  credit: 'credit',
  loan: 'loan',
  investment: 'investment',
  // Plaid's older name for investment accounts.
  brokerage: 'investment',
};

/** Plaid's account type in Fiscus's terms; anything new is `other`. */
export const plaidAccountType = (type: string): AccountType => TYPES[type] ?? 'other';

/**
 * The bank's current balance in Fiscus's sign and minor units: Plaid reports what a card or a loan
 * owes as positive, Fiscus as negative. Null when Plaid has none, or no ISO currency for it.
 */
export function plaidCurrentBalance(
  account: PlaidAccount,
): { amountMinor: number; currency: string } | null {
  const { current, iso_currency_code: currency } = account.balances;
  if (current === null || current === undefined || !currency) return null;
  let exponent: number;
  try {
    exponent = minorUnitExponent(currency);
  } catch {
    return null;
  }
  const type = plaidAccountType(account.type);
  const sign = type === 'credit' || type === 'loan' ? -1 : 1;
  const amountMinor = Math.round(sign * current * 10 ** exponent) || 0;
  return Number.isSafeInteger(amountMinor) ? { amountMinor, currency } : null;
}

/** The last 4 characters of Plaid's mask, when they're what an account's mask may hold. */
export const plaidMask = (mask: string | null | undefined): string | null => {
  const last4 = mask?.trim().slice(-4);
  return last4 && /^[0-9A-Za-z]{4}$/.test(last4) ? last4 : null;
};

/** A name an account may have (1 to 120 characters), from the bank's. */
export const accountNameFrom = (account: PlaidAccount): string =>
  (account.name.trim() || account.official_name?.trim() || 'Bank account').slice(0, 120);
