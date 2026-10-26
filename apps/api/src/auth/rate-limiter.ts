// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters (#377). With `VALKEY_URL` they're kept in Valkey, so a limit holds across
 * api replicas and restarts. Without it, or while Valkey can't be reached, they're kept in this
 * process's memory: right for one instance, and still a limit per instance when Valkey is down.
 */
@Injectable()
export class RateLimiter implements OnModuleInit, OnModuleDestroy {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  readonly #valkey: Redis | null;
  readonly #logger = new Logger('RateLimiter');
  #valkeyDown = false;
  /** The memory counters' clock. */
  now: () => number = Date.now;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.#valkey = config.valkeyUrl
      ? new Redis(config.valkeyUrl, {
          keyPrefix: 'fiscus:rate:',
          // A request waits on a limit, so a down Valkey fails fast into the fallback.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          commandTimeout: 1_000,
        })
      : null;
    // ioredis reconnects by itself; without a listener, its errors would be unhandled.
    this.#valkey?.on('error', () => this.#down());
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    if (this.#valkey) {
      try {
        return await this.#consumeShared(this.#valkey, key, limit, windowMs);
      } catch {
        this.#down();
      }
    }
    return this.#consumeHere(key, limit, windowMs);
  }

  async reset(key: string): Promise<void> {
    this.#windows.delete(key);
    try {
      await this.#valkey?.del(key);
    } catch {
      this.#down();
    }
  }

  /** Starts serving once connected, or after 2 seconds of trying, so it counts there at once. */
  async onModuleInit(): Promise<void> {
    const valkey = this.#valkey;
    if (!valkey || valkey.status === 'ready') return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        valkey.off('ready', done).off('error', done);
        resolve();
      };
      const timer = setTimeout(done, 2_000);
      valkey.once('ready', done).once('error', done);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.#valkey?.disconnect();
  }

  async #consumeShared(
    valkey: Redis,
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult> {
    // One transaction: the window starts with the first request, and every replica counts in it.
    const replies = await valkey
      .multi()
      .set(key, 0, 'PX', windowMs, 'NX')
      .incr(key)
      .pttl(key)
      .exec();
    const error = replies?.find(([e]) => e)?.[0];
    if (!replies || error) throw error ?? new Error('transaction aborted');
    const count = replies[1]![1] as number;
    const ttl = replies[2]![1] as number;
    if (this.#valkeyDown) {
      this.#valkeyDown = false;
      this.#logger.log('Valkey is back: rate limits are shared again.');
    }
    return {
      allowed: count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000)),
    };
  }

  #consumeHere(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = this.now();
    let w = this.#windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.#windows.set(key, w);
      if (this.#windows.size > 50_000) this.#prune(now);
    }
    w.count += 1;
    return {
      allowed: w.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
    };
  }

  /** Said once per outage, not per request. */
  #down(): void {
    if (this.#valkeyDown) return;
    this.#valkeyDown = true;
    this.#logger.warn(
      'Valkey can’t be reached: rate limits are counted in this api process until it’s back.',
    );
  }

  #prune(now: number): void {
    for (const [k, w] of this.#windows) if (w.resetAt <= now) this.#windows.delete(k);
  }
}
