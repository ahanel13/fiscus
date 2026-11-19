// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { plaidProviderSource, ProviderRegistry } from '@fiscus/aggregation';
import { jsonBody, RIVERA, startFakePlaid, type FakePlaid } from '@fiscus/aggregation/testing';
import { recordPlaidWebhook, savePlaidKeySet, systemContext, withContext } from '@fiscus/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';
import { DEFAULT_JOB_HANDLERS } from './handlers.js';
import { JobHandlers } from './jobs.js';
import { RELAXED_INTERVAL_HOURS, Runner, type RunnerOptions } from './runner.js';

/**
 * The worker's side of Plaid webhooks (#84): what a verified webhook queued (a sync, or a check
 * that asks Plaid before changing anything), moving Items to the current webhook URL, and
 * polling that relaxes only while webhooks are healthy.
 */

const URL_NOW = 'https://fiscus.example/api/v1/webhooks/plaid';
const HOUSEHOLD_KEYS = { clientId: 'household-client-5512', secret: 'household-secret-5512' };

describe('Plaid webhooks in the worker (#84)', { timeout: 60_000 }, () => {
  let h: WorkerHarness;
  let fake: FakePlaid;
  let logs: string[];

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 300_000);
  afterAll(() => h?.close(), 60_000);
  beforeEach(async () => {
    logs = [];
    fake = await startFakePlaid({ otherKeys: [HOUSEHOLD_KEYS] });
    await h.owner.query(`UPDATE connections SET next_sync_at = NULL, status = 'disconnected'`);
    await h.owner.query('DELETE FROM plaid_webhook_stats');
  });
  afterEach(() => fake?.close());

  const runner = (options: Partial<RunnerOptions> = {}) =>
    new Runner(
      {
        db: h.worker.db,
        crypto: h.crypto,
        providers: new ProviderRegistry([
          plaidProviderSource({
            clientId: fake.clientId,
            secret: fake.secret,
            env: 'sandbox',
            apiBaseUrl: fake.url,
          }),
        ]),
        handlers: new JobHandlers(DEFAULT_JOB_HANDLERS),
        logger: {
          log: (m: string) => logs.push(m),
          warn: (m: string) => logs.push(m),
          error: (m: string) => logs.push(m),
        },
        fetchLogo: async () => new Response(null, { status: 404 }),
      },
      { random: () => 0, intervalHours: 4, ...options },
    );
  const pass = async (options: Partial<RunnerOptions> = {}) => {
    const r = runner(options);
    await r.pass();
    await r.idle();
    return r;
  };
  const paths = () => fake.requests.map((r) => r.path);
  /** A Plaid connection with the fake's token, not due until `next`. */
  const connection = async (
    opts: { status?: string; next?: string; webhookUrl?: string | null; set?: string } = {},
  ) => {
    const id = await h.connection({
      provider: 'plaid',
      status: opts.status ?? 'ok',
      next: opts.next ?? '3 hours',
      secret: fake.accessToken,
      providerEnv: 'sandbox',
      providerClientId: opts.set ? HOUSEHOLD_KEYS.clientId : fake.clientId,
      ...(opts.set && { credentialSetId: opts.set }),
    });
    // Webhooks off by default, as the runner here is: nothing to move.
    if (opts.webhookUrl) {
      await h.owner.query('UPDATE connections SET webhook_url = $2 WHERE id = $1', [
        id,
        opts.webhookUrl,
      ]);
    }
    await h.account({
      householdId: h.householdId,
      owners: [h.memberId],
      connectionId: id,
      providerAccountId: RIVERA.checking,
    });
    return id;
  };
  const extra = async (id: string) =>
    (
      await h.owner.query(
        `SELECT sync_requested_at, check_requested_at, webhook_url, webhook_enabled,
                webhook_move_failed_at
         FROM connections WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const request = (id: string, what: 'sync' | 'check') =>
    h.owner.query(`UPDATE connections SET ${what}_requested_at = now() WHERE id = $1`, [id]);

  it('syncs a connection a webhook asked for at once, and clears the request', async () => {
    const id = await connection();
    await request(id, 'sync');
    await pass();
    expect(paths()).toContain('/transactions/sync');
    expect(await h.row(id)).toMatchObject({ status: 'ok', nextInMinutes: 240 });
    expect((await extra(id)).sync_requested_at).toBeNull();
    // Nothing asked again: the next pass leaves it until it's due.
    fake.requests.length = 0;
    await pass();
    expect(paths()).toEqual([]);
  });

  it('keeps a request that came in while the sync ran, and syncs again for it', async () => {
    const id = await connection();
    await request(id, 'sync');
    let arrived: Promise<unknown> | undefined;
    // A webhook lands while Plaid is answering: after the job took the one it saw.
    fake.override('/transactions/sync', () => {
      arrived ??= h.owner.query(
        `UPDATE connections SET sync_requested_at = now() + interval '1 second' WHERE id = $1`,
        [id],
      );
      return {
        body: {
          added: [],
          modified: [],
          removed: [],
          next_cursor: 'cursor-1',
          has_more: false,
          transactions_update_status: 'INITIAL_UPDATE_COMPLETE',
          accounts: [],
          request_id: 'r',
        },
      };
    });
    await pass();
    await arrived;
    expect((await extra(id)).sync_requested_at).toBeInstanceOf(Date);
  });

  it('changes nothing on a webhook’s word: a check asks /item/get first', async () => {
    const id = await connection();
    await request(id, 'check');
    await pass();
    // Plaid says the Item is fine: it just syncs.
    expect(paths().slice(0, 2)).toEqual(['/item/get', '/transactions/sync']);
    expect(await h.row(id)).toMatchObject({ status: 'ok' });
    expect((await extra(id)).check_requested_at).toBeNull();
  });

  it('asks the owner to sign in again only once /item/get confirms ITEM_LOGIN_REQUIRED', async () => {
    const id = await connection();
    fake.override('/item/get', {
      body: {
        item: {
          item_id: 'i',
          institution_id: null,
          webhook: URL_NOW,
          error: {
            error_type: 'ITEM_ERROR',
            error_code: 'ITEM_LOGIN_REQUIRED',
            error_message: 'Alex Rivera must sign in',
          },
        },
        request_id: 'req-confirmed',
      },
    });
    await request(id, 'check');
    await pass();
    expect(paths()).toEqual(['/item/get']);
    expect(await h.row(id)).toMatchObject({
      status: 'login_required',
      lastErrorCode: 'ITEM_LOGIN_REQUIRED',
    });
    expect(logs.join('\n')).not.toContain('Alex Rivera');
  });

  it('notices a login fixed at the bank (LOGIN_REPAIRED), and records it', async () => {
    const id = await connection({ status: 'login_required', next: '-1 minute' });
    // Waiting for its owner, nothing claims it.
    await pass();
    expect(paths()).toEqual([]);
    await request(id, 'check');
    await pass();
    expect(paths().slice(0, 2)).toEqual(['/item/get', '/transactions/sync']);
    expect(await h.row(id)).toMatchObject({ status: 'ok', lastErrorCode: null });
    const { rows } = await h.owner.query(
      `SELECT action, actor_kind FROM audit_events WHERE target_id = $1`,
      [id],
    );
    expect(rows.map((r) => r.action)).toContain('connection.repaired_at_bank');
  });

  it('moves every Item to the current URL, household-key Items included, and off when unset', async () => {
    const setId = randomUUID();
    await withContext(h.worker.db, systemContext(h.householdId), (tx) =>
      savePlaidKeySet(tx, h.crypto, {
        id: setId,
        householdId: h.householdId,
        createdByMemberId: h.memberId,
        ...HOUSEHOLD_KEYS,
        env: 'sandbox',
      }),
    );
    const server = await connection({ webhookUrl: null });
    const own = await connection({ webhookUrl: 'https://old.example/hook', set: setId });
    const current = await connection({ webhookUrl: URL_NOW });
    await h.owner.query('UPDATE connections SET webhook_enabled = true WHERE id = $1', [current]);

    await pass({ plaidWebhookUrl: URL_NOW });
    const updates = fake.requests
      .filter((r) => r.path === '/item/webhook/update')
      .map((r) => jsonBody<{ client_id: string; webhook: string | null }>(r));
    expect(updates.map((u) => u.client_id).sort()).toEqual(
      [fake.clientId, HOUSEHOLD_KEYS.clientId].sort(),
    );
    expect(updates.every((u) => u.webhook === URL_NOW)).toBe(true);
    for (const id of [server, own]) {
      expect(await extra(id)).toMatchObject({ webhook_url: URL_NOW, webhook_enabled: false });
    }
    // Already there: untouched, still enabled.
    expect(await extra(current)).toMatchObject({ webhook_url: URL_NOW, webhook_enabled: true });

    fake.requests.length = 0;
    await pass();
    const removed = fake.requests
      .filter((r) => r.path === '/item/webhook/update')
      .map((r) => jsonBody<{ webhook: string | null }>(r).webhook);
    expect(removed).toEqual([null, null, null]);
    for (const id of [server, own, current]) {
      expect(await extra(id)).toMatchObject({ webhook_url: null, webhook_enabled: false });
    }
  });

  it('retries a failed move an hour later, not every pass', async () => {
    const id = await connection({ webhookUrl: null });
    fake.failNext('/item/webhook/update', {
      error_type: 'API_ERROR',
      error_code: 'INTERNAL_SERVER_ERROR',
    });
    await pass({ plaidWebhookUrl: URL_NOW });
    expect((await extra(id)).webhook_move_failed_at).toBeInstanceOf(Date);
    expect(logs.some((l) => l.includes('moving its webhook failed (INTERNAL_SERVER_ERROR'))).toBe(
      true,
    );
    fake.requests.length = 0;
    await pass({ plaidWebhookUrl: URL_NOW });
    expect(paths()).toEqual([]);
    await h.owner.query(
      `UPDATE connections SET webhook_move_failed_at = now() - interval '61 minutes' WHERE id = $1`,
      [id],
    );
    await pass({ plaidWebhookUrl: URL_NOW });
    expect(await extra(id)).toMatchObject({ webhook_url: URL_NOW, webhook_move_failed_at: null });
  });

  it('relaxes polling to 12 h only while webhooks are healthy, and only for Items that have them', async () => {
    const withWebhook = await connection({ next: '-1 minute', webhookUrl: URL_NOW });
    // Moved, but Plaid hasn't acknowledged it yet.
    const without = await connection({ next: '-1 minute', webhookUrl: URL_NOW });
    await h.owner.query('UPDATE connections SET webhook_enabled = true WHERE id = $1', [
      withWebhook,
    ]);
    // No verified webhook yet: not healthy, so the normal interval.
    await pass({ plaidWebhookUrl: URL_NOW });
    expect((await h.row(withWebhook)).nextInMinutes).toBe(240);

    await recordPlaidWebhook(h.worker.db, null, 'verified');
    await h.due(withWebhook);
    await h.due(without);
    await pass({ plaidWebhookUrl: URL_NOW });
    expect((await h.row(withWebhook)).nextInMinutes).toBe(RELAXED_INTERVAL_HOURS * 60);
    expect((await h.row(without)).nextInMinutes).toBe(240);

    // One refused request, and polling is back to normal for the relaxed one.
    await recordPlaidWebhook(h.worker.db, null, 'signature');
    await pass({ plaidWebhookUrl: URL_NOW });
    expect((await h.row(withWebhook)).nextInMinutes).toBe(240);
  });

  it('never relaxes with webhooks off, and brings relaxed connections back', async () => {
    const id = await connection({ next: '-1 minute' });
    await h.owner.query('UPDATE connections SET webhook_enabled = true WHERE id = $1', [id]);
    await recordPlaidWebhook(h.worker.db, null, 'verified');
    await pass();
    expect((await h.row(id)).nextInMinutes).toBe(240);
    await h.owner.query(
      `UPDATE connections SET last_synced_at = now(), next_sync_at = now() + interval '12 hours'
       WHERE id = $1`,
      [id],
    );
    await pass();
    expect((await h.row(id)).nextInMinutes).toBe(240);
  });
});
