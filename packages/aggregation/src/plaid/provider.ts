// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isProviderError,
  type AggregationProvider,
  type ProviderAccount,
  type ProviderCapabilities,
  type ProviderLiability,
  type ProviderSecret,
  type ProviderTransaction,
  type SyncPage,
  type SyncRequest,
} from '@fiscus/domain';
import { ProviderUnavailableError, type ConnectionRef, type ProviderSource } from '../registry.js';
import { PlaidClient } from './client.js';
import type { PlaidInstanceConfig } from './config.js';
import { credentialsChanged, resolvePlaidCredentials } from './credentials.js';
import {
  hasLiabilityAccounts,
  plaidLiabilities,
  plaidProviderAccount,
  plaidProviderBalance,
  plaidProviderTransaction,
  plaidRemovedTransaction,
} from './mapping.js';

/** The id stored on a Plaid connection (`connections.provider`). */
export const PLAID_PROVIDER_ID = 'plaid';

export const PLAID_CAPABILITIES: ProviderCapabilities = {
  cursorSync: true,
  pendingLinks: true,
  updateModeReauth: true,
  webhooks: true,
  liabilities: true,
  minRefreshMs: 15 * 60_000,
  maxHistoryDays: 730,
};

/** Plaid's maximum page size (TXN-011): fewer round trips, and fewer mutations mid-pagination. */
export const PLAID_SYNC_COUNT = 500;

/**
 * What `/liabilities/get` answers when an Item has nothing it covers, or wasn't consented for it:
 * no details, rather than a failed sync. NO_LIABILITY_ACCOUNTS: no card or loan it supports
 * (LIAB-008). PRODUCTS_NOT_SUPPORTED: the bank doesn't offer it. ADDITIONAL_CONSENT_REQUIRED: an
 * Item linked before liabilities were in `additional_consented_products`. INVALID_PRODUCT: the
 * Plaid team has no access to it.
 */
const NO_LIABILITIES = new Set([
  'NO_LIABILITY_ACCOUNTS',
  'PRODUCTS_NOT_SUPPORTED',
  'ADDITIONAL_CONSENT_REQUIRED',
  'INVALID_PRODUCT',
]);

export interface PlaidProviderOptions {
  /** For balances whose bank gives no time; defaults to the system clock. */
  now?: () => Date;
}

/**
 * Plaid behind `AggregationProvider` (#82), for one set of keys: the client it's given. The secret
 * is the Item's access token; it's passed to the client and never kept, logged or put in an error.
 *
 * - `sync` is one `/transactions/sync` page (TXN-001), `count` 500 (TXN-011), with the bank's own
 *   description and the personal finance category taxonomy pinned to v2 (TXN-006, TXN-013). The
 *   sync loop buffers pages to `has_more: false` and restarts on mutation (TXN-002, TXN-007).
 *   The terminal page carries the accounts and balances from `/accounts/get`, the authoritative
 *   list (TXN-012), at no extra charge. `transactions_update_status` of
 *   `HISTORICAL_UPDATE_COMPLETE` is `historicalComplete` (TXN-008); an empty first sync is normal.
 * - `liabilities` calls `/liabilities/get` only when the Item has a card or loan (LIAB-008).
 * - `remove` is `/item/remove` (ITEM-005); an Item already gone at Plaid counts as removed.
 * - No `refresh`: `/transactions/refresh` is a separately billed add-on (TXN-010).
 */
export class PlaidProvider implements AggregationProvider {
  readonly id = PLAID_PROVIDER_ID;
  readonly capabilities = PLAID_CAPABILITIES;
  readonly #client: PlaidClient;
  readonly #now: () => Date;

  constructor(client: PlaidClient, options: PlaidProviderOptions = {}) {
    this.#client = client;
    this.#now = options.now ?? (() => new Date());
  }

  async listAccounts(secret: ProviderSecret): Promise<ProviderAccount[]> {
    const { accounts } = await this.#client.accountsGet(secret);
    return accounts.flatMap((a) => plaidProviderAccount(a) ?? []);
  }

  async sync(secret: ProviderSecret, request: SyncRequest): Promise<SyncPage> {
    const response = await this.#client.transactionsSync(secret, {
      cursor: request.cursor,
      count: PLAID_SYNC_COUNT,
      options: { include_original_description: true, personal_finance_category_version: 'v2' },
    });
    const transactions = (list: typeof response.added): ProviderTransaction[] =>
      list.flatMap((t) => plaidProviderTransaction(t) ?? []);
    const page: SyncPage = {
      mode: 'delta',
      added: transactions(response.added),
      modified: transactions(response.modified),
      removed: response.removed.flatMap((r) => plaidRemovedTransaction(r) ?? []),
      // Plaid's cursor is empty while it has nothing yet (TXN-008): stay where we were.
      nextCursor: response.next_cursor || request.cursor,
      hasMore: response.has_more,
    };
    if (response.transactions_update_status === 'HISTORICAL_UPDATE_COMPLETE') {
      page.historicalComplete = true;
    }
    if (!response.has_more) {
      const { accounts } = await this.#client.accountsGet(secret);
      const now = this.#now();
      page.accounts = accounts.flatMap((a) => plaidProviderAccount(a) ?? []);
      page.balances = accounts.flatMap((a) => plaidProviderBalance(a, now) ?? []);
    }
    return page;
  }

  async liabilities(secret: ProviderSecret): Promise<ProviderLiability[]> {
    const { accounts } = await this.#client.accountsGet(secret);
    if (!hasLiabilityAccounts(accounts)) return [];
    try {
      return plaidLiabilities(await this.#client.liabilitiesGet(secret));
    } catch (error) {
      if (isProviderError(error) && NO_LIABILITIES.has(error.providerCode)) return [];
      throw error;
    }
  }

  async remove(secret: ProviderSecret): Promise<void> {
    try {
      await this.#client.itemRemove(secret);
    } catch (error) {
      // Already removed or revoked at Plaid: there's nothing left to end (ITEM-005).
      if (isProviderError(error) && error.providerCode === 'ITEM_NOT_FOUND') return;
      throw error;
    }
  }
}

export interface PlaidProviderSourceOptions extends PlaidProviderOptions {
  /** Per Plaid request. A first sync after the history arrives can be slow (TXN-024). */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

/**
 * Plaid for each connection, with the keys it was made with (ADR 0008 §Credentials 4): the
 * server's when its `credential_set_id` is null, else the household's set the caller passes
 * (#83). A server without keys has none, and a connection recorded with another client id or
 * environment than its keys is `credentials_changed` ("reconnect"); a rotated secret is the same
 * Plaid account, and keeps working. One provider per set of keys.
 */
export function plaidProviderSource(
  instance: PlaidInstanceConfig | undefined,
  options: PlaidProviderSourceOptions = {},
): ProviderSource {
  const providers = new Map<string, PlaidProvider>();
  return {
    id: PLAID_PROVIDER_ID,
    forConnection(connection: ConnectionRef): AggregationProvider {
      const resolved = resolvePlaidCredentials(
        connection.credentialSetId,
        instance,
        connection.householdKeys,
      );
      if (!resolved.available) {
        throw new ProviderUnavailableError(PLAID_PROVIDER_ID, resolved.reason);
      }
      const { credentials } = resolved;
      if (
        connection.providerEnv !== null &&
        connection.providerClientId !== null &&
        credentialsChanged(
          { providerEnv: connection.providerEnv, providerClientId: connection.providerClientId },
          credentials,
        )
      ) {
        throw new ProviderUnavailableError(PLAID_PROVIDER_ID, 'credentials_changed');
      }
      // The secret too: a household's rotated secret is a new client, not the cached one.
      const key = `${credentials.env}\u0000${credentials.clientId}\u0000${credentials.secret}`;
      let provider = providers.get(key);
      if (!provider) {
        provider = new PlaidProvider(
          new PlaidClient({
            ...credentials,
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }),
          options.now ? { now: options.now } : {},
        );
        providers.set(key, provider);
      }
      return provider;
    },
  };
}
