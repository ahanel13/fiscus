// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { ProviderError, type ProviderErrorKind } from '@fiscus/domain';
import { type SimpleFinAccountSet, simpleFinAccountSetSchema } from './schemas.js';

// The SimpleFIN Bridge protocol (#91, https://www.simplefin.org/protocol.html), over `fetch`.
// A setup token is a base64 URL, claimed once with a POST that answers with the access URL; the
// access URL carries Basic credentials and serves GET /accounts. Both are user-supplied URLs the
// server then requests (threat model: outbound requests), so before any request each must be
// https on a host this server allows, and the access URL on the claim's host. No redirects, a
// timeout and a size cap; the credentials never appear in an error, a log, or this object.

/** The Bridge's hosts. `SIMPLEFIN_BRIDGE_HOSTS` replaces the list. */
export const SIMPLEFIN_BRIDGE_HOSTS = ['bridge.simplefin.org', 'beta-bridge.simplefin.org'];
/** The protocol version asked for: `errlist`, `connections`, and accounts' `conn_id`. */
export const SIMPLEFIN_VERSION = '2';

export interface SimpleFinClientOptions {
  /** Hosts a token may point at. Defaults to {@link SIMPLEFIN_BRIDGE_HOSTS}. */
  allowedHosts?: readonly string[];
  /** Tests only: allow http, for a local stub. */
  allowHttp?: boolean;
  /** Per request, including reading the body. Defaults to 15 s. */
  timeoutMs?: number;
  /** The largest response read. Defaults to 10 MB. */
  maxBytes?: number;
  fetch?: typeof fetch;
}

/** A token or URL this server won't use, said in words for the person (no URL in them). */
export class SimpleFinTokenError extends Error {
  constructor(
    readonly code: 'not_a_token' | 'host_not_allowed' | 'token_used',
    message: string,
  ) {
    super(message);
    this.name = 'SimpleFinTokenError';
  }
}

const error = (kind: ProviderErrorKind, code: string, retryAfterMs?: number) =>
  new ProviderError(kind, {
    providerCode: code,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

/** A URL the server may request, or a `SimpleFinTokenError` saying why not. */
export function allowedUrl(
  raw: string,
  options: Pick<SimpleFinClientOptions, 'allowedHosts' | 'allowHttp'> = {},
  sameHostAs?: URL,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SimpleFinTokenError('not_a_token', 'This isn’t a SimpleFIN setup token.');
  }
  const protocols = options.allowHttp ? ['https:', 'http:'] : ['https:'];
  const hosts = options.allowedHosts ?? SIMPLEFIN_BRIDGE_HOSTS;
  if (
    !protocols.includes(url.protocol) ||
    !hosts.includes(url.hostname.toLowerCase()) ||
    (sameHostAs && url.host !== sameHostAs.host)
  ) {
    throw new SimpleFinTokenError(
      'host_not_allowed',
      'This token points somewhere other than the SimpleFIN Bridge, so Fiscus won’t use it.',
    );
  }
  return url;
}

/** The claim URL inside a setup token (base64 of a URL), checked before anything is requested. */
export function decodeSetupToken(
  token: string,
  options: Pick<SimpleFinClientOptions, 'allowedHosts' | 'allowHttp'> = {},
): URL {
  const trimmed = token.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed) || trimmed.length > 2000) {
    throw new SimpleFinTokenError('not_a_token', 'This isn’t a SimpleFIN setup token.');
  }
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  if (!/^https?:\/\//.test(decoded)) {
    throw new SimpleFinTokenError('not_a_token', 'This isn’t a SimpleFIN setup token.');
  }
  return allowedUrl(decoded, options);
}

/** Reads a response's body up to `maxBytes`, or fails as too large. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw error('transient', 'RESPONSE_TOO_LARGE');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw error('transient', 'RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function request(
  url: URL,
  init: RequestInit,
  options: SimpleFinClientOptions,
): Promise<{ status: number; body: string; retryAfter: string | null }> {
  const fetcher = options.fetch ?? fetch;
  try {
    const response = await fetcher(url, {
      ...init,
      // A redirect would send the credentials somewhere else: refuse it.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const body = await readCapped(response, options.maxBytes ?? 10 * 1024 * 1024);
    return { status: response.status, body, retryAfter: response.headers.get('retry-after') };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    // No cause: what fetch reports can quote the URL, credentials and all.
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw error('transient', timedOut ? 'TIMEOUT' : 'NETWORK_ERROR');
  }
}

/**
 * Claims a setup token, once: the access URL it answers with, checked to be on the claim's host.
 * A token already used (403) can't be claimed again: a new one comes from the Bridge.
 */
export async function claimSetupToken(
  token: string,
  options: SimpleFinClientOptions = {},
): Promise<string> {
  const claim = decodeSetupToken(token, options);
  const { status, body } = await request(claim, { method: 'POST' }, options);
  if (status === 403) {
    throw new SimpleFinTokenError(
      'token_used',
      'This token has been used. Create a new one at the SimpleFIN Bridge.',
    );
  }
  if (status !== 200) throw error('transient', `HTTP_${status}`);
  const access = allowedUrl(body.trim(), options, claim);
  if (!access.username || !access.password) throw error('transient', 'INVALID_RESPONSE');
  return access.toString();
}

/**
 * An id for a token's connection that's stable and says nothing: a hash of the access URL's
 * username (the Bridge's id for the token), never the credentials themselves.
 */
export const simpleFinItemId = (accessUrl: string): string =>
  `sfin-${createHash('sha256').update(new URL(accessUrl).username).digest('hex').slice(0, 32)}`;

export interface AccountsRequest {
  /** Epoch seconds: transactions on or after. */
  startDate?: number;
  pending?: boolean;
  balancesOnly?: boolean;
}

/** GET /accounts on one access URL. */
export class SimpleFinClient {
  readonly #base: URL;
  readonly #authorization: string;
  readonly #options: SimpleFinClientOptions;

  constructor(accessUrl: string, options: SimpleFinClientOptions = {}) {
    const url = allowedUrl(accessUrl, options);
    this.#authorization = `Basic ${Buffer.from(
      `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
    ).toString('base64')}`;
    url.username = '';
    url.password = '';
    this.#base = url;
    this.#options = options;
  }

  async accounts(req: AccountsRequest = {}): Promise<SimpleFinAccountSet> {
    const url = new URL(`${this.#base.pathname.replace(/\/+$/, '')}/accounts`, this.#base);
    url.searchParams.set('version', SIMPLEFIN_VERSION);
    if (req.startDate !== undefined) url.searchParams.set('start-date', String(req.startDate));
    if (req.pending) url.searchParams.set('pending', '1');
    if (req.balancesOnly) url.searchParams.set('balances-only', '1');
    const { status, body, retryAfter } = await request(
      url,
      { method: 'GET', headers: { authorization: this.#authorization } },
      this.#options,
    );
    if (status === 403) throw error('login_required', 'SIMPLEFIN_ACCESS_REVOKED');
    if (status === 402) throw error('consent_expired', 'SIMPLEFIN_PAYMENT_REQUIRED');
    if (status === 429) {
      const seconds = Number(retryAfter);
      throw error(
        'rate_limited',
        'SIMPLEFIN_RATE_LIMITED',
        Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined,
      );
    }
    if (status !== 200) throw error('transient', `HTTP_${status}`);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw error('transient', 'INVALID_RESPONSE');
    }
    const parsed = simpleFinAccountSetSchema.safeParse(json);
    // The zod error would quote the response (names, amounts): only the code goes on.
    if (!parsed.success) throw error('transient', 'INVALID_RESPONSE');
    return parsed.data;
  }

  toString(): string {
    return `SimpleFinClient(${this.#base.host})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }

  toJSON(): { host: string } {
    return { host: this.#base.host };
  }
}
