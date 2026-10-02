import { Injectable } from '@nestjs/common';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters held in memory. Correct for a single api instance; a Redis-backed
 * implementation replaces it when job queues bring Valkey into use (M2), so limits hold across
 * replicas.
 */
@Injectable()
export class RateLimiter {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  now: () => number = Date.now;

  consume(key: string, limit: number, windowMs: number): RateLimitResult {
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

  reset(key: string): void {
    this.#windows.delete(key);
  }

  #prune(now: number): void {
    for (const [k, w] of this.#windows) if (w.resetAt <= now) this.#windows.delete(k);
  }
}
