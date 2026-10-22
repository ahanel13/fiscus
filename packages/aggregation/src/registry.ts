// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AggregationProvider } from '@fiscus/domain';

export class UnknownProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`No aggregation provider is registered as "${providerId}"`);
    this.name = 'UnknownProviderError';
  }
}

/**
 * Why a registered provider can't serve a connection. `not_configured`: this server has no keys
 * for it. `household_keys_unavailable`: the connection uses a household's own keys, which arrive
 * with #83. `credentials_changed`: it was made with another client id or environment than the
 * keys configured now, so it has to be connected again (ADR 0008 §Credentials 4).
 */
export type ProviderUnavailableReason =
  'not_configured' | 'household_keys_unavailable' | 'credentials_changed';

export class ProviderUnavailableError extends Error {
  constructor(
    readonly providerId: string,
    readonly reason: ProviderUnavailableReason,
  ) {
    super(`Provider "${providerId}" is unavailable for this connection: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}

/** What a connection says about its provider and the keys it was made with. Never the secret. */
export interface ConnectionRef {
  /** `connections.provider`. */
  provider: string;
  credentialSetId: string | null;
  providerEnv: string | null;
  providerClientId: string | null;
}

/**
 * A provider whose adapter depends on the connection: Plaid, whose keys are per connection
 * (ADR 0008). Throws `ProviderUnavailableError` when it can't serve this one.
 */
export interface ProviderSource {
  readonly id: string;
  forConnection(connection: ConnectionRef): AggregationProvider;
}

const isSource = (p: AggregationProvider | ProviderSource): p is ProviderSource =>
  'forConnection' in p && typeof p.forConnection === 'function';

/**
 * The providers this server has enabled (ADR 0004: by env and configuration), looked up by the
 * id stored on each connection: an adapter that serves every connection the same way, or a
 * `ProviderSource` that picks one per connection (Plaid's keys, ADR 0008).
 */
export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderSource>();

  constructor(providers: Iterable<AggregationProvider | ProviderSource> = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: AggregationProvider | ProviderSource): this {
    if (this.#providers.has(provider.id)) {
      throw new Error(`An aggregation provider is already registered as "${provider.id}"`);
    }
    this.#providers.set(
      provider.id,
      isSource(provider) ? provider : { id: provider.id, forConnection: () => provider },
    );
    return this;
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  /**
   * The adapter for a connection. Throws `UnknownProviderError` for a provider that isn't
   * enabled, and `ProviderUnavailableError` when it can't serve this connection.
   */
  forConnection(connection: ConnectionRef): AggregationProvider {
    const source = this.#providers.get(connection.provider);
    if (!source) throw new UnknownProviderError(connection.provider);
    return source.forConnection(connection);
  }

  /** The provider as it serves a connection on the server's own keys; see `forConnection`. */
  get(id: string): AggregationProvider {
    return this.forConnection({
      provider: id,
      credentialSetId: null,
      providerEnv: null,
      providerClientId: null,
    });
  }

  ids(): string[] {
    return [...this.#providers.keys()].sort();
  }
}
