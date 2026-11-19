// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCrypto, MasterKey, MasterKeys } from '@fiscus/crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { systemContext, withContext } from './context.js';
import { HouseholdKeyStore } from './household-key-store.js';
import { savePlaidKeySet } from './plaid-credentials.js';
import {
  findPlaidItem,
  plaidWebhookHealth,
  plaidWebhookKeySet,
  plaidWebhookMoves,
  queuePlaidWebhook,
  recordPlaidWebhook,
  unrelaxPlaidConnections,
} from './plaid-webhooks.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Plaid webhooks' definers (#84), with no application code: what the api can do for a webhook
 * with no member in context, and what only the worker can.
 */

const H = randomUUID();
const user = randomUUID();
const member = randomUUID();
const URL_A = 'https://fiscus.example/api/v1/webhooks/plaid';

describe('Plaid webhook definers (#84)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: DbHandle;
  let worker: DbHandle;
  let crypto: FieldCrypto;
  let setId: string;

  const connection = async (
    status: string,
    opts: { item?: string; set?: string | null; synced?: string; next?: string } = {},
  ) => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id,
                                status, credential_set_id, last_synced_at, next_sync_at)
       VALUES ($1, $2, $3, 'plaid', $4, $5, $6, now() - $7::interval, now() + $8::interval)`,
      [
        id,
        H,
        member,
        opts.item ?? `item-${id}`,
        status,
        opts.set ?? null,
        opts.synced ?? '1 hour',
        opts.next ?? '3 hours',
      ],
    );
    return id;
  };
  const row = async (id: string) =>
    (
      await owner.query(
        `SELECT sync_requested_at IS NOT NULL AS sync, check_requested_at IS NOT NULL AS check,
                webhook_enabled, round(extract(epoch FROM next_sync_at - now()) / 60)::int AS next
         FROM connections WHERE id = $1`,
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    app = createDb(tdb.appUrl);
    worker = createDb(tdb.workerUrl);
    const master = new MasterKeys(MasterKey.fromBase64(randomBytes(32).toString('base64'), 1));
    crypto = new FieldCrypto(new HouseholdKeyStore(worker.db, master), master);
    await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, 'w@h.test', 'W')`, [
      user,
    ]);
    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC');
       INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ('${member}', $1, '${user}', 'owner', 'W', '#000')`.replace(/\$1/g, `'${H}'`),
    );
    await new HouseholdKeyStore(worker.db, master).createForHousehold(H);
    setId = randomUUID();
    await withContext(worker.db, systemContext(H), (tx) =>
      savePlaidKeySet(tx, crypto, {
        id: setId,
        householdId: H,
        createdByMemberId: member,
        clientId: 'household-client',
        secret: 'household-secret',
        env: 'sandbox',
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.close(), worker?.close()]);
    await tdb?.stop();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM plaid_webhook_stats');
  });

  it('finds a live Item’s connection by Plaid’s item id, as ids only, for the api', async () => {
    const id = await connection('ok', { item: 'item-found', set: setId });
    expect(await findPlaidItem(app.db, 'item-found')).toEqual({
      householdId: H,
      connectionId: id,
      credentialSetId: setId,
    });
    expect(await findPlaidItem(app.db, 'item-nowhere')).toBeNull();
    await connection('disconnected', { item: 'item-gone' });
    expect(await findPlaidItem(app.db, 'item-gone')).toBeNull();
    // The worker has no use for it.
    expect(await findPlaidItem(worker.db, 'item-found')).toBeNull();
  });

  it('reads the Item’s own household key set, still encrypted, and only that one', async () => {
    await connection('ok', { item: 'item-own-keys', set: setId });
    await connection('ok', { item: 'item-server-keys' });
    expect(await plaidWebhookKeySet(app.db, crypto, 'item-own-keys')).toEqual({
      id: setId,
      clientId: 'household-client',
      secret: 'household-secret',
      env: 'sandbox',
    });
    expect(await plaidWebhookKeySet(app.db, crypto, 'item-server-keys')).toBeNull();
    expect(await plaidWebhookKeySet(app.db, crypto, 'item-nowhere')).toBeNull();
  });

  it('queues a sync or a check without the household’s context, merging repeats', async () => {
    const ok = await connection('ok');
    const signIn = await connection('login_required');
    const setup = await connection('setup');
    expect(await queuePlaidWebhook(app.db, ok, 'sync', URL_A)).toBe(true);
    const first = (
      await owner.query('SELECT sync_requested_at FROM connections WHERE id = $1', [ok])
    ).rows[0].sync_requested_at;
    expect(await queuePlaidWebhook(app.db, ok, 'sync', URL_A)).toBe(true);
    const again = (
      await owner.query('SELECT sync_requested_at FROM connections WHERE id = $1', [ok])
    ).rows[0].sync_requested_at;
    expect(again).toEqual(first);
    // Signing in again is what fixes login_required; only a check reaches it.
    expect(await queuePlaidWebhook(app.db, signIn, 'sync', URL_A)).toBe(false);
    expect(await queuePlaidWebhook(app.db, signIn, 'check', URL_A)).toBe(true);
    expect(await queuePlaidWebhook(app.db, setup, 'check', URL_A)).toBe(false);
    expect(await row(signIn)).toMatchObject({ sync: false, check: true });
    // Nothing else changes: the status stays until the worker asks Plaid.
    expect(
      (await owner.query('SELECT status FROM connections WHERE id = $1', [signIn])).rows[0].status,
    ).toBe('login_required');
  });

  it('marks webhooks enabled on acknowledgement only for the URL the Item was moved to', async () => {
    const id = await connection('ok');
    expect(await queuePlaidWebhook(app.db, id, 'acknowledged', URL_A)).toBe(false);
    await owner.query('UPDATE connections SET webhook_url = $2 WHERE id = $1', [id, URL_A]);
    expect(await queuePlaidWebhook(app.db, id, 'acknowledged', 'https://other.example/x')).toBe(
      false,
    );
    expect(await queuePlaidWebhook(app.db, id, 'acknowledged', URL_A)).toBe(true);
    expect((await row(id)).webhook_enabled).toBe(true);
  });

  it('keeps the counts read-only to the app: only the definer writes them', async () => {
    await expect(
      app.pool.query(
        `INSERT INTO plaid_webhook_stats (hour, outcome, count, last_at) VALUES (now(), 'verified', 1, now())`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(app.pool.query('DELETE FROM plaid_webhook_stats')).rejects.toThrow(
      /permission denied/,
    );
    await recordPlaidWebhook(app.db, null, 'signature');
    await recordPlaidWebhook(app.db, null, 'signature');
    await recordPlaidWebhook(app.db, setId, 'verified');
    const { rows } = await app.pool.query(
      'SELECT credential_set_id, outcome, count FROM plaid_webhook_stats ORDER BY outcome',
    );
    expect(rows).toEqual([
      { credential_set_id: null, outcome: 'signature', count: 2 },
      { credential_set_id: setId, outcome: 'verified', count: 1 },
    ]);
    await expect(recordPlaidWebhook(app.db, null, 'whatever' as never)).rejects.toThrow();
  });

  it('is healthy with a verified webhook in 48 hours and no refusal in 24', async () => {
    expect((await plaidWebhookHealth(app.db)).healthy).toBe(false);
    await recordPlaidWebhook(app.db, null, 'verified');
    expect((await plaidWebhookHealth(app.db)).healthy).toBe(true);
    await recordPlaidWebhook(app.db, null, 'stale');
    expect((await plaidWebhookHealth(app.db)).healthy).toBe(false);
    // The refusal 25 hours ago, the verified one 47: healthy again.
    await owner.query(`UPDATE plaid_webhook_stats SET last_at = now() - interval '25 hours',
                         hour = date_trunc('hour', now() - interval '25 hours') WHERE outcome = 'stale'`);
    await owner.query(`UPDATE plaid_webhook_stats SET last_at = now() - interval '47 hours',
                         hour = date_trunc('hour', now() - interval '47 hours') WHERE outcome = 'verified'`);
    expect((await plaidWebhookHealth(app.db)).healthy).toBe(true);
    await owner.query(`UPDATE plaid_webhook_stats SET last_at = now() - interval '49 hours',
                         hour = date_trunc('hour', now() - interval '49 hours') WHERE outcome = 'verified'`);
    expect((await plaidWebhookHealth(app.db)).healthy).toBe(false);
  });

  it('lets counts older than 8 days go', async () => {
    await owner.query(
      `INSERT INTO plaid_webhook_stats (hour, outcome, count, last_at)
       VALUES (now() - interval '9 days', 'verified', 5, now() - interval '9 days')`,
    );
    await recordPlaidWebhook(app.db, null, 'verified');
    const { rows } = await owner.query('SELECT count FROM plaid_webhook_stats');
    expect(rows).toEqual([{ count: 1 }]);
  });

  it('claims a requested sync at once, and a requested check even when signing in is needed', async () => {
    await owner.query(`UPDATE connections SET next_sync_at = now() + interval '1 day'`);
    const sync = await connection('ok', { next: '5 hours' });
    const check = await connection('login_required', { next: '5 hours' });
    const neither = await connection('login_required', { next: '-1 hour' });
    await queuePlaidWebhook(app.db, sync, 'sync', URL_A);
    await queuePlaidWebhook(app.db, check, 'check', URL_A);
    const { rows } = await worker.pool.query(
      `SELECT connection_id FROM fiscus_claim_due_connections(10, '1 minute')`,
    );
    const claimed = rows.map((r) => r.connection_id);
    expect(claimed).toEqual(expect.arrayContaining([sync, check]));
    expect(claimed).not.toContain(neither);
    await owner.query(`UPDATE connections SET lease_until = NULL`);
  });

  it('lists Items to move to a new URL, for the worker only, skipping recent failures', async () => {
    await owner.query(`DELETE FROM connections`);
    const a = await connection('ok');
    const b = await connection('login_required');
    await connection('disconnected');
    const failed = await connection('ok');
    await owner.query(`UPDATE connections SET webhook_move_failed_at = now() WHERE id = $1`, [
      failed,
    ]);
    const moves = async (url: string | null) =>
      (await plaidWebhookMoves(worker.db, url, 50)).map((m) => m.connectionId).sort();
    expect(await moves(URL_A)).toEqual([a, b].sort());
    // Webhooks off: nothing has one, so nothing to move.
    expect(await moves(null)).toEqual([]);
    await owner.query(`UPDATE connections SET webhook_url = $1 WHERE id = $2`, [URL_A, a]);
    expect(await moves(URL_A)).toEqual([b]);
    expect(await moves(null)).toEqual([a]);
    expect(await plaidWebhookMoves(app.db, URL_A, 50)).toEqual([]);
  });

  it('brings relaxed connections back to the normal interval, for the worker only', async () => {
    await owner.query(`DELETE FROM connections`);
    const relaxed = await connection('ok', { synced: '1 hour', next: '11 hours' });
    const long = await connection('ok', { synced: '5 hours', next: '7 hours' });
    const normal = await connection('ok', { synced: '1 hour', next: '3 hours' });
    expect(await unrelaxPlaidConnections(worker.db, 4 * 60 * 60_000)).toBe(2);
    expect((await row(relaxed)).next).toBe(180);
    // Last synced 5 hours ago: due now.
    expect((await row(long)).next).toBe(0);
    expect((await row(normal)).next).toBe(180);
    await expect(app.pool.query(`SELECT fiscus_unrelax_connections('4 hours')`)).rejects.toThrow(
      /worker/,
    );
  });
});
