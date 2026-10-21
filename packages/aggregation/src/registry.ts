// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AggregationProvider } from '@fiscus/domain';

export class UnknownProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`No aggregation provider is registered as "${providerId}"`);
    this.name = 'UnknownProviderError';
  }
}

/**
 * The providers this server has enabled (ADR 0004: by env and configuration), looked up by the
 * id stored on each connection. Resolving by connection, for Plaid's per-household keys
 * (ADR 0008), builds on this when #83 lands.
 */
export class ProviderRegistry {
  readonly #providers = new Map<string, AggregationProvider>();

  constructor(providers: Iterable<AggregationProvider> = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: AggregationProvider): this {
    if (this.#providers.has(provider.id)) {
      throw new Error(`An aggregation provider is already registered as "${provider.id}"`);
    }
    this.#providers.set(provider.id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  /** Throws `UnknownProviderError` for a provider that isn't enabled. */
  get(id: string): AggregationProvider {
    const provider = this.#providers.get(id);
    if (!provider) throw new UnknownProviderError(id);
    return provider;
  }

  ids(): string[] {
    return [...this.#providers.keys()].sort();
  }
}
