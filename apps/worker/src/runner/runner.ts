// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProviderRegistry } from '@fiscus/aggregation';
import type { FieldCrypto } from '@fiscus/crypto';
import type { Database } from '@fiscus/db';
import { describeError } from '@fiscus/env';
import { Logger } from '@nestjs/common';
import { failureOf, FAILURE, JobFailure, jobKindFor, type JobHandlers } from './jobs.js';
import {
  abandonSetups,
  claimDue,
  finishJob,
  readTarget,
  syncIntervalHours,
  type Claimed,
} from './queue.js';
import { backoffDelayMs, nextSyncDelayMs } from './schedule.js';

export interface RunnerOptions {
  /** Between passes. */
  pollMs: number;
  /** Jobs running at once; a pass claims only as many as are free. */
  concurrency: number;
  /** How long a claim holds a connection. Longer than `jobTimeoutMs`, so a lease outlives its job. */
  leaseMs: number;
  /** A job taking longer fails as `timeout`, and is backed off. */
  jobTimeoutMs: number;
  /** On shutdown, how long running jobs get to finish before their leases are released. */
  shutdownTimeoutMs: number;
  /** A connection still in `setup` this long was abandoned: it's ended at the provider (#81). */
  abandonSetupsAfterMs: number;
  /** How often a pass looks for abandoned setups. */
  abandonCheckEveryMs: number;
  /** Overrides `sync.intervalHours` (SYNC_INTERVAL_HOURS). */
  intervalHours?: number;
  random?: () => number;
  /** The runner's own clock, for readiness. Due times are the database's. */
  now?: () => Date;
  /** Waits between passes; resolves early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = {
  pollMs: 5_000,
  concurrency: 4,
  leaseMs: 15 * 60_000,
  jobTimeoutMs: 10 * 60_000,
  shutdownTimeoutMs: 30_000,
  abandonSetupsAfterMs: 24 * 60 * 60_000,
  abandonCheckEveryMs: 60 * 60_000,
};

export interface RunnerDeps {
  db: Database;
  crypto: FieldCrypto;
  providers: ProviderRegistry;
  handlers: JobHandlers;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

/** What readiness reports about the loop. */
export interface RunnerStatus {
  /** A pass finished recently, and the runner isn't stopping. */
  healthy: boolean;
  lastPassAt: string | null;
  runningJobs: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

const minutes = (ms: number) => `${Math.round(ms / 6_000) / 10} min`;

/**
 * The worker's scheduling loop (#81): every `pollMs`, claims the connections that are due (leased,
 * so two runners never run one at once), runs each one's job, and schedules the next: the sync
 * interval after a success, a backoff after a failure. One job failing never stops the others or
 * the loop. Logs carry connection ids and codes only.
 */
export class Runner {
  readonly #options: RunnerOptions;
  readonly #deps: RunnerDeps;
  readonly #logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  readonly #running = new Map<string, Promise<void>>();
  /** Leases given back on shutdown: their jobs, if they still finish, don't touch them. */
  readonly #released = new Set<string>();
  readonly #abort = new AbortController();
  #loop: Promise<void> | undefined;
  #lastPassAt: Date | null = null;
  #lastAbandonCheckAt: Date | null = null;

  constructor(deps: RunnerDeps, options: Partial<RunnerOptions> = {}) {
    this.#deps = deps;
    this.#options = { ...DEFAULT_RUNNER_OPTIONS, ...options };
    this.#logger = deps.logger ?? new Logger('Runner');
  }

  get #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  get stopping(): boolean {
    return this.#abort.signal.aborted;
  }

  status(): RunnerStatus {
    const staleAfter = Math.max(3 * this.#options.pollMs, 60_000);
    const last = this.#lastPassAt;
    return {
      healthy:
        !this.stopping && last !== null && this.#now.getTime() - last.getTime() <= staleAfter,
      lastPassAt: last?.toISOString() ?? null,
      runningJobs: this.#running.size,
    };
  }

  /** Starts the loop: a pass now, then one every `pollMs`. */
  start(): void {
    if (this.#loop || this.stopping) return;
    const wait = this.#options.sleep ?? sleep;
    this.#loop = (async () => {
      while (!this.stopping) {
        try {
          await this.pass();
        } catch (error) {
          this.#logger.error(`Pass failed: ${describeError(error)}`);
        }
        if (!this.stopping) await wait(this.#options.pollMs, this.#abort.signal);
      }
    })();
  }

  /**
   * One pass: claims up to the free job slots and starts their jobs, without waiting for them
   * (`idle()` does). The interval is read each pass, so an admin's change applies to the next sync.
   */
  async pass(): Promise<void> {
    if (this.stopping) return;
    await this.#abandonSetups();
    const free = this.#options.concurrency - this.#running.size;
    if (free > 0) {
      const intervalHours = this.#options.intervalHours ?? (await syncIntervalHours(this.#deps.db));
      const claimed = await claimDue(this.#deps.db, free, this.#options.leaseMs);
      for (const c of claimed) {
        const job = this.#run(c, intervalHours).finally(() => this.#running.delete(c.connectionId));
        this.#running.set(c.connectionId, job);
      }
    }
    this.#lastPassAt = this.#now;
  }

  /**
   * Now and then, setups nobody finished become disconnects, which the next passes end at the
   * provider (so they aren't paid for). A failure here doesn't stop syncing.
   */
  async #abandonSetups(): Promise<void> {
    const now = this.#now;
    const last = this.#lastAbandonCheckAt;
    if (last && now.getTime() - last.getTime() < this.#options.abandonCheckEveryMs) return;
    this.#lastAbandonCheckAt = now;
    try {
      const n = await abandonSetups(this.#deps.db, this.#options.abandonSetupsAfterMs);
      if (n) this.#logger.log(`Ended ${n} abandoned setup${n === 1 ? '' : 's'}`);
    } catch (error) {
      this.#logger.error(`Ending abandoned setups failed: ${describeError(error)}`);
    }
  }

  /** Resolves once every job started so far has finished. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running.values()]);
  }

  /**
   * Stops claiming, gives running jobs up to `shutdownTimeoutMs` to finish, then releases the
   * leases of any still running, so another worker picks them up without waiting for them to
   * expire.
   */
  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#options.shutdownTimeoutMs);
    });
    const result = await Promise.race([this.idle().then(() => 'idle' as const), timedOut]);
    clearTimeout(timer);
    if (result === 'idle') return;
    for (const connectionId of [...this.#running.keys()]) {
      this.#released.add(connectionId);
      try {
        await finishJob(this.#deps.db, connectionId, { outcome: 'released' });
        this.#logger.warn(`Released ${connectionId}, unfinished at shutdown`);
      } catch (error) {
        this.#logger.error(`Releasing ${connectionId} failed: ${describeError(error)}`);
      }
    }
  }

  async #run(claimed: Claimed, intervalHours: number): Promise<void> {
    const id = claimed.connectionId;
    const { db, crypto, providers, handlers } = this.#deps;
    let failuresBefore = 0;
    let kind = 'job';
    try {
      const target = await readTarget(db, claimed);
      if (!target) return; // Deleted since it was claimed: nothing to finish.
      failuresBefore = target.consecutiveFailures;
      const jobKind = jobKindFor(target);
      if (!jobKind) {
        await this.#finish(id, { outcome: target.status === 'disconnected' ? 'done' : 'released' });
        return;
      }
      kind = jobKind;
      const handler = handlers.get(jobKind);
      if (!handler) throw new JobFailure(FAILURE.providerUnavailable);
      const outcome = await this.#withTimeout(handler.run({ ...target, db, crypto, providers }));
      if (outcome === 'done') {
        await this.#finish(id, { outcome: 'done' });
        this.#logger.log(`${kind} ${id}: done`);
      } else {
        const nextInMs = nextSyncDelayMs(intervalHours, this.#options.random);
        await this.#finish(id, { outcome: 'synced', nextInMs });
        this.#logger.log(`${kind} ${id}: ok, next in ${minutes(nextInMs)}`);
      }
    } catch (error) {
      const failure = failureOf(error);
      const nextInMs = backoffDelayMs(failuresBefore, intervalHours, this.#options.random);
      if (!failure.expected) this.#logger.error(`${kind} ${id}: ${describeError(error)}`);
      try {
        await this.#finish(id, {
          outcome: 'failed',
          nextInMs,
          status: failure.status,
          code: failure.code,
        });
        // Plaid's request id is safe to log, and what its support asks for (DATA-006).
        const request = failure.requestId ? `, request ${failure.requestId}` : '';
        this.#logger.warn(
          `${kind} ${id} failed (${failure.code}${request}), retry in ${minutes(nextInMs)}`,
        );
      } catch (finishing) {
        // The lease expires on its own; the connection is claimed again then.
        this.#logger.error(
          `${kind} ${id}: recording the failure failed: ${describeError(finishing)}`,
        );
      }
    }
  }

  async #finish(connectionId: string, f: Parameters<typeof finishJob>[2]): Promise<void> {
    if (this.#released.has(connectionId)) return;
    await finishJob(this.#deps.db, connectionId, f);
  }

  async #withTimeout<T>(job: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new JobFailure(FAILURE.timeout)), this.#options.jobTimeoutMs);
    });
    try {
      return await Promise.race([job, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
