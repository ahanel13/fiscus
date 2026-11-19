// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, timingSafeEqual } from 'node:crypto';
import { isProviderError } from '@fiscus/domain';
import { decodeJwt, decodeProtectedHeader, errors as joseErrors, importJWK, jwtVerify } from 'jose';
import { z } from 'zod';
import type { PlaidClient } from './client.js';

// Plaid's webhooks (#84, ADR 0008 §Sync 2): off unless the admin sets PLAID_WEBHOOK_URL. Each
// request carries a `Plaid-Verification` JWT, signed with ES256 by a key Plaid serves from
// `/webhook_verification_key/get` (WEBHOOK-003). Its payload has `iat` and the SHA-256 of the raw
// body (WEBHOOK-004). A webhook is a trigger, never data (WEBHOOK-005): what it says is checked
// against Plaid's api by the worker before anything changes.

/** The receiver's path, on the public base URL the admin sets. */
export const PLAID_WEBHOOK_PATH = '/api/v1/webhooks/plaid';
/** Plaid's bodies are small; anything bigger is refused before it's read (#84). */
export const PLAID_WEBHOOK_BODY_LIMIT = 16 * 1024;
/** A token older than this is refused, so a captured one can't be replayed later (WEBHOOK-004). */
export const PLAID_WEBHOOK_MAX_AGE_MS = 5 * 60_000;
/** How far ahead of this server's clock `iat` may be: Plaid's clock and ours differ a little. */
export const PLAID_WEBHOOK_CLOCK_SKEW_MS = 30_000;

/**
 * Why a webhook was refused. `missing`: no `Plaid-Verification` header. `malformed`: not a JWT,
 * or its claims aren't Plaid's. `algorithm`: anything but ES256 (`none` and HS256 included).
 * `stale`: `iat` too old, or too far ahead. `body_hash`: the body isn't the one that was signed.
 * `unknown_key`: Plaid has no key by that `kid`, or it has expired. `signature`: the signature
 * doesn't check out with the key.
 */
export type PlaidWebhookRejection =
  'missing' | 'malformed' | 'algorithm' | 'stale' | 'body_hash' | 'unknown_key' | 'signature';

export const PLAID_WEBHOOK_REJECTIONS: readonly PlaidWebhookRejection[] = [
  'missing',
  'malformed',
  'algorithm',
  'stale',
  'body_hash',
  'unknown_key',
  'signature',
];

/** Plaid's answer to `/webhook_verification_key/get` for a `kid` it doesn't have. */
const UNKNOWN_KEY_CODE = 'INVALID_WEBHOOK_VERIFICATION_KEY_ID';
const KID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The only algorithm Plaid signs with, and the only one accepted (WEBHOOK-003). */
const ALGORITHMS = ['ES256'];

const payloadSchema = z.object({ iat: z.number(), request_body_sha256: z.string() });

/** A webhook's JWT, read but not yet verified: its `kid` picks the key it's checked with. */
export interface PlaidWebhookToken {
  /** The compact JWT, as Plaid sent it. */
  jwt: string;
  kid: string;
}

/** The raw body's SHA-256 equals the token's, compared in constant time (WEBHOOK-004). */
const bodyMatches = (claimed: string, rawBody: Buffer): boolean =>
  SHA256_HEX.test(claimed) &&
  timingSafeEqual(Buffer.from(claimed, 'hex'), createHash('sha256').update(rawBody).digest());

/** `iat` within five minutes, and not more than the allowed skew ahead. */
const fresh = (iat: number, now: number): boolean => {
  const issuedAt = iat * 1000;
  return (
    Number.isFinite(issuedAt) &&
    now - issuedAt <= PLAID_WEBHOOK_MAX_AGE_MS &&
    issuedAt - now <= PLAID_WEBHOOK_CLOCK_SKEW_MS
  );
};

/**
 * Checks everything that needs no key, with `jose`'s decoders: a JWT's shape, `alg` exactly
 * ES256, a `kid`, `iat` within five minutes, and the raw body's SHA-256 equal to the token's
 * (constant time). Only a quick refusal, so a forgery costs no key fetch: none of it is trusted
 * until `verifyPlaidWebhookToken` has checked the signature, and checked them all again.
 */
export function readPlaidWebhookToken(
  header: string | undefined,
  rawBody: Buffer,
  now: number,
): { ok: true; token: PlaidWebhookToken } | { ok: false; reason: PlaidWebhookRejection } {
  if (header === undefined || header === '') return { ok: false, reason: 'missing' };
  if (header.length > 4096 || header.split('.').length !== 3) {
    return { ok: false, reason: 'malformed' };
  }
  let head: ReturnType<typeof decodeProtectedHeader>;
  let claims: unknown;
  try {
    head = decodeProtectedHeader(header);
    claims = decodeJwt(header);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (head.alg !== 'ES256') return { ok: false, reason: 'algorithm' };
  if (typeof head.kid !== 'string' || !KID.test(head.kid))
    return { ok: false, reason: 'malformed' };
  const payload = payloadSchema.safeParse(claims);
  if (!payload.success || !SHA256_HEX.test(payload.data.request_body_sha256)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!fresh(payload.data.iat, now)) return { ok: false, reason: 'stale' };
  if (!bodyMatches(payload.data.request_body_sha256, rawBody)) {
    return { ok: false, reason: 'body_hash' };
  }
  return { ok: true, token: { jwt: header, kid: head.kid } };
}

/**
 * The token verified with `jose` against Plaid's key (WEBHOOK-003): the ES256 signature, with
 * ES256 the only algorithm allowed, and `iat` at most five minutes old (`maxTokenAge`, with the
 * same skew allowed ahead). Then the verified payload's body hash is compared with the raw body
 * again, in constant time, so nothing from before the signature check is relied on.
 */
export async function verifyPlaidWebhookToken(
  token: PlaidWebhookToken,
  key: CryptoKey,
  rawBody: Buffer,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: PlaidWebhookRejection }> {
  let verified: unknown;
  try {
    ({ payload: verified } = await jwtVerify(token.jwt, key, {
      algorithms: ALGORITHMS,
      maxTokenAge: PLAID_WEBHOOK_MAX_AGE_MS / 1000,
      clockTolerance: PLAID_WEBHOOK_CLOCK_SKEW_MS / 1000,
      currentDate: new Date(now),
    }));
  } catch (error) {
    if (error instanceof joseErrors.JOSEAlgNotAllowed) return { ok: false, reason: 'algorithm' };
    if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, reason: 'signature' };
    }
    if (
      error instanceof joseErrors.JWTExpired ||
      (error instanceof joseErrors.JWTClaimValidationFailed && error.claim === 'iat')
    ) {
      return { ok: false, reason: 'stale' };
    }
    return { ok: false, reason: 'malformed' };
  }
  const payload = payloadSchema.safeParse(verified);
  if (!payload.success) return { ok: false, reason: 'malformed' };
  if (!fresh(payload.data.iat, now)) return { ok: false, reason: 'stale' };
  if (!bodyMatches(payload.data.request_body_sha256, rawBody)) {
    return { ok: false, reason: 'body_hash' };
  }
  return { ok: true };
}

/** What the key cache can answer: a key, none by that id, or "ask again later". */
export type PlaidWebhookKeyResult =
  | { found: true; key: CryptoKey }
  | { found: false; reason: 'unknown_key' }
  | { found: false; reason: 'unavailable' };

export interface PlaidWebhookKeysOptions {
  /** Key fetches from Plaid, per credential set, per minute (#84: key-fetch amplification). */
  fetchesPerMinute?: number;
  /** A key without `expired_at` is fetched again after this, so a rotation is seen. */
  maxAgeMs?: number;
  /** How long Plaid's "no such key" is remembered, so a made-up `kid` costs one fetch. */
  unknownForMs?: number;
  /** Entries kept at most; the oldest go first. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Plaid's verification keys, cached by (credential set, `kid`) until Plaid's `expired_at` (that's
 * rotation, WEBHOOK-003), and for a day at most otherwise. Fetching is capped per credential set
 * per minute: a flood of made-up `kid`s can't turn into a flood of Plaid requests, and an unknown
 * `kid` is remembered for a while. A capped or failed fetch is `unavailable`, which the receiver
 * answers with 503, so Plaid sends that webhook again later (WEBHOOK-007).
 */
export class PlaidWebhookKeys {
  readonly #keys = new Map<string, { key: CryptoKey | null; until: number }>();
  readonly #fetches = new Map<string, { count: number; resetAt: number }>();
  readonly #pending = new Map<string, Promise<PlaidWebhookKeyResult>>();
  readonly #fetchesPerMinute: number;
  readonly #maxAgeMs: number;
  readonly #unknownForMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: PlaidWebhookKeysOptions = {}) {
    this.#fetchesPerMinute = options.fetchesPerMinute ?? 10;
    this.#maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60_000;
    this.#unknownForMs = options.unknownForMs ?? 10 * 60_000;
    this.#maxEntries = options.maxEntries ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The key `kid` for one credential set (`set` names it: the server's, or a household's set id),
   * fetched with that set's own client when it isn't cached (ADR 0008: verified with the keys of
   * the Item's own credential set).
   */
  async get(set: string, kid: string, client: () => PlaidClient): Promise<PlaidWebhookKeyResult> {
    const id = `${set}\u0000${kid}`;
    const now = this.#now();
    const cached = this.#keys.get(id);
    if (cached && cached.until > now) {
      return cached.key
        ? { found: true, key: cached.key }
        : { found: false, reason: 'unknown_key' };
    }
    const pending = this.#pending.get(id);
    if (pending) return pending;
    if (!this.#allowFetch(set, now)) return { found: false, reason: 'unavailable' };
    const fetching = this.#fetch(id, kid, client).finally(() => this.#pending.delete(id));
    this.#pending.set(id, fetching);
    return fetching;
  }

  /** How many fetches this set has left this minute: for tests. */
  fetchesLeft(set: string): number {
    const w = this.#fetches.get(set);
    if (!w || w.resetAt <= this.#now()) return this.#fetchesPerMinute;
    return Math.max(0, this.#fetchesPerMinute - w.count);
  }

  #allowFetch(set: string, now: number): boolean {
    let w = this.#fetches.get(set);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + 60_000 };
      this.#fetches.set(set, w);
      if (this.#fetches.size > this.#maxEntries) this.#prune(this.#fetches, now, (v) => v.resetAt);
    }
    if (w.count >= this.#fetchesPerMinute) return false;
    w.count += 1;
    return true;
  }

  async #fetch(id: string, kid: string, client: () => PlaidClient): Promise<PlaidWebhookKeyResult> {
    let key: Awaited<ReturnType<PlaidClient['webhookVerificationKeyGet']>>['key'];
    try {
      ({ key } = await client().webhookVerificationKeyGet(kid));
    } catch (error) {
      // Plaid says there's no such key: remembered. Anything else is passing.
      if (isProviderError(error) && error.providerCode === UNKNOWN_KEY_CODE) {
        return this.#unknown(id);
      }
      return { found: false, reason: 'unavailable' };
    }
    const now = this.#now();
    const expiresAt = key.expired_at ? key.expired_at * 1000 : null;
    if (
      key.kid !== kid ||
      key.alg !== 'ES256' ||
      key.kty !== 'EC' ||
      key.crv !== 'P-256' ||
      (expiresAt !== null && expiresAt <= now)
    ) {
      return this.#unknown(id);
    }
    let publicKey: CryptoKey;
    try {
      // Imported by jose for ES256 only: a key of another curve or type is refused here.
      const imported = await importJWK({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, 'ES256');
      if (imported instanceof Uint8Array) return this.#unknown(id);
      publicKey = imported;
    } catch {
      return this.#unknown(id);
    }
    this.#remember(id, publicKey, Math.min(expiresAt ?? Infinity, now + this.#maxAgeMs));
    return { found: true, key: publicKey };
  }

  #unknown(id: string): PlaidWebhookKeyResult {
    this.#remember(id, null, this.#now() + this.#unknownForMs);
    return { found: false, reason: 'unknown_key' };
  }

  #remember(id: string, key: CryptoKey | null, until: number): void {
    this.#keys.delete(id);
    this.#keys.set(id, { key, until });
    if (this.#keys.size > this.#maxEntries) this.#prune(this.#keys, this.#now(), (v) => v.until);
  }

  #prune<V>(map: Map<string, V>, now: number, until: (v: V) => number): void {
    for (const [k, v] of map) if (until(v) <= now) map.delete(k);
    // Still too many: the oldest go (a Map keeps insertion order).
    for (const k of map.keys()) {
      if (map.size <= this.#maxEntries) break;
      map.delete(k);
    }
  }
}

/**
 * The fields of a webhook's body Fiscus reads, once its signature is checked: which webhook, and
 * for which Item. Nothing else in it is used (WEBHOOK-005).
 */
export const plaidWebhookBodySchema = z.object({
  webhook_type: z.string().max(64),
  webhook_code: z.string().max(64),
  item_id: z.string().min(1).max(128).optional(),
});
export type PlaidWebhookBody = z.infer<typeof plaidWebhookBodySchema>;

/**
 * What a webhook asks the worker to do (#84). `sync`: new data is ready (TXN-003, LIAB-004).
 * `check`: something about the Item changed (an error, a login fixed, consent ending, permission
 * revoked, new accounts): the worker asks Plaid (`/item/get`, then a sync) before changing
 * anything, since the webhook's own error code is never trusted (WEBHOOK-006). `acknowledged`:
 * Plaid confirmed the Item's new webhook URL. `ignore`: anything else, answered 200.
 */
export type PlaidWebhookAction = 'sync' | 'check' | 'acknowledged' | 'ignore';

const ACTIONS: Record<string, Record<string, PlaidWebhookAction>> = {
  TRANSACTIONS: { SYNC_UPDATES_AVAILABLE: 'sync' },
  LIABILITIES: { DEFAULT_UPDATE: 'sync' },
  ITEM: {
    ERROR: 'check',
    LOGIN_REPAIRED: 'check',
    PENDING_DISCONNECT: 'check',
    PENDING_EXPIRATION: 'check',
    USER_PERMISSION_REVOKED: 'check',
    USER_ACCOUNT_REVOKED: 'check',
    NEW_ACCOUNTS_AVAILABLE: 'check',
    WEBHOOK_UPDATE_ACKNOWLEDGED: 'acknowledged',
  },
};

export function plaidWebhookAction(
  body: Pick<PlaidWebhookBody, 'webhook_type' | 'webhook_code'>,
): PlaidWebhookAction {
  // Own keys only: `constructor` or `__proto__` from a body must not reach Object's.
  if (!Object.hasOwn(ACTIONS, body.webhook_type)) return 'ignore';
  const codes = ACTIONS[body.webhook_type]!;
  return Object.hasOwn(codes, body.webhook_code) ? codes[body.webhook_code]! : 'ignore';
}
