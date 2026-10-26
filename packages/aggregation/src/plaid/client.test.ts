// SPDX-License-Identifier: AGPL-3.0-or-later
import { inspect } from 'node:util';
import { isProviderError, type ProviderError, type ProviderErrorKind } from '@fiscus/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakePlaid, type FakePlaid, type FakePlaidError } from '../testing/fake-plaid.js';
import { RIVERA } from '../testing/rivera.js';
import { jsonBody, startStubServer } from '../testing/stub-server.js';
import { PLAID_API_VERSION, PlaidClient } from './client.js';
import { plaidErrorKind } from './errors.js';

let plaid: FakePlaid;
let client: PlaidClient;

beforeEach(async () => {
  plaid = await startFakePlaid();
  client = new PlaidClient({
    clientId: plaid.clientId,
    secret: plaid.secret,
    env: 'sandbox',
    apiBaseUrl: plaid.url,
  });
});
afterEach(() => plaid.close());

const failure = (promise: Promise<unknown>): Promise<ProviderError> =>
  promise.then(
    () => {
      throw new Error('expected a ProviderError');
    },
    (error: unknown) => {
      if (!isProviderError(error)) throw error;
      return error;
    },
  );

/** What logging the error could show: its message, stack, JSON and printed form. */
const loggable = (error: Error) =>
  [error.message, error.stack, JSON.stringify(error), inspect(error), String(error)].join('\n');

describe('PlaidClient (#82)', () => {
  it('sends the keys in the body, with a pinned api version, to the base URL', async () => {
    await client.accountsGet(plaid.accessToken);
    const [request] = plaid.requests;
    expect(request).toMatchObject({ method: 'POST', path: '/accounts/get' });
    expect(request!.headers['content-type']).toBe('application/json');
    expect(request!.headers['plaid-version']).toBe(PLAID_API_VERSION);
    expect(jsonBody(request!)).toEqual({
      client_id: plaid.clientId,
      secret: plaid.secret,
      access_token: plaid.accessToken,
    });
    expect(client.baseUrl).toBe(plaid.url);
  });

  it('connects: a link token, the exchange, the institution and the accounts', async () => {
    const link = await client.linkTokenCreate({
      client_name: 'Fiscus',
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: 'user-alex' },
      products: ['transactions'],
    });
    expect(link.link_token).toBe('link-sandbox-user-alex');

    const exchange = await client.itemPublicTokenExchange(plaid.publicToken);
    expect(exchange).toMatchObject({ access_token: plaid.accessToken, item_id: plaid.itemId });

    const { institution } = await client.institutionsGetById(plaid.institutionId, ['US']);
    expect(institution).toMatchObject({
      institution_id: plaid.institutionId,
      name: 'Harbor Credit Union',
    });

    const { accounts, item } = await client.accountsGet(exchange.access_token);
    expect(item.item_id).toBe(plaid.itemId);
    const visa = accounts.find((a) => a.account_id === RIVERA.visa);
    // Plaid's sign: the card's balance owed is positive.
    expect(visa).toMatchObject({
      type: 'credit',
      mask: '3301',
      balances: { current: 1807.22, limit: 15000 },
    });
    // Fields Fiscus doesn't read are tolerated, and dropped.
    expect(visa).not.toHaveProperty('persistent_account_id');
  });

  it('syncs page by page, in Plaid’s sign, and sees new activity after a release', async () => {
    const first = await client.transactionsSync(plaid.accessToken);
    expect(jsonBody(plaid.requests.at(-1)!)).not.toHaveProperty('cursor');
    expect(first).toMatchObject({ has_more: true, next_cursor: 'cursor-1' });
    const rent = first.added.find((t) => t.transaction_id === 'txn-rent-1001');
    expect(rent).toMatchObject({ amount: 1850, pending: false, date: '2026-10-01' });
    expect(rent).not.toHaveProperty('payment_channel');

    const second = await client.transactionsSync(plaid.accessToken, { cursor: first.next_cursor });
    expect(second.has_more).toBe(false);
    const quiet = await client.transactionsSync(plaid.accessToken, { cursor: second.next_cursor });
    expect([quiet.added, quiet.modified, quiet.removed, quiet.next_cursor]).toEqual([
      [],
      [],
      [],
      second.next_cursor,
    ]);

    plaid.release();
    const next = await client.transactionsSync(plaid.accessToken, { cursor: second.next_cursor });
    expect(next.added.find((t) => t.transaction_id === 'txn-refund-1009')?.amount).toBe(-25.99);
    expect(
      next.added.find((t) => t.transaction_id === 'txn-coffee-1005')?.pending_transaction_id,
    ).toBe('txn-coffee-1005-pending');
    expect(next.removed).toEqual([
      { transaction_id: 'txn-coffee-1005-pending', account_id: RIVERA.visa },
    ]);
    expect(next.transactions_update_status).toBe('HISTORICAL_UPDATE_COMPLETE');
  });

  it('refreshes, reads liabilities and the item, moves the webhook, and removes', async () => {
    await expect(client.transactionsRefresh(plaid.accessToken)).resolves.toBeDefined();
    const { liabilities } = await client.liabilitiesGet(plaid.accessToken);
    expect(liabilities.credit).toEqual([
      expect.objectContaining({
        account_id: RIVERA.visa,
        aprs: [expect.objectContaining({ apr_percentage: 21.49 })],
        last_statement_balance: 1423.1,
        minimum_payment_amount: 35,
      }),
    ]);
    expect((await client.itemGet(plaid.accessToken)).item.webhook).toBeNull();
    const moved = await client.itemWebhookUpdate(
      plaid.accessToken,
      'https://fiscus.example/api/v1/webhooks/plaid',
    );
    expect(moved.item.webhook).toBe('https://fiscus.example/api/v1/webhooks/plaid');

    await client.itemRemove(plaid.accessToken);
    const after = await failure(client.itemGet(plaid.accessToken));
    expect([after.kind, after.providerCode]).toEqual([
      'invalid_credentials',
      'INVALID_ACCESS_TOKEN',
    ]);
  });

  it('fetches the webhook verification key', async () => {
    const { key } = await client.webhookVerificationKeyGet(plaid.webhookKey.kid);
    expect(key).toMatchObject({ alg: 'ES256', crv: 'P-256', kid: plaid.webhookKey.kid, kty: 'EC' });
    expect(key.expired_at).toBeNull();
  });

  describe('errors', () => {
    const UNTRUSTED = 'Alex Rivera, please <b>sign in</b> again at Harbor Credit Union';

    it.each<[FakePlaidError, ProviderErrorKind]>([
      [{ error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' }, 'login_required'],
      [{ error_type: 'ITEM_ERROR', error_code: 'PENDING_EXPIRATION' }, 'consent_expired'],
      [{ error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'TRANSACTIONS_LIMIT' }, 'rate_limited'],
      [{ error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_DOWN' }, 'institution_down'],
      [{ error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS' }, 'invalid_credentials'],
      [
        {
          error_type: 'TRANSACTIONS_ERROR',
          error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
        },
        'mutation_during_pagination',
      ],
      [{ error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' }, 'transient'],
    ])('maps %j to %s, keeping Plaid’s message out of what gets logged', async (e, kind) => {
      plaid.failNext('/transactions/sync', { ...e, error_message: UNTRUSTED });
      const error = await failure(client.transactionsSync(plaid.accessToken));
      expect(error.kind).toBe(kind);
      expect(error.providerCode).toBe(e.error_code);
      expect(error.providerMessage).toBe(UNTRUSTED);
      expect(loggable(error)).not.toContain('Harbor');
      // A retry gets the page.
      await expect(client.transactionsSync(plaid.accessToken)).resolves.toMatchObject({
        has_more: true,
      });
    });

    it('passes on how long to wait when rate limited', async () => {
      plaid.failNext('/transactions/refresh', {
        error_type: 'RATE_LIMIT_EXCEEDED',
        error_code: 'RATE_LIMIT_EXCEEDED',
        headers: { 'retry-after': '30' },
      });
      const error = await failure(client.transactionsRefresh(plaid.accessToken));
      expect([error.kind, error.retryAfterMs]).toEqual(['rate_limited', 30_000]);
    });

    it('maps codes by prefix and type, and anything unknown to transient', () => {
      expect(plaidErrorKind('ITEM_ERROR', 'INSTITUTION_NOT_RESPONDING')).toBe('institution_down');
      expect(plaidErrorKind('INSTITUTION_ERROR', 'SOMETHING_NEW')).toBe('institution_down');
      expect(plaidErrorKind('ITEM_ERROR', 'ITEM_LOCKED')).toBe('login_required');
      expect(plaidErrorKind('INVALID_INPUT', 'UNAUTHORIZED_ENVIRONMENT')).toBe(
        'invalid_credentials',
      );
      expect(plaidErrorKind('SOMETHING_NEW', 'ALSO_NEW')).toBe('transient');
    });

    it('reports wrong keys as invalid credentials, without the keys', async () => {
      const wrong = new PlaidClient({
        clientId: plaid.clientId,
        secret: 'wrong-secret-canary',
        env: 'sandbox',
        apiBaseUrl: plaid.url,
      });
      const error = await failure(wrong.accountsGet(plaid.accessToken));
      expect([error.kind, error.providerCode]).toEqual(['invalid_credentials', 'INVALID_API_KEYS']);
      for (const value of ['wrong-secret-canary', plaid.accessToken]) {
        expect(loggable(error)).not.toContain(value);
      }
    });

    it('treats a 5xx or a 429 without a Plaid body by its status', async () => {
      plaid.override('/item/get', { status: 502, body: '<html>Bad gateway</html>' });
      const bad = await failure(client.itemGet(plaid.accessToken));
      expect([bad.kind, bad.providerCode]).toEqual(['transient', 'HTTP_502']);

      plaid.override('/item/get', { status: 429, headers: { 'retry-after': '2' }, body: '' });
      const limited = await failure(client.itemGet(plaid.accessToken));
      expect([limited.kind, limited.providerCode, limited.retryAfterMs]).toEqual([
        'rate_limited',
        'HTTP_429',
        2_000,
      ]);
    });

    it('refuses a response that isn’t what Plaid sends, without quoting it', async () => {
      plaid.override('/accounts/get', {
        body: { accounts: [{ account_id: 'a', name: 'Canary Checking' }], item: null },
      });
      const error = await failure(client.accountsGet(plaid.accessToken));
      expect([error.kind, error.providerCode]).toEqual(['transient', 'INVALID_RESPONSE']);
      expect(loggable(error)).not.toContain('Canary');

      plaid.override('/accounts/get', { body: 'not json' });
      expect((await failure(client.accountsGet(plaid.accessToken))).providerCode).toBe(
        'INVALID_RESPONSE',
      );
    });

    it('times out', async () => {
      plaid.override('/item/get', () => new Promise(() => {}) as never);
      const slow = new PlaidClient({
        clientId: plaid.clientId,
        secret: plaid.secret,
        env: 'sandbox',
        apiBaseUrl: plaid.url,
        timeoutMs: 50,
      });
      const error = await failure(slow.itemGet(plaid.accessToken));
      expect([error.kind, error.providerCode]).toEqual(['transient', 'TIMEOUT']);
    });

    it('doesn’t follow redirects, so the keys go nowhere else', async () => {
      const elsewhere = await startStubServer({ 'POST /item/get': () => ({ body: {} }) });
      try {
        plaid.override('/item/get', {
          status: 307,
          headers: { location: `${elsewhere.url}/item/get` },
          body: '',
        });
        const error = await failure(client.itemGet(plaid.accessToken));
        expect([error.kind, error.providerCode]).toEqual(['transient', 'NETWORK_ERROR']);
        expect(elsewhere.requests).toEqual([]);
      } finally {
        await elsewhere.close();
      }
    });

    it('reports an unreachable server as transient, without the keys or token', async () => {
      await plaid.close();
      const error = await failure(client.accountsGet(plaid.accessToken));
      expect([error.kind, error.providerCode]).toEqual(['transient', 'NETWORK_ERROR']);
      expect(error.cause).toBeUndefined();
      for (const value of [plaid.secret, plaid.accessToken]) {
        expect(loggable(error)).not.toContain(value);
      }
      plaid = await startFakePlaid(); // for afterEach
    });
  });

  it('never shows its secret when printed', () => {
    for (const shown of [String(client), inspect(client), JSON.stringify(client)]) {
      expect(shown).not.toContain(plaid.secret);
    }
  });

  describe('the base URL', () => {
    const recording = (urls: string[]): typeof fetch =>
      (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ request_id: 'r' }), { status: 200 });
      }) as typeof fetch;

    it('follows the environment', async () => {
      const urls: string[] = [];
      for (const env of ['sandbox', 'production'] as const) {
        await new PlaidClient({
          clientId: 'c',
          secret: 's',
          env,
          fetch: recording(urls),
        }).itemRemove('t');
      }
      expect(urls).toEqual([
        'https://sandbox.plaid.com/item/remove',
        'https://production.plaid.com/item/remove',
      ]);
    });

    it('ignores the test override in production', async () => {
      const urls: string[] = [];
      const production = new PlaidClient({
        clientId: 'c',
        secret: 'production-secret',
        env: 'production',
        apiBaseUrl: plaid.url,
        fetch: recording(urls),
      });
      expect(production.baseUrl).toBe('https://production.plaid.com');
      await production.transactionsRefresh('access-production');
      expect(urls).toEqual(['https://production.plaid.com/transactions/refresh']);
      expect(plaid.requests).toEqual([]);
    });

    it('makes sandbox Items only in sandbox, refusing before any request elsewhere', async () => {
      const urls: string[] = [];
      const production = new PlaidClient({
        clientId: 'c',
        secret: 's',
        env: 'production',
        fetch: recording(urls),
      });
      await expect(
        production.sandboxPublicTokenCreate('ins_109508', ['transactions']),
      ).rejects.toMatchObject({ providerCode: 'SANDBOX_ONLY' });
      await expect(production.sandboxItemResetLogin('t')).rejects.toMatchObject({
        providerCode: 'SANDBOX_ONLY',
      });
      expect(urls).toEqual([]);
    });
  });
});
