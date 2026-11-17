// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { isProviderError } from '@fiscus/domain';
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
const B64URL = /^[A-Za-z0-9_-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const headerSchema = z.object({
  alg: z.string(),
  kid: z.string().optional(),
  typ: z.string().optional(),
});
const payloadSchema = z.object({ iat: z.number(), request_body_sha256: z.string() });

/** The unverified parts of a JWT, once it has the shape of one. */
export interface PlaidWebhookToken {
  kid: string;
  iat: number;
  bodySha256: string;
  signingInput: Buffer;
  signature: Buffer;
}

const decodePart = (part: string): unknown => {
  if (!B64URL.test(part)) return undefined;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
};

/**
 * Checks everything that needs no key: the header's shape, `alg` exactly ES256, `iat` within five
 * minutes, and the body's SHA-256 (of the raw bytes, compared in constant time) equal to the
 * token's. These are only a quick refusal: none of it is trusted until the signature is checked.
 */
export function readPlaidWebhookToken(
  header: string | undefined,
  rawBody: Buffer,
  now: number,
): { ok: true; token: PlaidWebhookToken } | { ok: false; reason: PlaidWebhookRejection } {
  if (header === undefined || header === '') return { ok: false, reason: 'missing' };
  const parts = header.split('.');
  if (parts.length !== 3 || header.length > 4096) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  const head = headerSchema.safeParse(decodePart(h));
  if (!head.success) return { ok: false, reason: 'malformed' };
  if (head.data.alg !== 'ES256') return { ok: false, reason: 'algorithm' };
  if (!head.data.kid || !KID.test(head.data.kid)) return { ok: false, reason: 'malformed' };
  const payload = payloadSchema.safeParse(decodePart(p));
  if (!payload.success || !SHA256_HEX.test(payload.data.request_body_sha256)) {
    return { ok: false, reason: 'malformed' };
  }
  const issuedAt = payload.data.iat * 1000;
  if (
    !Number.isFinite(issuedAt) ||
    now - issuedAt > PLAID_WEBHOOK_MAX_AGE_MS ||
    issuedAt - now > PLAID_WEBHOOK_CLOCK_SKEW_MS
  ) {
    return { ok: false, reason: 'stale' };
  }
  const expected = Buffer.from(payload.data.request_body_sha256, 'hex');
  const actual = createHash('sha256').update(rawBody).digest();
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: 'body_hash' };
  if (!B64URL.test(s)) return { ok: false, reason: 'malformed' };
  const signature = Buffer.from(s, 'base64url');
  // ES256's signature is r and s, 32 bytes each (JWS, RFC 7518 §3.4).
  if (signature.length !== 64) return { ok: false, reason: 'signature' };
  return {
    ok: true,
    token: {
      kid: head.data.kid,
      iat: payload.data.iat,
      bodySha256: payload.data.request_body_sha256,
      signingInput: Buffer.from(`${h}.${p}`, 'ascii'),
      signature,
    },
  };
}

/** The token's ES256 signature, checked with node:crypto against Plaid's key. */
export const plaidWebhookSignatureValid = (token: PlaidWebhookToken, key: KeyObject): boolean => {
  try {
    return verify(
      'sha256',
      token.signingInput,
      { key, dsaEncoding: 'ieee-p1363' },
      token.signature,
    );
  } catch {
    return false;
  }
};

/** What the key cache can answer: a key, none by that id, or "ask again later". */
export type PlaidWebhookKeyResult =
  | { found: true; key: KeyObject }
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
  readonly #keys = new Map<string, { key: KeyObject | null; until: number }>();
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
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y },
        format: 'jwk',
      });
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

  #remember(id: string, key: KeyObject | null, until: number): void {
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
