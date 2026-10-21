// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type {
  ProviderAccount,
  ProviderBalance,
  ProviderLiability,
  ProviderTransaction,
} from '@fiscus/domain';
import { riveraScenario, type ConformanceScenario } from './rivera.js';
import { jsonBody, startStubServer, type StubRequest, type StubResponse } from './stub-server.js';
import type { ScriptedPage } from './fake-provider.js';

// A fake Plaid for tests (D17: nothing in the test suite talks to Plaid): Plaid's endpoints on a
// stub server, answering in Plaid's own format (snake_case, decimal amounts, positive = money
// out) from a scenario in Fiscus's terms, the Riveras' Harbor Credit Union by default. It checks
// the keys and tokens on every request, as Plaid does, and can be told to fail.

export interface FakePlaidOptions {
  clientId?: string;
  secret?: string;
  scenario?: ConformanceScenario;
}

/** A Plaid error to answer with. `status` defaults by type, as Plaid's do. */
export interface FakePlaidError {
  error_type: string;
  error_code: string;
  error_message?: string;
  display_message?: string | null;
  status?: number;
  headers?: Record<string, string>;
}

export interface FakePlaid {
  /** Point the client's `apiBaseUrl` here (sandbox only). */
  url: string;
  clientId: string;
  secret: string;
  /** What Link would hand the browser, for `/item/public_token/exchange`. */
  publicToken: string;
  accessToken: string;
  itemId: string;
  institutionId: string;
  /** Every request received, in order. */
  requests: StubRequest[];
  /** The key webhooks would be signed with; `/webhook_verification_key/get` serves its public half. */
  webhookKey: { kid: string; privateKey: KeyObject };
  /** Makes the scenario's next update visible to `/transactions/sync`. */
  release(): void;
  /** The next `times` requests to `path` (e.g. `/transactions/sync`) fail with `error`. */
  failNext(path: string, error: FakePlaidError, times?: number): void;
  /** Answers `path` with anything, for malformed and unexpected responses. */
  override(path: string, response: StubResponse | ((request: StubRequest) => StubResponse)): void;
  close(): Promise<void>;
}

const STATUS_BY_TYPE: Record<string, number> = {
  RATE_LIMIT_EXCEEDED: 429,
  API_ERROR: 500,
  INSTITUTION_ERROR: 400,
};

const major = (minor: number) => minor / 100;

/** Plaid reports what a card or loan owes as positive; Fiscus as negative. */
const owes = (type: ProviderAccount['type']) => type === 'credit' || type === 'loan';

export function plaidAccount(account: ProviderAccount, balance: ProviderBalance | undefined) {
  const sign = owes(account.type) ? -1 : 1;
  return {
    account_id: account.providerAccountId,
    name: account.name,
    official_name: account.officialName ?? null,
    type: account.type,
    subtype: account.subtype ?? null,
    mask: account.mask ?? null,
    persistent_account_id: `persistent-${account.providerAccountId}`,
    balances: {
      available: balance?.availableMinor === undefined ? null : major(balance.availableMinor),
      current: balance === undefined ? null : major(sign * balance.currentMinor) || 0,
      limit: balance?.creditLimitMinor === undefined ? null : major(balance.creditLimitMinor),
      iso_currency_code: balance?.currency ?? account.currency,
      unofficial_currency_code: null,
      last_updated_datetime: balance?.asOf ?? null,
    },
  };
}

export function plaidTransaction(t: ProviderTransaction) {
  return {
    transaction_id: t.providerTransactionId,
    account_id: t.providerAccountId,
    // Plaid's sign: positive = money out.
    amount: major(-t.amountMinor) || 0,
    iso_currency_code: t.currency,
    unofficial_currency_code: null,
    pending: t.pending,
    pending_transaction_id: t.pendingTransactionId ?? null,
    date: t.postedDate ?? t.authorizedDate,
    authorized_date: t.authorizedDate,
    name: t.description,
    merchant_name: t.merchantName ?? null,
    payment_channel: 'in store',
    personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'OTHER' },
  };
}

export function plaidCreditLiability(l: ProviderLiability) {
  return {
    account_id: l.providerAccountId,
    aprs:
      l.aprBps === undefined
        ? []
        : [
            {
              apr_percentage: l.aprBps / 100,
              apr_type: 'purchase_apr',
              balance_subject_to_apr: null,
            },
          ],
    is_overdue: false,
    last_payment_amount: null,
    last_payment_date: null,
    last_statement_balance:
      l.lastStatementBalanceMinor === undefined ? null : major(-l.lastStatementBalanceMinor),
    last_statement_issue_date: l.lastStatementDate ?? null,
    minimum_payment_amount:
      l.minimumPaymentMinor === undefined ? null : major(l.minimumPaymentMinor),
    next_payment_due_date: l.nextPaymentDueDate ?? null,
  };
}

const error = (e: FakePlaidError, requestId: string): StubResponse => ({
  status: e.status ?? STATUS_BY_TYPE[e.error_type] ?? 400,
  ...(e.headers && { headers: e.headers }),
  body: {
    error_type: e.error_type,
    error_code: e.error_code,
    error_message: e.error_message ?? e.error_code.toLowerCase().replaceAll('_', ' '),
    display_message: e.display_message ?? null,
    request_id: requestId,
  },
});

export async function startFakePlaid(options: FakePlaidOptions = {}): Promise<FakePlaid> {
  const clientId = options.clientId ?? 'fake-client-id-rivera';
  const secret = options.secret ?? 'fake-sandbox-secret-rivera';
  const scenario = options.scenario ?? riveraScenario();
  const publicToken = 'public-sandbox-harbor-0001';
  const itemId = 'item-harbor-rivera';
  const institutionId = 'ins_harbor_cu';
  let accessToken: string | undefined = 'access-sandbox-harbor-0001';
  let webhook: string | null = null;
  let released = 1;
  let requestCount = 0;
  const failures = new Map<string, FakePlaidError[]>();
  const overrides = new Map<string, (request: StubRequest) => StubResponse>();

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = 'fake-plaid-key-1';
  const jwk = publicKey.export({ format: 'jwk' });

  const balances = new Map(scenario.balances.map((b) => [b.providerAccountId, b]));
  const accounts = () =>
    scenario.accounts.map((a) => plaidAccount(a, balances.get(a.providerAccountId)));
  const item = () => ({
    item_id: itemId,
    institution_id: institutionId,
    webhook,
    error: null,
    available_products: ['investments'],
    billed_products: ['transactions', 'liabilities'],
    products: ['transactions', 'liabilities'],
    consent_expiration_time: null,
    update_type: 'background',
  });
  const pages = (): ScriptedPage[] => scenario.updates.slice(0, released).flat();

  type Body = Record<string, unknown>;
  type Handler = (body: Body, requestId: string) => StubResponse;

  /** Checks the keys (and the access token, if `token`), then any scripted failure. */
  const plaid =
    (path: string, handler: Handler, { token = true } = {}) =>
    (request: StubRequest): StubResponse => {
      const requestId = `req-${++requestCount}`;
      const override = overrides.get(path);
      if (override) return override(request);
      let body: Body;
      try {
        body = jsonBody<Body>(request);
      } catch {
        return error({ error_type: 'INVALID_REQUEST', error_code: 'INVALID_BODY' }, requestId);
      }
      if (body.client_id !== clientId || body.secret !== secret) {
        return error({ error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS' }, requestId);
      }
      if (token && (accessToken === undefined || body.access_token !== accessToken)) {
        return error(
          { error_type: 'INVALID_INPUT', error_code: 'INVALID_ACCESS_TOKEN' },
          requestId,
        );
      }
      const queued = failures.get(path);
      const failure = queued?.shift();
      if (failure) return error(failure, requestId);
      return handler(body, requestId);
    };

  const routes: Record<string, Handler | [Handler, { token: boolean }]> = {
    '/link/token/create': [
      (body, request_id) => ({
        body: {
          link_token: `link-sandbox-${String((body.user as Body | undefined)?.client_user_id ?? 'user')}`,
          expiration: '2026-10-20T16:00:00Z',
          request_id,
        },
      }),
      { token: false },
    ],
    '/item/public_token/exchange': [
      (body, request_id) =>
        body.public_token === publicToken && accessToken !== undefined
          ? { body: { access_token: accessToken, item_id: itemId, request_id } }
          : error({ error_type: 'INVALID_INPUT', error_code: 'INVALID_PUBLIC_TOKEN' }, request_id),
      { token: false },
    ],
    '/accounts/get': (_, request_id) => ({
      body: { accounts: accounts(), item: item(), request_id },
    }),
    '/institutions/get_by_id': [
      (body, request_id) =>
        body.institution_id === institutionId
          ? {
              body: {
                institution: {
                  institution_id: institutionId,
                  name: 'Harbor Credit Union',
                  url: 'https://harbor-cu.example',
                  logo: null,
                  primary_color: '#1f4e79',
                  country_codes: ['US'],
                  products: ['transactions', 'liabilities'],
                  oauth: false,
                },
                request_id,
              },
            }
          : error({ error_type: 'INVALID_INPUT', error_code: 'INVALID_INSTITUTION' }, request_id),
      { token: false },
    ],
    '/transactions/sync': (body, request_id) => {
      const cursor = typeof body.cursor === 'string' && body.cursor !== '' ? body.cursor : null;
      const at = cursor === null ? 0 : Number(/^cursor-(\d+)$/.exec(cursor)?.[1] ?? NaN);
      const all = pages();
      if (!Number.isSafeInteger(at) || at > all.length) {
        return error({ error_type: 'INVALID_INPUT', error_code: 'INVALID_CURSOR' }, request_id);
      }
      const page = all[at];
      const seen = all.slice(0, at + 1);
      return {
        body: {
          added: (page?.added ?? []).map(plaidTransaction),
          modified: (page?.modified ?? []).map(plaidTransaction),
          removed: (page?.removed ?? []).map((r) => ({
            transaction_id: r.providerTransactionId,
            account_id: r.providerAccountId,
          })),
          next_cursor: page ? `cursor-${at + 1}` : (cursor ?? `cursor-${at}`),
          has_more: at + 1 < all.length,
          transactions_update_status: seen.some((p) => p.historicalComplete)
            ? 'HISTORICAL_UPDATE_COMPLETE'
            : 'INITIAL_UPDATE_COMPLETE',
          accounts: accounts(),
          request_id,
        },
      };
    },
    '/transactions/refresh': (_, request_id) => ({ body: { request_id } }),
    '/liabilities/get': (_, request_id) => ({
      body: {
        accounts: accounts().filter((a) => a.type === 'credit' || a.type === 'loan'),
        item: item(),
        liabilities: {
          credit: scenario.liabilities.filter((l) => l.kind === 'credit').map(plaidCreditLiability),
          mortgage: null,
          student: null,
        },
        request_id,
      },
    }),
    '/item/get': (_, request_id) => ({
      body: {
        item: item(),
        status: {
          transactions: {
            last_successful_update: '2026-10-20T11:00:00Z',
            last_failed_update: null,
          },
          last_webhook: null,
        },
        request_id,
      },
    }),
    '/item/remove': (_, request_id) => {
      accessToken = undefined;
      return { body: { request_id } };
    },
    '/item/webhook/update': (body, request_id) => {
      webhook = typeof body.webhook === 'string' ? body.webhook : null;
      return { body: { item: item(), request_id } };
    },
    '/webhook_verification_key/get': [
      (body, request_id) =>
        body.key_id === kid
          ? {
              body: {
                key: {
                  alg: 'ES256',
                  crv: jwk.crv,
                  kid,
                  kty: jwk.kty,
                  use: 'sig',
                  x: jwk.x,
                  y: jwk.y,
                  created_at: 1_760_000_000,
                  expired_at: null,
                },
                request_id,
              },
            }
          : error(
              { error_type: 'INVALID_INPUT', error_code: 'INVALID_WEBHOOK_VERIFICATION_KEY_ID' },
              request_id,
            ),
      { token: false },
    ],
  };

  const server = await startStubServer(
    Object.fromEntries(
      Object.entries(routes).map(([path, route]) => {
        const [handler, opts] = Array.isArray(route) ? route : [route, { token: true }];
        return [`POST ${path}`, plaid(path, handler, opts)];
      }),
    ),
  );

  return {
    url: server.url,
    clientId,
    secret,
    publicToken,
    get accessToken() {
      return 'access-sandbox-harbor-0001';
    },
    itemId,
    institutionId,
    requests: server.requests,
    webhookKey: { kid, privateKey },
    release() {
      if (released >= scenario.updates.length) throw new Error('No more updates to release');
      released++;
    },
    failNext(path, e, times = 1) {
      failures.set(path, [...(failures.get(path) ?? []), ...Array<FakePlaidError>(times).fill(e)]);
    },
    override(path, response) {
      overrides.set(path, typeof response === 'function' ? response : () => response);
    },
    close: () => server.close(),
  };
}
