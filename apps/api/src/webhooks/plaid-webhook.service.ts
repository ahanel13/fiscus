// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  PlaidClient,
  plaidWebhookAction,
  plaidWebhookBodySchema,
  PlaidWebhookKeys,
  readPlaidWebhookToken,
  verifyPlaidWebhookToken,
  resolvePlaidCredentials,
  type PlaidCredentials,
  type PlaidWebhookRejection,
} from '@fiscus/aggregation';
import { FieldCrypto } from '@fiscus/crypto';
import {
  type DbHandle,
  findPlaidItem,
  plaidWebhookKeySet,
  queuePlaidWebhook,
  recordPlaidWebhook,
} from '@fiscus/db';
import { describeError } from '@fiscus/env';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RateLimiter } from '../auth/rate-limiter.js';
import { Problem, problems } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DB } from '../database/database.module.js';

/** Requests to the receiver per client IP per minute (#84). Plaid retries a 429 later. */
export const WEBHOOK_RATE_LIMIT = { limit: 120, windowMs: 60_000 };

export interface PlaidWebhookRequest {
  /** The `Plaid-Verification` header, read case-insensitively by the framework. */
  verification: string | undefined;
  rawBody: Buffer;
  /** Fastify's parse of the same bytes; only its item id is read before verifying. */
  body: unknown;
  ip: string;
}

/**
 * Plaid's webhook receiver (#84, ADR 0008 §Sync 2). A request comes with no session, so there is
 * no member and no household context: the Item is found, its key set read, work queued and the
 * outcome counted through definer functions only (migration plaid_webhooks_access).
 *
 * Every request is checked before anything happens: its JWT's shape, `alg` ES256, `iat` within five
 * minutes, the raw body's SHA-256, then the signature (verified with `jose`), with the key Plaid serves for that `kid` to
 * the Item's own credential set (ADR 0008 §Credentials 4; the server's keys for an Item no
 * connection has). A refusal is 401, counted and logged by reason only. A verified webhook only
 * queues work (WEBHOOK-005): a sync, or a check that asks Plaid before changing anything. Bodies,
 * tokens and item ids are never logged.
 */
@Injectable()
export class PlaidWebhookService {
  readonly #logger = new Logger('PlaidWebhooks');
  /** Verification keys, cached per credential set and `kid`, fetches capped per minute. */
  keys = new PlaidWebhookKeys();
  now: () => number = Date.now;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: DbHandle,
    private readonly crypto: FieldCrypto,
    private readonly limiter: RateLimiter,
  ) {}

  async receive(req: PlaidWebhookRequest): Promise<void> {
    const url = this.config.plaidWebhookUrl;
    // Webhooks off (the default): nothing is listening here.
    if (!url) throw problems.notFound();
    const limited = await this.limiter.consume(
      `plaid-webhook:${req.ip}`,
      WEBHOOK_RATE_LIMIT.limit,
      WEBHOOK_RATE_LIMIT.windowMs,
    );
    if (!limited.allowed) throw problems.rateLimited(limited.retryAfterSeconds);

    const read = readPlaidWebhookToken(req.verification, req.rawBody, this.now());
    if (!read.ok) return this.#refuse(read.reason, null);

    // Untrusted until the signature checks out: only used to pick the keys to check it with.
    const said = (req.body as { item_id?: unknown } | null | undefined)?.item_id;
    const itemId = typeof said === 'string' && said.length <= 128 ? said : undefined;
    const item = itemId ? await findPlaidItem(this.db.db, itemId) : null;

    const keys = await this.#keysFor(itemId, item?.credentialSetId ?? null);
    if (!keys) return this.#refuse('unknown_key', item?.credentialSetId ?? null);
    const key = await this.keys.get(
      keys.set,
      read.token.kid,
      () => new PlaidClient(keys.credentials),
    );
    if (!key.found) {
      if (key.reason === 'unknown_key') return this.#refuse('unknown_key', keys.credentialSetId);
      // Plaid couldn't be asked, or key fetches are capped this minute: Plaid sends it again.
      this.#logger.warn('Plaid webhook: its key can’t be fetched now; answered 503');
      throw new Problem(503, 'webhook_key_unavailable', 'Try again later', undefined, undefined, {
        'retry-after': '60',
      });
    }
    const verified = await verifyPlaidWebhookToken(read.token, key.key, req.rawBody, this.now());
    if (!verified.ok) return this.#refuse(verified.reason, keys.credentialSetId);

    if (!item) {
      // Verified, but for an Item no connection here has (removed, or another instance's).
      await recordPlaidWebhook(this.db.db, keys.credentialSetId, 'unknown_item');
      return;
    }
    const body = plaidWebhookBodySchema.safeParse(req.body);
    const action = body.success ? plaidWebhookAction(body.data) : 'ignore';
    await recordPlaidWebhook(this.db.db, item.credentialSetId, 'verified');
    if (action !== 'ignore') await queuePlaidWebhook(this.db.db, item.connectionId, action, url);
  }

  /**
   * The keys to check a webhook with: the Item's household key set when it was made with one,
   * else the server's. None: the set is gone or unreadable, or the server has no keys.
   */
  async #keysFor(
    itemId: string | undefined,
    credentialSetId: string | null,
  ): Promise<{
    set: string;
    credentialSetId: string | null;
    credentials: PlaidCredentials;
  } | null> {
    if (credentialSetId !== null && itemId !== undefined) {
      const own = await plaidWebhookKeySet(this.db.db, this.crypto, itemId);
      if (!own || own.id !== credentialSetId) return null;
      const resolved = resolvePlaidCredentials(own.id, this.config.plaid, own);
      return resolved.available
        ? { set: `household:${own.id}`, credentialSetId: own.id, credentials: resolved.credentials }
        : null;
    }
    const resolved = resolvePlaidCredentials(null, this.config.plaid);
    if (!resolved.available) return null;
    const { credentials } = resolved;
    return {
      set: `server:${credentials.env}:${credentials.clientId}`,
      credentialSetId: null,
      credentials,
    };
  }

  /** 401, counted and logged by reason; nothing else happens. */
  async #refuse(reason: PlaidWebhookRejection, credentialSetId: string | null): Promise<never> {
    this.#logger.warn(`Refused a Plaid webhook (${reason})`);
    try {
      await recordPlaidWebhook(this.db.db, credentialSetId, reason);
    } catch (error) {
      this.#logger.error(`Counting a refused Plaid webhook failed: ${describeError(error)}`);
    }
    throw new Problem(401, 'webhook_unverified', 'This webhook couldn’t be verified');
  }
}
