// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, UnknownProviderError } from './registry.js';
import { FakeAggregationProvider } from './testing/fake-provider.js';
import { riveraScenario } from './testing/rivera.js';

const plaidLike = new FakeAggregationProvider({ id: 'plaid', mode: 'delta', ...riveraScenario() });
const simplefinLike = new FakeAggregationProvider({
  id: 'simplefin',
  mode: 'window',
  ...riveraScenario(),
});

describe('ProviderRegistry', () => {
  it('resolves a provider by id', () => {
    const registry = new ProviderRegistry([simplefinLike, plaidLike]);
    expect(registry.get('plaid')).toBe(plaidLike);
    expect(registry.has('simplefin')).toBe(true);
    expect(registry.ids()).toEqual(['plaid', 'simplefin']);
  });

  it("names a provider that isn't enabled", () => {
    const registry = new ProviderRegistry([plaidLike]);
    expect(registry.has('simplefin')).toBe(false);
    expect(() => registry.get('simplefin')).toThrow(UnknownProviderError);
  });

  it('refuses two providers with one id', () => {
    const registry = new ProviderRegistry([plaidLike]);
    expect(() => registry.register(plaidLike)).toThrow(/already registered/);
  });
});
