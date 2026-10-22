// SPDX-License-Identifier: AGPL-3.0-or-later
import { ProviderRegistry } from '@fiscus/aggregation';
import { FakeAggregationProvider, FakeClock, riveraAccounts } from '@fiscus/aggregation/testing';
import { ProviderError, type SyncPage } from '@fiscus/domain';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWorkerHarness, until, type WorkerHarness } from '../testing/harness.js';
import { WorkerModule } from '../worker.module.js';
import { DEFAULT_JOB_HANDLERS } from './handlers.js';
import { JobHandlers } from './jobs.js';
import { Runner, type RunnerOptions } from './runner.js';

/**
 * The worker's runner (#81) against Postgres, logged in as the real fiscus_worker role: what it
 * claims, what it runs, and when each connection is next due.
 */

/** The fake, with calls recorded by secret, and failures and pauses a test turns on. */
class TestProvider extends FakeAggregationProvider {
  readonly synced: string[] = [];
  readonly removed: string[] = [];
  readonly #active = new Set<string>();
  /** Times one connection's job ran while another for it was still running. */
  overlaps = 0;
  syncFailure: Error | null = null;
  removeFailures = 0;
  /** While set, sync waits for it. */
  hold: Promise<void> | null = null;
  delayMs = 0;

  constructor(id = 'plaid') {
    super({
      id,
      mode: 'delta',
      accounts: riveraAccounts(),
      updates: [[{}]],
      capabilities: { liabilities: false },
    });
  }

  override async sync(secret: string): Promise<SyncPage> {
    if (this.#active.has(secret)) this.overlaps++;
    this.#active.add(secret);
    this.synced.push(secret);
    try {
      await (this.hold ?? new Promise((resolve) => setTimeout(resolve, this.delayMs)));
      if (this.syncFailure) throw this.syncFailure;
      return {
        mode: 'delta',
        added: [],
        modified: [],
        removed: [],
        nextCursor: 'c',
        hasMore: false,
      };
    } finally {
      this.#active.delete(secret);
    }
  }

  override async remove(secret: string): Promise<void> {
    this.removed.push(secret);
    if (this.removeFailures > 0) {
      this.removeFailures--;
      throw new ProviderError('transient', { providerCode: 'INTERNAL_SERVER_ERROR' });
    }
  }
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** One at a time: the owner's client runs one query at once. */
async function inOrder<T>(n: number, make: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await make(i));
  return out;
}

describe('the runner (#81)', { timeout: 30_000 }, () => {
  let h: WorkerHarness;
  let plaid: TestProvider;

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 300_000);
  afterAll(() => h?.close(), 60_000);

  beforeEach(async () => {
    await h.owner.query('DELETE FROM connections');
    await h.owner.query('DELETE FROM instance_settings');
    plaid = new TestProvider();
  });

  const runner = (options: Partial<RunnerOptions> = {}, providers = [plaid]) =>
    new Runner(
      {
        db: h.worker.db,
        crypto: h.crypto,
        providers: new ProviderRegistry(providers),
        handlers: new JobHandlers(DEFAULT_JOB_HANDLERS),
        logger: quiet,
      },
      { random: () => 0, ...options },
    );
  const passOnce = async (r: Runner) => {
    await r.pass();
    await r.idle();
  };

  it('runs the due connections, and not those not due, leased, being set up, or needing sign-in', async () => {
    const ok = await h.connection({ secret: 'secret-ok' });
    const failing = await h.connection({ status: 'error', secret: 'secret-error' });
    const skipped = {
      later: await h.connection({ next: '1 hour' }),
      never: await h.connection({ next: null }),
      leased: await h.connection({ lease: '5 minutes' }),
      setup: await h.connection({ status: 'setup' }),
      loginRequired: await h.connection({ status: 'login_required' }),
    };
    const entries = Object.entries(skipped);
    const before = Object.fromEntries(
      await inOrder(entries.length, async (i) => [entries[i]![0], await h.row(entries[i]![1])]),
    );

    await passOnce(runner());

    expect(new Set(plaid.synced)).toEqual(new Set(['secret-ok', 'secret-error']));
    for (const id of [ok, failing]) {
      const row = await h.row(id);
      expect(row).toMatchObject({ status: 'ok', leased: false, lastErrorCode: null });
      expect(row.lastSyncedAt).not.toBeNull();
      // The default interval, 4 h, with no jitter (random = 0).
      expect(row.nextInMinutes).toBe(240);
    }
    for (const [k, id] of Object.entries(skipped)) {
      expect([k, await h.row(id)]).toEqual([k, before[k]]);
    }
  });

  it('schedules the next sync within the interval plus its jitter', async () => {
    const ids = await inOrder(3, () => h.connection());
    await passOnce(runner({ random: Math.random }));
    for (const id of ids) {
      const { nextInMinutes } = await h.row(id);
      expect(nextInMinutes).toBeGreaterThanOrEqual(240);
      expect(nextInMinutes).toBeLessThanOrEqual(264);
    }
  });

  it("reads the interval from the instance's settings each pass, unless the env overrides it", async () => {
    const r = runner();
    const first = await h.connection();
    await passOnce(r);
    expect((await h.row(first)).nextInMinutes).toBe(240);

    await h.owner.query(
      `INSERT INTO instance_settings (key, value) VALUES ('sync.intervalHours', '12'::jsonb)`,
    );
    await h.due(first);
    await passOnce(r);
    expect((await h.row(first)).nextInMinutes).toBe(720);

    await h.due(first);
    await passOnce(runner({ intervalHours: 2 }));
    expect((await h.row(first)).nextInMinutes).toBe(120);
  });

  it('never runs one connection in two runners at once', async () => {
    const ids = await inOrder(12, (n) => h.connection({ secret: `secret-${n}` }));
    plaid.delayMs = 30;
    const [a, b] = [runner({ concurrency: 3 }), runner({ concurrency: 3 })];
    await until(async () => {
      await Promise.all([a.pass(), b.pass()]);
      return plaid.synced.length >= ids.length;
    }, 20_000);
    await Promise.all([a.idle(), b.idle()]);
    expect(plaid.overlaps).toBe(0);
    expect(plaid.synced.toSorted()).toEqual(ids.map((_, n) => `secret-${n}`).toSorted());
  });

  it('backs off 1 min, 5 min, 30 min, … up to the interval, and resets after a success', async () => {
    const id = await h.connection();
    const r = runner();
    plaid.syncFailure = new ProviderError('institution_down', { providerCode: 'INSTITUTION_DOWN' });

    const delays: number[] = [];
    let firstFailedAt: Date | null = null;
    for (let n = 1; n <= 6; n++) {
      await passOnce(r);
      const row = await h.row(id);
      expect(row).toMatchObject({
        status: 'error',
        lastErrorCode: 'INSTITUTION_DOWN',
        consecutiveFailures: n,
        leased: false,
      });
      // When it began failing, kept for the whole run (the 3-day "not working" line, D10).
      firstFailedAt ??= row.firstFailedAt;
      expect(row.firstFailedAt).toEqual(firstFailedAt);
      delays.push(row.nextInMinutes!);
      await h.due(id);
    }
    expect(delays).toEqual([1, 5, 30, 120, 240, 240]);

    plaid.syncFailure = null;
    await passOnce(r);
    expect(await h.row(id)).toMatchObject({
      status: 'ok',
      lastErrorCode: null,
      consecutiveFailures: 0,
      firstFailedAt: null,
      nextInMinutes: 240,
    });
    // And the next failure starts the ladder over.
    plaid.syncFailure = new ProviderError('transient', { providerCode: 'INTERNAL_SERVER_ERROR' });
    await h.due(id);
    await passOnce(r);
    expect(await h.row(id)).toMatchObject({ consecutiveFailures: 1, nextInMinutes: 1 });
  });

  it('stops polling a connection that needs its owner to sign in again', async () => {
    const id = await h.connection();
    plaid.syncFailure = new ProviderError('login_required', {
      providerCode: 'ITEM_LOGIN_REQUIRED',
    });
    await passOnce(runner());
    expect(await h.row(id)).toMatchObject({
      status: 'login_required',
      lastErrorCode: 'ITEM_LOGIN_REQUIRED',
    });
  });

  it("keeps going when one connection's job fails", async () => {
    const good = await h.connection({ secret: 'secret-good' });
    // No SimpleFIN adapter in this build: provider_unavailable, backed off, not a crash.
    const unavailable = await h.connection({ provider: 'simplefin' });
    const noSecret = await h.connection({ secret: null });
    const broken = await h.connection({ secret: 'secret-broken' });
    const r = runner({ concurrency: 10 });
    const original = plaid.sync.bind(plaid);
    plaid.sync = async (secret) => {
      if (secret === 'secret-broken') throw new TypeError('a bug');
      return original(secret);
    };
    await passOnce(r);
    expect(await h.row(good)).toMatchObject({ status: 'ok', nextInMinutes: 240 });
    expect(await h.row(unavailable)).toMatchObject({
      status: 'error',
      lastErrorCode: 'provider_unavailable',
      nextInMinutes: 1,
      leased: false,
    });
    expect(await h.row(noSecret)).toMatchObject({
      status: 'error',
      lastErrorCode: 'secret_missing',
    });
    expect(await h.row(broken)).toMatchObject({ status: 'error', lastErrorCode: 'internal' });
    // The runner still runs: the next pass claims what's due.
    const later = await h.connection();
    await passOnce(r);
    expect(await h.row(later)).toMatchObject({ status: 'ok' });
  });

  it('fails a job that takes too long, as a timeout', async () => {
    const id = await h.connection();
    plaid.hold = new Promise(() => {});
    await passOnce(runner({ jobTimeoutMs: 50 }));
    expect(await h.row(id)).toMatchObject({ status: 'error', lastErrorCode: 'timeout' });
  });

  describe('ending disconnected connections at the provider', () => {
    const disconnected = (opts: Parameters<WorkerHarness['connection']>[0] = {}) =>
      h.connection({ status: 'disconnected', disconnectRequested: true, ...opts });
    const ended = async (id: string) =>
      (
        await h.owner.query(
          `SELECT actor_kind, visible_to_household FROM audit_events
           WHERE action = 'connection.ended_at_provider' AND target_id = $1`,
          [id],
        )
      ).rows;

    it('calls remove, then deletes the secret and clears disconnect_requested', async () => {
      const id = await disconnected();
      await passOnce(runner());
      expect(plaid.removed).toEqual(['fake-secret']);
      expect(plaid.synced).toEqual([]);
      expect(await h.row(id)).toMatchObject({
        status: 'disconnected',
        disconnectRequested: false,
        hasSecret: false,
        nextInMinutes: null,
        leased: false,
      });
      expect(await ended(id)).toEqual([{ actor_kind: 'system', visible_to_household: false }]);
      // Never claimed again.
      await passOnce(runner());
      expect(plaid.removed).toHaveLength(1);
    });

    it('keeps the secret while remove fails, and retries', async () => {
      const id = await disconnected();
      plaid.removeFailures = 1;
      const r = runner();
      await passOnce(r);
      expect(await h.row(id)).toMatchObject({
        status: 'disconnected',
        disconnectRequested: true,
        hasSecret: true,
        lastErrorCode: 'INTERNAL_SERVER_ERROR',
        nextInMinutes: 1,
      });
      expect(await ended(id)).toEqual([]);
      await h.due(id);
      await passOnce(r);
      expect(plaid.removed).toHaveLength(2);
      expect(await h.row(id)).toMatchObject({ disconnectRequested: false, hasSecret: false });
    });

    it('keeps the secret when the provider is unavailable here', async () => {
      const id = await disconnected({ provider: 'simplefin' });
      await passOnce(runner());
      expect(await h.row(id)).toMatchObject({
        disconnectRequested: true,
        hasSecret: true,
        lastErrorCode: 'provider_unavailable',
        nextInMinutes: 1,
      });
    });

    it('has nothing to end when the secret is already gone', async () => {
      const id = await disconnected({ secret: null });
      await passOnce(runner());
      expect(plaid.removed).toEqual([]);
      expect(await h.row(id)).toMatchObject({ disconnectRequested: false, nextInMinutes: null });
    });
  });

  describe('abandoned setups', () => {
    const age = (id: string, hours: number) =>
      h.owner.query(
        `UPDATE connections SET created_at = now() - make_interval(hours => $2) WHERE id = $1`,
        [id, hours],
      );

    it('ends a setup nobody finished in 24 hours at the provider, and leaves newer ones', async () => {
      const old = await h.connection({ status: 'setup', next: null });
      const fresh = await h.connection({ status: 'setup', next: null });
      await age(old, 25);
      await age(fresh, 23);
      // The same pass that finds it ends it at the provider, as any disconnect.
      await passOnce(runner());
      expect(await h.row(old)).toMatchObject({
        status: 'disconnected',
        disconnectRequested: false,
        hasSecret: false,
      });
      expect(await h.row(fresh)).toMatchObject({ status: 'setup', disconnectRequested: false });
      expect(plaid.removed).toEqual(['fake-secret']);
      expect(plaid.synced).toEqual([]);
    });

    it('looks once an hour, and only for the worker', async () => {
      let now = new Date('2026-10-22T12:00:00Z');
      const r = runner({ now: () => now });
      await passOnce(r);
      const late = await h.connection({ status: 'setup', next: null });
      await age(late, 30);
      await passOnce(r);
      expect(await h.row(late)).toMatchObject({ status: 'setup' });
      now = new Date('2026-10-22T13:00:00Z');
      await passOnce(r);
      expect(await h.row(late)).toMatchObject({ status: 'disconnected' });

      // Anyone but the worker changes nothing.
      const other = await h.connection({ status: 'setup', next: null });
      await age(other, 30);
      const { rows } = await h.owner.query(`SELECT fiscus_abandon_setups(interval '1 hour') AS n`);
      expect(rows[0].n).toBe(0);
      expect(await h.row(other)).toMatchObject({ status: 'setup' });
    });
  });

  describe('the loop', () => {
    it('passes every pollMs on its clock, and readiness reports it', async () => {
      const clock = new FakeClock('2026-10-21T12:00:00Z');
      let ticks: (() => void)[] = [];
      const tick = () => {
        const pending = ticks;
        ticks = [];
        for (const resolve of pending) resolve();
      };
      const r = runner({
        pollMs: 5_000,
        now: () => clock.now(),
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            expect(ms).toBe(5_000);
            ticks.push(resolve);
            signal.addEventListener('abort', () => resolve(), { once: true });
          }),
      });
      expect(r.status()).toEqual({ healthy: false, lastPassAt: null, runningJobs: 0 });
      r.start();
      await until(() => ticks.length === 1);
      expect(r.status()).toEqual({
        healthy: true,
        lastPassAt: '2026-10-21T12:00:00.000Z',
        runningJobs: 0,
      });

      const id = await h.connection();
      clock.advance(5_000);
      tick();
      await until(() => ticks.length === 1);
      await r.idle();
      expect(await h.row(id)).toMatchObject({ status: 'ok' });
      expect(r.status().lastPassAt).toBe('2026-10-21T12:00:05.000Z');

      // No pass for a while: not ready.
      clock.advance(5 * 60_000);
      expect(r.status().healthy).toBe(false);
      await r.stop();
      expect(r.status().healthy).toBe(false);
    });

    it('starts with the app, and on shutdown lets jobs finish, then releases the leases of the rest', async () => {
      const quick = await h.connection({ provider: 'simplefin', secret: 'secret-quick' });
      const slow = await h.connection({ secret: 'secret-slow' });
      let resume = () => {};
      plaid.hold = new Promise((resolve) => (resume = resolve));
      const simplefin = new TestProvider('simplefin');
      const app = await NestFactory.createApplicationContext(
        WorkerModule.forRoot({
          db: h.worker.db,
          crypto: h.crypto,
          providers: new ProviderRegistry([plaid, simplefin]),
          options: { pollMs: 60_000, shutdownTimeoutMs: 200, random: () => 0 },
        }),
        { logger: false },
      );
      const r = app.get(Runner);
      await until(() => plaid.synced.length === 1 && simplefin.synced.length === 1);
      await until(async () => (await h.row(quick)).lastSyncedAt !== null);
      expect(r.status().runningJobs).toBe(1);
      expect((await h.row(slow)).leased).toBe(true);

      await app.close();
      expect(r.stopping).toBe(true);
      const row = await h.row(slow);
      // Released, still due: the next worker takes it right away.
      expect(row).toMatchObject({ leased: false, lastSyncedAt: null, nextInMinutes: -1 });
      // If the job finishes after all, it leaves the connection alone.
      resume();
      await r.idle();
      expect(await h.row(slow)).toEqual(row);
      expect(await h.row(quick)).toMatchObject({ status: 'ok', nextInMinutes: 240 });
    });
  });
});
