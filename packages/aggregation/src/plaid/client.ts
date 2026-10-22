// SPDX-License-Identifier: AGPL-3.0-or-later
import { inspect } from 'node:util';
import type { z } from 'zod';
import { plaidBaseUrl, type PlaidEnvironment } from './config.js';
import type { PlaidCredentials } from './credentials.js';
import { plaidProviderError, plaidTransportError } from './errors.js';
import {
  accountsGetResponseSchema,
  emptyResponseSchema,
  institutionsGetByIdResponseSchema,
  itemGetResponseSchema,
  itemWebhookUpdateResponseSchema,
  liabilitiesGetResponseSchema,
  linkTokenCreateResponseSchema,
  plaidErrorSchema,
  publicTokenExchangeResponseSchema,
  transactionsSyncResponseSchema,
  webhookVerificationKeyGetResponseSchema,
} from './schemas.js';

/** The api version every request asks for, so a Plaid default change can't change responses. */
export const PLAID_API_VERSION = '2020-09-14';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface PlaidClientOptions extends PlaidCredentials {
  /** Per request, including reading the response. Defaults to 30 s. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

/** `/link/token/create`'s body, without the keys. Update mode passes `access_token`. */
export interface LinkTokenCreateRequest {
  client_name: string;
  language: string;
  country_codes: string[];
  user: { client_user_id: string };
  products?: string[];
  optional_products?: string[];
  additional_consented_products?: string[];
  access_token?: string;
  webhook?: string;
  redirect_uri?: string;
  transactions?: { days_requested?: number };
  update?: { account_selection_enabled?: boolean };
}

export interface TransactionsSyncRequest {
  /** Omitted (or empty) on the first sync. */
  cursor?: string | null;
  /** 1 to 500; Plaid's default is 100. */
  count?: number;
  options?: { days_requested?: number; include_original_description?: boolean };
}

/**
 * A small client for the Plaid endpoints Fiscus uses (#82), over `fetch`, without Plaid's SDK.
 * Responses are checked against zod schemas of the fields Fiscus reads. Failures are always a
 * `ProviderError`: Plaid's `error_type` and `error_code` become its kind and code, Plaid's message
 * stays the untrusted `providerMessage`, and neither the secret nor an access token is ever in an
 * error, a log, or this object's printed form.
 *
 * It speaks Plaid's terms (snake_case, Plaid's sign); the adapter translates (#80).
 */
export class PlaidClient {
  readonly env: PlaidEnvironment;
  readonly clientId: string;
  readonly baseUrl: string;
  readonly #secret: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: PlaidClientOptions) {
    this.env = options.env;
    this.clientId = options.clientId;
    // The override is honored only in sandbox: production keys never go to another host.
    this.baseUrl = plaidBaseUrl(options.env, options.apiBaseUrl);
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
  }

  linkTokenCreate(request: LinkTokenCreateRequest) {
    return this.#post('/link/token/create', request, linkTokenCreateResponseSchema);
  }

  itemPublicTokenExchange(publicToken: string) {
    return this.#post(
      '/item/public_token/exchange',
      { public_token: publicToken },
      publicTokenExchangeResponseSchema,
    );
  }

  accountsGet(accessToken: string) {
    return this.#post('/accounts/get', { access_token: accessToken }, accountsGetResponseSchema);
  }

  institutionsGetById(institutionId: string, countryCodes: string[]) {
    return this.#post(
      '/institutions/get_by_id',
      {
        institution_id: institutionId,
        country_codes: countryCodes,
        options: { include_optional_metadata: true },
      },
      institutionsGetByIdResponseSchema,
    );
  }

  transactionsSync(accessToken: string, request: TransactionsSyncRequest = {}) {
    const { cursor, ...rest } = request;
    return this.#post(
      '/transactions/sync',
      { access_token: accessToken, ...(cursor ? { cursor } : {}), ...rest },
      transactionsSyncResponseSchema,
    );
  }

  transactionsRefresh(accessToken: string) {
    return this.#post('/transactions/refresh', { access_token: accessToken }, emptyResponseSchema);
  }

  liabilitiesGet(accessToken: string) {
    return this.#post(
      '/liabilities/get',
      { access_token: accessToken },
      liabilitiesGetResponseSchema,
    );
  }

  itemGet(accessToken: string) {
    return this.#post('/item/get', { access_token: accessToken }, itemGetResponseSchema);
  }

  itemRemove(accessToken: string) {
    return this.#post('/item/remove', { access_token: accessToken }, emptyResponseSchema);
  }

  itemWebhookUpdate(accessToken: string, webhook: string) {
    return this.#post(
      '/item/webhook/update',
      { access_token: accessToken, webhook },
      itemWebhookUpdateResponseSchema,
    );
  }

  webhookVerificationKeyGet(keyId: string) {
    return this.#post(
      '/webhook_verification_key/get',
      { key_id: keyId },
      webhookVerificationKeyGetResponseSchema,
    );
  }

  async #post<S extends z.ZodType>(path: string, body: object, schema: S): Promise<z.infer<S>> {
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'plaid-version': PLAID_API_VERSION },
        body: JSON.stringify({ client_id: this.clientId, secret: this.#secret, ...body }),
        // A redirect would resend the keys somewhere else: refuse it.
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      // No cause attached: what fetch reports can name the request, and nothing past here needs it.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw plaidTransportError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR');
    }

    const json = parseJson(text);
    if (!response.ok) {
      const error = plaidErrorSchema.safeParse(json);
      const retryAfter = response.headers.get('retry-after');
      if (error.success) throw plaidProviderError(error.data, retryAfter);
      throw plaidTransportError(`HTTP_${response.status}`, {
        status: response.status,
        retryAfter,
      });
    }
    const parsed = schema.safeParse(json);
    // The zod error would quote the response (names, amounts): only the code goes on.
    if (!parsed.success) throw plaidTransportError('INVALID_RESPONSE');
    return parsed.data;
  }

  toString(): string {
    return `PlaidClient(${this.env}, ${this.baseUrl})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }

  toJSON(): { env: PlaidEnvironment; baseUrl: string } {
    return { env: this.env, baseUrl: this.baseUrl };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
