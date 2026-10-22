// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  PROVIDER_ERROR_KINDS,
  ProviderError,
  type ProviderErrorKind,
  type ProviderSecret,
  type SyncPage,
  type SyncRequest,
} from '@fiscus/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, ProviderUnavailableError } from '../registry.js';
import {
  describeProviderConformance,
  RIVERA,
  riveraAccounts,
  riveraBalances,
  riveraScenario,
  startFakePlaid,
  type FakePlaid,
  type FakePlaidError,
} from '../testing.js';
import { PlaidClient } from './client.js';
import { PLAID_SYNC_COUNT, PlaidProvider, plaidProviderSource } from './provider.js';

// The Plaid adapter (#82) against the fake Plaid server: the conformance suite every adapter
// passes, then what's particular to Plaid.

/** Plaid's own error for each kind, as its api would send it. */
const PLAID_ERRORS: Record<ProviderErrorKind, FakePlaidError> = {
  login_required: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' },
  consent_expired: { error_type: 'ITEM_ERROR', error_code: 'PENDING_EXPIRATION' },
  rate_limited: {
    error_type: 'RATE_LIMIT_EXCEEDED',
    error_code: 'TRANSACTIONS_SYNC_LIMIT',
    headers: { 'retry-after': '30' },
  },
  institution_down: { error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_DOWN' },
  invalid_credentials: { error_type: 'INVALID_INPUT', error_code: 'INVALID_ACCESS_TOKEN' },
  mutation_during_pagination: {
    error_type: 'TRANSACTIONS_ERROR',
    error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
  },
  transient: { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' },
};

const clientFor = (fake: FakePlaid) =>
  new PlaidClient({
    clientId: fake.clientId,
    secret: fake.secret,
    env: 'sandbox',
    apiBaseUrl: fake.url,
  });

describeProviderConformance(
  'PlaidProvider',
  async ({ scenario, fail }) => {
    const fake = await startFakePlaid({ scenario });
    let syncs = 0;
    /** Fails the `onSync`th sync with Plaid's own error for the kind, once. */
    class Scripted extends PlaidProvider {
      override sync(secret: ProviderSecret, request: SyncRequest): Promise<SyncPage> {
        if (fail && syncs++ === fail.onSync) {
          fake.failNext('/transactions/sync', {
            ...PLAID_ERRORS[fail.kind],
            error_message: fail.providerMessage,
          });
        }
        return super.sync(secret, request);
      }
    }
    return {
      provider: new Scripted(clientFor(fake)),
      secret: fake.accessToken,
      release: () => fake.release(),
      close: () => fake.close(),
    };
  },
  {
    errorKinds: PROVIDER_ERROR_KINDS,
    // /transactions/sync has no original foreign amount, and Plaid doesn't flag closed accounts.
    unsupportedFields: ['foreignAmountMinor', 'foreignCurrency'],
    unsupportedAccountFields: ['closed'],
  },
);

describe('PlaidProvider (#82)', () => {
  let fake: FakePlaid | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  const syncBodies = (f: FakePlaid) =>
    f.requests
      .filter((r) => r.path === '/transactions/sync')
      .map((r) => JSON.parse(r.body) as Record<string, unknown>);

  it('asks /transactions/sync for 500 at a time, the bank’s own text, and PFC v2', async () => {
    fake = await startFakePlaid();
    const provider = new PlaidProvider(clientFor(fake));
    const first = await provider.sync(fake.accessToken, { cursor: null });
    await provider.sync(fake.accessToken, { cursor: first.nextCursor });
    const [a, b] = syncBodies(fake);
    expect(a).not.toHaveProperty('cursor');
    expect(b).toMatchObject({ cursor: first.nextCursor });
    for (const body of [a, b]) {
      expect(body).toMatchObject({
        count: PLAID_SYNC_COUNT,
        options: { include_original_description: true, personal_finance_category_version: 'v2' },
      });
    }
    expect(PLAID_SYNC_COUNT).toBe(500);
    // Only /transactions/sync, never /transactions/get (TXN-001).
    expect(fake.requests.some((r) => r.path === '/transactions/get')).toBe(false);
  });

  it('carries accounts and balances, from /accounts/get, on the last page only', async () => {
    fake = await startFakePlaid();
    const provider = new PlaidProvider(clientFor(fake));
    const first = await provider.sync(fake.accessToken, { cursor: null });
    expect(first.hasMore).toBe(true);
    expect(first.balances).toBeUndefined();
    expect(fake.requests.filter((r) => r.path === '/accounts/get')).toHaveLength(0);
    const last = await provider.sync(fake.accessToken, { cursor: first.nextCursor });
    expect(last.hasMore).toBe(false);
    expect(fake.requests.filter((r) => r.path === '/accounts/get')).toHaveLength(1);
    expect(last.balances).toEqual(riveraBalances());
    expect(last.accounts?.map((a) => a.providerAccountId)).toEqual(
      riveraAccounts().map((a) => a.providerAccountId),
    );
  });

  it('says when the history is complete (HISTORICAL_UPDATE_COMPLETE)', async () => {
    fake = await startFakePlaid();
    const provider = new PlaidProvider(clientFor(fake));
    let cursor: string | null = null;
    let page: SyncPage;
    do {
      page = await provider.sync(fake.accessToken, { cursor });
      cursor = page.nextCursor;
    } while (page.hasMore);
    expect(page.historicalComplete).toBeUndefined();
    fake.release();
    page = await provider.sync(fake.accessToken, { cursor });
    expect(page.historicalComplete).toBe(true);
  });

  it('takes an empty first sync as normal, keeping no cursor', async () => {
    fake = await startFakePlaid();
    fake.override('/transactions/sync', () => ({
      body: {
        added: [],
        modified: [],
        removed: [],
        next_cursor: '',
        has_more: false,
        transactions_update_status: 'NOT_READY',
        accounts: [],
        request_id: 'req-empty',
      },
    }));
    const page = await new PlaidProvider(clientFor(fake)).sync(fake.accessToken, {
      cursor: null,
    });
    expect(page).toMatchObject({ mode: 'delta', added: [], hasMore: false, nextCursor: null });
    expect(page.historicalComplete).toBeUndefined();
  });

  it('skips rows it can’t represent, and a removal without its account', async () => {
    fake = await startFakePlaid();
    const base = {
      account_id: RIVERA.checking,
      pending: false,
      pending_transaction_id: null,
      date: '2026-10-10',
      authorized_date: null,
      name: 'X',
      merchant_name: null,
      personal_finance_category: null,
    };
    fake.override('/transactions/sync', () => ({
      body: {
        added: [
          // An unofficial currency Fiscus can't hold amounts in.
          {
            ...base,
            transaction_id: 'btc',
            amount: 0.001,
            iso_currency_code: null,
            unofficial_currency_code: 'XBT1',
          },
          {
            ...base,
            transaction_id: 'none',
            amount: 1,
            iso_currency_code: null,
            unofficial_currency_code: null,
          },
          { ...base, transaction_id: 'ok', amount: 12.34, iso_currency_code: 'USD' },
          {
            ...base,
            transaction_id: 'unofficial',
            amount: 1,
            iso_currency_code: null,
            unofficial_currency_code: 'CNH',
          },
        ],
        modified: [],
        removed: [{ transaction_id: 'gone' }, { transaction_id: 'gone2', account_id: RIVERA.visa }],
        next_cursor: 'c1',
        has_more: true,
      },
    }));
    const page = await new PlaidProvider(clientFor(fake)).sync(fake.accessToken, {
      cursor: null,
    });
    expect(page.added.map((t) => [t.providerTransactionId, t.amountMinor, t.currency])).toEqual([
      ['ok', -1234, 'USD'],
      ['unofficial', -100, 'CNH'],
    ]);
    expect(page.removed).toEqual([
      { providerTransactionId: 'gone2', providerAccountId: RIVERA.visa },
    ]);
  });

  it('calls /liabilities/get only for an Item with a card or loan (LIAB-008)', async () => {
    const depositoryOnly = riveraScenario();
    depositoryOnly.accounts = depositoryOnly.accounts.filter((a) => a.type === 'depository');
    depositoryOnly.liabilities = [];
    fake = await startFakePlaid({ scenario: depositoryOnly });
    const provider = new PlaidProvider(clientFor(fake));
    expect(await provider.liabilities(fake.accessToken)).toEqual([]);
    expect(fake.requests.map((r) => r.path)).toEqual(['/accounts/get']);
  });

  it('reads a card, a student loan and a mortgage, each field on its own', async () => {
    const scenario = riveraScenario();
    scenario.accounts.push(
      {
        providerAccountId: 'loan-student',
        name: 'Student',
        type: 'loan',
        subtype: 'student',
        currency: 'USD',
      },
      {
        providerAccountId: 'loan-home',
        name: 'Home',
        type: 'loan',
        subtype: 'mortgage',
        currency: 'USD',
      },
    );
    scenario.liabilities.push(
      {
        providerAccountId: 'loan-student',
        kind: 'student',
        currency: 'USD',
        aprBps: 525,
        lastStatementBalanceMinor: -1_234_567,
        minimumPaymentMinor: 15_000,
      },
      {
        providerAccountId: 'loan-home',
        kind: 'mortgage',
        currency: 'USD',
        nextPaymentDueDate: '2026-11-01',
      },
    );
    fake = await startFakePlaid({ scenario });
    expect(await new PlaidProvider(clientFor(fake)).liabilities(fake.accessToken)).toEqual(
      scenario.liabilities,
    );
  });

  it('gives no details, rather than failing, when the Item has none or no consent for them', async () => {
    fake = await startFakePlaid();
    const provider = new PlaidProvider(clientFor(fake));
    fake.failNext('/liabilities/get', {
      error_type: 'INVALID_INPUT',
      error_code: 'ADDITIONAL_CONSENT_REQUIRED',
    });
    expect(await provider.liabilities(fake.accessToken)).toEqual([]);
    // Not ready yet is retried with backoff, not taken as "none" (ITEM-004, ITEM-006).
    fake.failNext('/liabilities/get', {
      error_type: 'ITEM_ERROR',
      error_code: 'PRODUCT_NOT_READY',
    });
    await expect(provider.liabilities(fake.accessToken)).rejects.toMatchObject({
      kind: 'transient',
      providerCode: 'PRODUCT_NOT_READY',
    });
  });

  it('removes the Item at Plaid, and takes an Item already gone as removed', async () => {
    fake = await startFakePlaid();
    const provider = new PlaidProvider(clientFor(fake));
    fake.failNext('/item/remove', { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' });
    await expect(provider.remove(fake.accessToken)).rejects.toBeInstanceOf(ProviderError);
    fake.failNext('/item/remove', { error_type: 'ITEM_ERROR', error_code: 'ITEM_NOT_FOUND' });
    await expect(provider.remove(fake.accessToken)).resolves.toBeUndefined();
    await provider.remove(fake.accessToken);
    expect(fake.requests.map((r) => r.path)).toEqual(Array(3).fill('/item/remove'));
    // The token is dead at Plaid now.
    await expect(provider.listAccounts(fake.accessToken)).rejects.toMatchObject({
      providerCode: 'INVALID_ACCESS_TOKEN',
    });
  });

  it('keeps Plaid’s request id with a failure, and never its message or the token', async () => {
    fake = await startFakePlaid();
    fake.failNext('/transactions/sync', {
      error_type: 'ITEM_ERROR',
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: 'Alex Rivera at Harbor Credit Union owes $1,807.22',
    });
    const error = (await new PlaidProvider(clientFor(fake))
      .sync(fake.accessToken, { cursor: null })
      .catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('login_required');
    expect(error.providerRequestId).toMatch(/^req-\d+$/);
    for (const text of [error.message, JSON.stringify(error), String(error.stack)]) {
      expect(text).not.toContain('Harbor');
      expect(text).not.toContain(fake.accessToken);
    }
  });

  it.each([
    ['ITEM_ERROR', 'PRODUCT_NOT_READY', 'transient'],
    ['INSTITUTION_ERROR', 'INSTITUTION_NOT_RESPONDING', 'institution_down'],
    ['RATE_LIMIT_EXCEEDED', 'RATE_LIMIT', 'rate_limited'],
    ['ITEM_ERROR', 'ITEM_NOT_FOUND', 'invalid_credentials'],
    ['ITEM_ERROR', 'ITEM_LOGIN_REQUIRED', 'login_required'],
  ] as const)('maps %s %s to %s', async (type, code, kind) => {
    fake = await startFakePlaid();
    fake.failNext('/transactions/sync', { error_type: type, error_code: code });
    await expect(
      new PlaidProvider(clientFor(fake)).sync(fake.accessToken, { cursor: null }),
    ).rejects.toMatchObject({ kind, providerCode: code });
  });
});

describe('plaidProviderSource (#82)', () => {
  const instance = { clientId: 'client-a', secret: 'secret-a', env: 'sandbox' as const };
  const ref = (fields: Partial<Parameters<ProviderRegistry['forConnection']>[0]> = {}) => ({
    provider: 'plaid',
    credentialSetId: null,
    providerEnv: 'sandbox',
    providerClientId: 'client-a',
    ...fields,
  });

  it('serves a connection made with the server’s keys, one provider per set of keys', () => {
    const registry = new ProviderRegistry([plaidProviderSource(instance)]);
    const a = registry.forConnection(ref());
    expect(a).toBeInstanceOf(PlaidProvider);
    expect(registry.forConnection(ref())).toBe(a);
    // Recorded before #78 stamped connections: nothing to compare, so the server's keys.
    expect(registry.forConnection(ref({ providerEnv: null, providerClientId: null }))).toBe(a);
  });

  it('refuses another client id or environment, but not a rotated secret', () => {
    const rotated = new ProviderRegistry([
      plaidProviderSource({ ...instance, secret: 'secret-b' }),
    ]);
    expect(rotated.forConnection(ref())).toBeInstanceOf(PlaidProvider);
    const registry = new ProviderRegistry([plaidProviderSource(instance)]);
    for (const changed of [{ providerClientId: 'client-b' }, { providerEnv: 'production' }]) {
      expect(() => registry.forConnection(ref(changed))).toThrow(
        expect.objectContaining({ reason: 'credentials_changed' }),
      );
    }
  });

  it('keeps refusing a household’s own keys (#83), and a server without keys', () => {
    const registry = new ProviderRegistry([plaidProviderSource(instance)]);
    expect(() =>
      registry.forConnection(ref({ credentialSetId: '00000000-0000-4000-8000-000000000001' })),
    ).toThrow(new ProviderUnavailableError('plaid', 'household_keys_unavailable'));
    const none = new ProviderRegistry([plaidProviderSource(undefined)]);
    expect(() => none.forConnection(ref())).toThrow(
      expect.objectContaining({ reason: 'not_configured' }),
    );
  });

  it('never puts the secret in what it says', () => {
    const error = (() => {
      try {
        new ProviderRegistry([plaidProviderSource(instance)]).forConnection(
          ref({ providerClientId: 'client-b' }),
        );
      } catch (e) {
        return e as Error;
      }
    })();
    expect(`${error?.message} ${JSON.stringify(error)}`).not.toContain('secret-a');
  });
});
