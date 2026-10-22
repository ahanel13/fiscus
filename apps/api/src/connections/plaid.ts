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
 * Transactions is the one product a bank must support, so Link hides no bank that has it. Card
 * and loan details (#86) and investments are consented at Link but billed only once called, so a
 * later feature needs no second consent. Investments isn't read yet.
 */
export const LINK_PRODUCTS = ['transactions'];
export const LINK_CONSENTED_PRODUCTS = ['liabilities', 'investments'];

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
      if (err.providerCode === 'INVALID_ACCESS_TOKEN' || err.providerCode === 'ITEM_NOT_FOUND') {
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

// Plaid's accounts in Fiscus's terms live in `@fiscus/aggregation`, shared with the worker's sync
// (#82): Plaid's type (anything new is `other`), the current balance in Fiscus's sign and minor
// units (null without one, or without an ISO currency), and the last 4 of the mask.
export { plaidAccountType, plaidCurrentBalance, plaidMask } from '@fiscus/aggregation';

/** A name an account may have (1 to 120 characters), from the bank's. */
export const accountNameFrom = (account: PlaidAccount): string =>
  (account.name.trim() || account.official_name?.trim() || 'Bank account').slice(0, 120);
