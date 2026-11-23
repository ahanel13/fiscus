// SPDX-License-Identifier: AGPL-3.0-or-later
import { type PlaidClient, resolvePlaidCredentials } from '@fiscus/aggregation';
import { isProviderError } from '@fiscus/domain';
import type { PlaidTestWebhook } from '@fiscus/shared';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { RateLimiter } from '../auth/rate-limiter.js';
import { problems } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { plaidClientFor, plaidProblem } from '../connections/plaid.js';

/** Plaid's sandbox test bank (First Platypus Bank), where the test Item is made. */
export const TEST_WEBHOOK_INSTITUTION = 'ins_109508';
/** What's fired: a transactions update, which every Item made with transactions can send. */
export const TEST_WEBHOOK = { type: 'TRANSACTIONS', code: 'DEFAULT_UPDATE' } as const;
/** The test Item is removed this long after, once Plaid has had time to send the webhook. */
export const TEST_ITEM_REMOVE_AFTER_MS = 5 * 60_000;
/** At most this many tests a minute, across the server. */
export const TEST_WEBHOOK_RATE_LIMIT = { limit: 3, windowMs: 60_000 };

/**
 * "Send a test webhook" (#85, SANDBOX-005): in sandbox only, with webhooks on, an Item is made at
 * Plaid's test bank with the server's keys and this server's webhook URL (SANDBOX-003, no Link),
 * and Plaid is asked to fire a webhook at it. It arrives at the receiver like any other, verified
 * with the server's keys and counted as an unknown Item (no connection has it), so the panel shows
 * it arrive without touching any household's connection. The Item is removed a few minutes later,
 * or when the api stops. Never in production: the route answers 404 there.
 */
@Injectable()
export class PlaidTestWebhookService implements OnModuleDestroy {
  readonly #logger = new Logger('PlaidTestWebhook');
  /** Test Items still to remove, with their timers. */
  readonly #pending = new Map<NodeJS.Timeout, () => Promise<void>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly limiter: RateLimiter,
  ) {}

  /** Sandbox keys, and webhooks on. */
  get available(): boolean {
    return this.config.plaid?.env === 'sandbox' && !!this.config.plaidWebhookUrl;
  }

  async fire(): Promise<PlaidTestWebhook> {
    const url = this.config.plaidWebhookUrl;
    if (!this.available || !url) throw problems.notFound();
    const limited = await this.limiter.consume(
      'plaid-test-webhook',
      TEST_WEBHOOK_RATE_LIMIT.limit,
      TEST_WEBHOOK_RATE_LIMIT.windowMs,
    );
    if (!limited.allowed) throw problems.rateLimited(limited.retryAfterSeconds);

    const { client } = plaidClientFor(resolvePlaidCredentials(null, this.config.plaid));
    // Before anything is made: a webhook Plaid sends for the new Item on its own counts too.
    const firedAt = new Date().toISOString();
    try {
      const { public_token } = await client.sandboxPublicTokenCreate(
        TEST_WEBHOOK_INSTITUTION,
        ['transactions'],
        { webhook: url },
      );
      const { access_token } = await client.itemPublicTokenExchange(public_token);
      try {
        await client.sandboxItemFireWebhook(access_token, TEST_WEBHOOK.type, TEST_WEBHOOK.code);
      } finally {
        this.#removeLater(client, access_token);
      }
    } catch (err) {
      plaidProblem(err);
    }
    return { firedAt };
  }

  async onModuleDestroy(): Promise<void> {
    const removals = [...this.#pending].map(([timer, remove]) => {
      clearTimeout(timer);
      return remove();
    });
    this.#pending.clear();
    await Promise.allSettled(removals);
  }

  #removeLater(client: PlaidClient, accessToken: string): void {
    const remove = async () => {
      try {
        await client.itemRemove(accessToken);
      } catch (err) {
        // The code only; a sandbox Item left behind costs nothing.
        this.#logger.warn(
          `Removing the test webhook's sandbox Item failed: ${isProviderError(err) ? err.providerCode : 'internal'}`,
        );
      }
    };
    const timer = setTimeout(() => {
      this.#pending.delete(timer);
      void remove();
    }, TEST_ITEM_REMOVE_AFTER_MS);
    timer.unref();
    this.#pending.set(timer, remove);
  }
}
