// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PlaidEnvironment, PlaidInstanceConfig } from './config.js';

/** The keys one connection's Plaid calls use. The secret is never logged or stored with it. */
export interface PlaidCredentials {
  clientId: string;
  secret: string;
  env: PlaidEnvironment;
  /** The test-only override (sandbox only; the client ignores it otherwise). */
  apiBaseUrl?: string;
}

/**
 * A household's own Plaid keys (ADR 0008 §Credentials 2, #83), decrypted by whoever read them
 * from `aggregation_credentials` for this one use. Never logged, stored elsewhere, or returned.
 */
export interface PlaidCredentialSet {
  clientId: string;
  secret: string;
  env: PlaidEnvironment;
}

export type PlaidCredentialsResult =
  | { available: true; credentials: PlaidCredentials }
  | {
      available: false;
      /**
       * `not_configured`: the connection uses the server's keys and there are none.
       * `household_keys_unavailable`: it uses a household's own keys, and they weren't given
       * (removed, or unreadable).
       */
      reason: 'not_configured' | 'household_keys_unavailable';
    };

/**
 * The keys for a connection (ADR 0008 §Credentials 4): resolved per connection everywhere, for
 * the link token, the exchange, sync, webhook verification and update mode, never once per
 * process. `credentialSetId` is the connection's `credential_set_id`: null means the server's own
 * keys; otherwise `household` is that set, read and decrypted by the caller. The test-only base
 * URL override applies to a household's sandbox keys too, and never to production.
 */
export function resolvePlaidCredentials(
  credentialSetId: string | null,
  instance: PlaidInstanceConfig | undefined,
  household?: PlaidCredentialSet | null,
): PlaidCredentialsResult {
  if (credentialSetId !== null) {
    if (!household) return { available: false, reason: 'household_keys_unavailable' };
    const credentials: PlaidCredentials = { ...household };
    if (household.env === 'sandbox' && instance?.apiBaseUrl !== undefined) {
      credentials.apiBaseUrl = instance.apiBaseUrl;
    }
    return { available: true, credentials };
  }
  if (!instance) return { available: false, reason: 'not_configured' };
  const credentials: PlaidCredentials = {
    clientId: instance.clientId,
    secret: instance.secret,
    env: instance.env,
  };
  if (instance.apiBaseUrl !== undefined) credentials.apiBaseUrl = instance.apiBaseUrl;
  return { available: true, credentials };
}

/** What a connection records about the keys it was made with: never the secret. */
export interface ConnectionCredentialStamp {
  providerEnv: string;
  providerClientId: string;
}

/** The non-secret fields to record on a new connection (`provider_env`, `provider_client_id`). */
export const credentialStamp = (credentials: PlaidCredentials): ConnectionCredentialStamp => ({
  providerEnv: credentials.env,
  providerClientId: credentials.clientId,
});

/**
 * A connection made with another client id or environment can't be used with the current keys:
 * a Plaid Item belongs to one Plaid account and environment (ADR 0008 §Credentials 4), so the
 * connection is marked `error` with `credentials_changed` and shows "reconnect". A rotated
 * secret is the same account, so it isn't a change.
 */
export const credentialsChanged = (
  connection: ConnectionCredentialStamp,
  current: Pick<PlaidCredentials, 'clientId' | 'env'>,
): boolean =>
  connection.providerEnv !== current.env || connection.providerClientId !== current.clientId;
