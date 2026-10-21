// SPDX-License-Identifier: AGPL-3.0-or-later
import { isProviderError, PROVIDER_ERROR_KINDS } from '@fiscus/domain';
import { describe, expect, it } from 'vitest';
import { describeProviderConformance, type ConformanceSetup } from './conformance.js';
import { FakeAggregationProvider, FakeClock } from './fake-provider.js';
import { RIVERA, riveraScenario } from './rivera.js';

const fakeHarness =
  (mode: 'delta' | 'window') =>
  ({ scenario, fail }: ConformanceSetup) => {
    const provider = new FakeAggregationProvider({
      mode,
      ...scenario,
      clock: new FakeClock(scenario.now),
      errors: fail ? [fail] : [],
    });
    return { provider, secret: 'fake-secret', release: () => provider.release() };
  };

// The fake is the reference: both of its modes pass the suite every adapter must.
describeProviderConformance('fake (delta, like Plaid)', fakeHarness('delta'), {
  errorKinds: PROVIDER_ERROR_KINDS,
});
describeProviderConformance('fake (window, like SimpleFIN)', fakeHarness('window'), {
  errorKinds: PROVIDER_ERROR_KINDS,
});

const fake = (mode: 'delta' | 'window', extra: Partial<ConformanceSetup['scenario']> = {}) => {
  const scenario = { ...riveraScenario(), ...extra };
  return new FakeAggregationProvider({ mode, ...scenario, clock: new FakeClock(scenario.now) });
};

describe('FakeAggregationProvider', () => {
  it('defaults its capabilities to the provider its mode is like', () => {
    expect(fake('delta').capabilities).toMatchObject({ cursorSync: true, maxHistoryDays: 730 });
    expect(fake('window').capabilities).toMatchObject({
      cursorSync: false,
      pendingLinks: false,
      minRefreshMs: 6 * 60 * 60_000,
    });
  });

  it('pages through an update, then waits at the cursor for the next', async () => {
    const provider = fake('delta');
    const first = await provider.sync('fake-secret', { cursor: null });
    expect(first.hasMore).toBe(true);
    const second = await provider.sync('fake-secret', { cursor: first.nextCursor });
    expect(second.hasMore).toBe(false);
    const quiet = await provider.sync('fake-secret', { cursor: second.nextCursor });
    expect(quiet.added).toEqual([]);
    provider.release();
    const next = await provider.sync('fake-secret', { cursor: second.nextCursor });
    expect(next.removed).toEqual([
      { providerTransactionId: 'txn-coffee-1005-pending', providerAccountId: RIVERA.visa },
    ]);
    expect(next.historicalComplete).toBe(true);
  });

  it('serves pushed updates once released', async () => {
    const provider = fake('delta', { updates: riveraScenario().updates.slice(0, 1) });
    let cursor: string | null = null;
    for (let more = true; more;) {
      const page = await provider.sync('fake-secret', { cursor });
      ({ nextCursor: cursor, hasMore: more } = page);
    }
    provider.push([{ removed: [{ providerTransactionId: 'x', providerAccountId: RIVERA.visa }] }]);
    expect((await provider.sync('fake-secret', { cursor })).removed).toEqual([]);
    provider.release();
    expect((await provider.sync('fake-secret', { cursor })).removed).toHaveLength(1);
    expect(() => provider.release()).toThrow(/No more/);
  });

  it('windows by since and by its history limit, on its clock', async () => {
    const provider = fake('window');
    const page = await provider.sync('fake-secret', { cursor: null, since: '2026-10-03' });
    expect(page.window).toMatchObject({ from: '2026-10-03', to: '2026-10-20' });
    expect(page.added.map((t) => t.providerTransactionId)).toEqual([
      'txn-groceries-1003',
      'txn-coffee-1005-pending',
      'txn-dinner-1004',
    ]);
    provider.clock.advance(200 * 86_400_000);
    const later = await provider.sync('fake-secret', { cursor: null, since: '2026-07-22' });
    expect(later.window?.from).toBe('2027-02-07');
    expect(later.added).toEqual([]);
  });

  it('fails the scripted sync once, with untrusted text kept out of the message', async () => {
    const provider = new FakeAggregationProvider({
      mode: 'delta',
      ...riveraScenario(),
      errors: [
        { onSync: 0, kind: 'login_required', providerCode: 'ITEM_LOGIN_REQUIRED' },
        { onSync: 1, kind: 'rate_limited', retryAfterMs: 1_000, providerMessage: 'Slow down' },
      ],
    });
    const first = await provider.sync('fake-secret', { cursor: null }).catch((e: unknown) => e);
    expect(first).toMatchObject({ kind: 'login_required', providerCode: 'ITEM_LOGIN_REQUIRED' });
    const second = await provider.sync('fake-secret', { cursor: null }).catch((e: unknown) => e);
    expect(isProviderError(second) && second.retryAfterMs).toBe(1_000);
    expect(isProviderError(second) && second.providerMessage).toBe('Slow down');
    await expect(provider.sync('fake-secret', { cursor: null })).resolves.toMatchObject({
      hasMore: true,
    });
  });

  it('rejects another secret, and every call after remove', async () => {
    const provider = fake('delta');
    await expect(provider.listAccounts('stolen')).rejects.toMatchObject({
      kind: 'invalid_credentials',
    });
    await provider.remove('fake-secret');
    await expect(provider.sync('fake-secret', { cursor: null })).rejects.toMatchObject({
      kind: 'invalid_credentials',
      providerCode: 'FAKE_ITEM_REMOVED',
    });
  });

  it('limits refreshes to one per minRefreshMs', async () => {
    const provider = fake('delta');
    await provider.refresh('fake-secret');
    provider.clock.advance(5 * 60_000);
    await expect(provider.refresh('fake-secret')).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 10 * 60_000,
    });
    provider.clock.advance(10 * 60_000);
    await expect(provider.refresh('fake-secret')).resolves.toBeUndefined();
  });

  it('records calls without secrets, and copies what it returns', async () => {
    const provider = fake('delta');
    const accounts = await provider.listAccounts('fake-secret');
    accounts[0]!.name = 'Changed';
    expect((await provider.listAccounts('fake-secret'))[0]!.name).toBe('Harbor CU Checking');
    await provider.sync('fake-secret', { cursor: null, since: '2026-07-22' });
    expect(provider.calls).toEqual([
      { method: 'listAccounts' },
      { method: 'listAccounts' },
      { method: 'sync', request: { cursor: null, since: '2026-07-22' } },
    ]);
    expect(JSON.stringify(provider.calls)).not.toContain('fake-secret');
  });
});
