// SPDX-License-Identifier: AGPL-3.0-or-later
import { PLAID_WEBHOOK_PATH } from '@fiscus/aggregation';
import { jsonBody, startFakePlaid, type FakePlaid } from '@fiscus/aggregation/testing';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionService } from '../auth/session.service.js';
import { SetupService } from '../auth/setup.service.js';
import { createTestApp, TestClient } from '../testing/test-app.js';
import { TEST_WEBHOOK, TEST_WEBHOOK_INSTITUTION } from './plaid-test-webhook.service.js';

const ADMIN = {
  email: 'admin@fiscus.test',
  password: 'Correct horse battery 1!',
  displayName: 'Ada',
};
const BEA = { email: 'bea@fiscus.test', password: 'another long Password1!', displayName: 'Bea' };
const WEBHOOK_URL = `https://fiscus.example${PLAID_WEBHOOK_PATH}`;
const NO_REFUSALS = {
  signature: 0,
  stale: 0,
  body_hash: 0,
  unknown_key: 0,
  missing: 0,
  malformed: 0,
  algorithm: 0,
};
const DEFAULTS = {
  'plaid.allowHouseholdKeys': true,
  'simplefin.enabled': true,
  'sync.intervalHours': 4,
  'plaid.refreshNowEnabled': true,
};

/** Every key of a JSON value, as dotted paths: what an allow-list test compares. */
function paths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => paths(v, prefix ? `${prefix}/${k}` : k));
}

/**
 * Instance settings and Server → Bank connections (#400): the settings part of permissions
 * ADM-05, and connection counts (ADM-07, D16). Admin responses are allow-lists
 * (permissions §5, §7): these tests list every field, so adding one fails them.
 */
describe('instance settings (ADM-05, in part)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let sandboxApp: NestFastifyApplication;
  let fakeApp: NestFastifyApplication;
  let productionApp: NestFastifyApplication;
  let plaid: FakePlaid;
  let fakeClosed = false;
  let owner: pg.Client;
  let admin: TestClient;
  let bea: TestClient;

  const sql = async (text: string, params: unknown[] = []) =>
    (await owner.query(text, params)).rows;
  const patch = (c: TestClient, body: unknown) =>
    c.request('PATCH', '/api/v1/admin/settings', body);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    admin = new TestClient(app);
    // The app announces its own setup token on startup; ours must come after it.
    await vi.waitFor(async () => expect(await sql('SELECT 1 FROM instance_setup')).toHaveLength(1));
    const setupToken = await app.get(SetupService).issueToken();
    const setup = await admin.post('/api/v1/auth/setup', { ...ADMIN, setupToken });
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    bea = new TestClient(app);
    expect((await bea.post('/api/v1/auth/signup', BEA)).status).toBe(201);
    // After setup: on startup an app issues a new setup token while setup is still required.
    sandboxApp = await createTestApp(tdb.appUrl, {
      plaid: { clientId: 'test-client', secret: 'test-secret', env: 'sandbox' },
      plaidWebhookUrl: WEBHOOK_URL,
    });
    // The fake Plaid delivers what it fires to this app's receiver, as Plaid would (#85).
    plaid = await startFakePlaid({
      deliverWebhook: async (url, webhook) => {
        await fakeApp.inject({
          method: 'POST',
          url: new URL(url).pathname,
          payload: webhook.body,
          headers: webhook.headers,
          remoteAddress: '10.9.9.9',
        });
      },
    });
    fakeApp = await createTestApp(tdb.appUrl, {
      plaid: {
        clientId: plaid.clientId,
        secret: plaid.secret,
        env: 'sandbox',
        apiBaseUrl: plaid.url,
      },
      plaidWebhookUrl: WEBHOOK_URL,
    });
    productionApp = await createTestApp(tdb.appUrl, {
      plaid: { clientId: 'prod-client', secret: 'prod-secret', env: 'production' },
      plaidWebhookUrl: WEBHOOK_URL,
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([app?.close(), sandboxApp?.close(), productionApp?.close(), owner?.end()]);
    if (!fakeClosed) await fakeApp?.close();
    await plaid?.close();
    await tdb?.stop();
  });

  const signedIn = async (on: NestFastifyApplication) => {
    const c = new TestClient(on);
    expect((await c.post('/api/v1/auth/login', ADMIN)).status).toBe(200);
    return c;
  };

  it('are only for instance admins, signed in', async () => {
    const anonymous = new TestClient(app);
    for (const url of ['/api/v1/admin/settings', '/api/v1/admin/bank-connections']) {
      expect((await anonymous.get(url)).status).toBe(401);
      expect((await bea.get(url)).status).toBe(403);
    }
    expect((await patch(bea, { 'sync.intervalHours': 2 })).status).toBe(403);
    expect((await patch(anonymous, { 'sync.intervalHours': 2 })).status).toBe(401);
    expect(await sql('SELECT * FROM instance_settings')).toEqual([]);
  });

  it('read as their defaults until an admin changes them', async () => {
    const res = await admin.get('/api/v1/admin/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: DEFAULTS });
  });

  it('are validated by the registry', async () => {
    for (const body of [
      { 'sync.intervalHours': 0 },
      { 'sync.intervalHours': 25 },
      { 'sync.intervalHours': 2.5 },
      { 'simplefin.enabled': 'no' },
      { 'plaid.clientSecret': 'x' },
      {},
    ]) {
      const res = await patch(admin, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.code).toBe('validation_failed');
    }
    expect(await sql('SELECT * FROM instance_settings')).toEqual([]);
  });

  it('need a CSRF token to change', async () => {
    const res = await admin.request(
      'PATCH',
      '/api/v1/admin/settings',
      { 'sync.intervalHours': 2 },
      { csrf: false },
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_failed');
  });

  it('need recent re-authentication to change', async () => {
    const sessions = app.get(SessionService);
    const realNow = sessions.now;
    sessions.now = () => new Date(Date.now() + 11 * 60_000);
    try {
      const stale = await patch(admin, { 'sync.intervalHours': 2 });
      expect(stale.status).toBe(403);
      expect(stale.body.code).toBe('reauth_required');
      // Reading doesn't.
      expect((await admin.get('/api/v1/admin/settings')).status).toBe(200);
    } finally {
      sessions.now = realNow;
    }
    expect(await sql('SELECT * FROM instance_settings')).toEqual([]);
  });

  it('change, and each change is audit-logged as the instance admin with old and new values', async () => {
    const res = await patch(admin, { 'sync.intervalHours': 6, 'simplefin.enabled': false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { ...DEFAULTS, 'sync.intervalHours': 6, 'simplefin.enabled': false },
    });
    // The cache was cleared: the next read sees the change.
    expect((await admin.get('/api/v1/admin/settings')).body.data['sync.intervalHours']).toBe(6);

    const [adminRow] = await sql(`SELECT id FROM users WHERE email = $1`, [ADMIN.email]);
    expect(
      await sql(`SELECT key, value, updated_by_user_id FROM instance_settings ORDER BY key`),
    ).toEqual([
      { key: 'simplefin.enabled', value: false, updated_by_user_id: adminRow.id },
      { key: 'sync.intervalHours', value: 6, updated_by_user_id: adminRow.id },
    ]);
    const events = await sql(
      `SELECT actor_kind, actor_user_id, household_id, target_type, target_id, metadata
       FROM audit_events WHERE action = 'admin.instance_setting_changed' ORDER BY id`,
    );
    expect(events).toEqual([
      {
        actor_kind: 'instance_admin',
        actor_user_id: adminRow.id,
        household_id: null,
        target_type: 'instance_setting',
        target_id: 'simplefin.enabled',
        metadata: { key: 'simplefin.enabled', from: true, to: false },
      },
      {
        actor_kind: 'instance_admin',
        actor_user_id: adminRow.id,
        household_id: null,
        target_type: 'instance_setting',
        target_id: 'sync.intervalHours',
        metadata: { key: 'sync.intervalHours', from: 4, to: 6 },
      },
    ]);

    // Setting a value it already has isn't a change: nothing more is logged.
    expect((await patch(admin, { 'sync.intervalHours': 6 })).status).toBe(200);
    expect(
      await sql(`SELECT count(*)::int AS n FROM audit_events
                 WHERE action = 'admin.instance_setting_changed'`),
    ).toEqual([{ n: 2 }]);
  });

  it('Server → Bank connections shows settings and Plaid’s status, and only allow-listed fields', async () => {
    const res = await admin.get('/api/v1/admin/bank-connections');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      plaid: {
        configured: false,
        environment: null,
        webhookUrl: null,
        webhooks: {
          lastVerifiedAt: null,
          lastVerifiedByKeys: { server: null, household: null },
          refusals: { last24h: NO_REFUSALS, last7d: NO_REFUSALS },
          unknownItems: { last24h: 0, last7d: 0 },
          connections: { plaid: 0, withoutWebhook: 0 },
          pollingRelaxed: false,
          testAvailable: false,
        },
      },
      simplefin: { enabled: false },
      settings: { ...DEFAULTS, 'sync.intervalHours': 6, 'simplefin.enabled': false },
      stats: {
        plaidInstanceKeys: { households: 0, connections: 0 },
        plaidHouseholdKeys: { households: 0, connections: 0 },
        simplefin: { households: 0, connections: 0 },
        byStatus: { setup: 0, ok: 0, login_required: 0, error: 0 },
        last24h: { synced: 0, failing: 0, lastSyncedAt: null },
      },
    });
    // The complete allow-list (D16: counts, never content). A new field fails here until it's
    // added to permissions §5 and to this list.
    expect(paths(res.body).sort()).toEqual(
      [
        'data/plaid/configured',
        'data/plaid/environment',
        // The webhook URL, read-only (ADM-05, #84).
        'data/plaid/webhookUrl',
        // The receiver's health (#85): times and counts, never an Item, body or household.
        'data/plaid/webhooks/lastVerifiedAt',
        'data/plaid/webhooks/lastVerifiedByKeys/server',
        'data/plaid/webhooks/lastVerifiedByKeys/household',
        ...['last24h', 'last7d'].flatMap((p) =>
          Object.keys(NO_REFUSALS).map((r) => `data/plaid/webhooks/refusals/${p}/${r}`),
        ),
        'data/plaid/webhooks/unknownItems/last24h',
        'data/plaid/webhooks/unknownItems/last7d',
        'data/plaid/webhooks/connections/plaid',
        'data/plaid/webhooks/connections/withoutWebhook',
        'data/plaid/webhooks/pollingRelaxed',
        'data/plaid/webhooks/testAvailable',
        'data/simplefin/enabled',
        'data/settings/plaid.allowHouseholdKeys',
        'data/settings/simplefin.enabled',
        'data/settings/sync.intervalHours',
        'data/settings/plaid.refreshNowEnabled',
        'data/stats/plaidInstanceKeys/households',
        'data/stats/plaidInstanceKeys/connections',
        'data/stats/plaidHouseholdKeys/households',
        'data/stats/plaidHouseholdKeys/connections',
        'data/stats/simplefin/households',
        'data/stats/simplefin/connections',
        'data/stats/byStatus/setup',
        'data/stats/byStatus/ok',
        'data/stats/byStatus/login_required',
        'data/stats/byStatus/error',
        'data/stats/last24h/synced',
        'data/stats/last24h/failing',
        'data/stats/last24h/lastSyncedAt',
      ].sort(),
    );
    expect(paths((await admin.get('/api/v1/admin/settings')).body).sort()).toEqual(
      [
        'data/plaid.allowHouseholdKeys',
        'data/simplefin.enabled',
        'data/sync.intervalHours',
        'data/plaid.refreshNowEnabled',
      ].sort(),
    );
  });

  it('counts connections across households, naming none of them (D16)', async () => {
    const household = async (name: string) => {
      const res = await bea.post('/api/v1/households', {
        name,
        baseCurrency: 'USD',
        timezone: 'UTC',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const id: string = res.body.data.id;
      const [m] = await sql('SELECT id FROM household_members WHERE household_id = $1', [id]);
      return { id, member: m.id as string };
    };
    const riveras = await household('Riveras');
    const okafors = await household('Okafors');
    const [keys] = await sql(
      `INSERT INTO aggregation_credentials
         (id, household_id, provider, client_id, secret_enc, env, created_by_member_id)
       VALUES (gen_random_uuid(), $1, 'plaid', 'their-client-id', '\\x00', 'sandbox', $2)
       RETURNING id`,
      [riveras.id, riveras.member],
    );
    let items = 0;
    const connection = (
      hh: { id: string; member: string },
      provider: string,
      status: string,
      { syncedAgo = null as string | null, failures = 0, credentialSetId = null as string | null },
    ) =>
      sql(
        `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id,
           status, credential_set_id, last_synced_at, consecutive_failures)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now() - $7::interval, $8)`,
        [
          hh.id,
          hh.member,
          provider,
          `item-${++items}`,
          status,
          credentialSetId,
          syncedAgo,
          failures,
        ],
      );
    await connection(riveras, 'plaid', 'ok', { syncedAgo: '1 hour' });
    await connection(riveras, 'plaid', 'error', { syncedAgo: '3 days', failures: 3 });
    await connection(riveras, 'plaid', 'login_required', {
      syncedAgo: '2 days',
      failures: 1,
      credentialSetId: keys.id,
    });
    // Disconnected: no longer reaches a bank, so not counted.
    await connection(riveras, 'plaid', 'disconnected', { syncedAgo: '10 minutes' });
    await connection(okafors, 'simplefin', 'ok', { syncedAgo: '30 minutes' });
    await connection(okafors, 'plaid', 'setup', {});

    const res = await admin.get('/api/v1/admin/bank-connections');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.stats).toEqual({
      plaidInstanceKeys: { households: 2, connections: 3 },
      plaidHouseholdKeys: { households: 1, connections: 1 },
      simplefin: { households: 1, connections: 1 },
      byStatus: { setup: 1, ok: 2, login_required: 1, error: 1 },
      last24h: { synced: 2, failing: 2, lastSyncedAt: expect.any(String) },
    });
    // The most recent sync of a connection that's still connected: the SimpleFIN one.
    const ago = Date.now() - Date.parse(res.body.data.stats.last24h.lastSyncedAt);
    expect(ago).toBeGreaterThan(29 * 60_000);
    expect(ago).toBeLessThan(31 * 60_000);
    // Nothing in the response names a household.
    expect(JSON.stringify(res.body)).not.toMatch(/Riveras|Okafors|item-|their-client-id/);
  });

  it('counts only for an instance admin outside any household, even through SQL', async () => {
    const client = new pg.Client({ connectionString: tdb.appUrl });
    await client.connect();
    const [beaUser] = await sql(`SELECT id FROM users WHERE email = $1`, [BEA.email]);
    const [adminUser] = await sql(`SELECT id FROM users WHERE email = $1`, [ADMIN.email]);
    const [hh] = await sql(`SELECT household_id AS id FROM household_members LIMIT 1`);
    const stats = async (user: string, household = '') => {
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT set_config('app.user_id', $1, true), set_config('app.household_id', $2, true)`,
          [user, household],
        );
        return (await client.query('SELECT fiscus_admin_bank_stats() AS s')).rows[0].s;
      } finally {
        await client.query('ROLLBACK');
      }
    };
    try {
      expect(await stats(adminUser.id)).toMatchObject({ byStatus: { ok: 2 } });
      await expect(stats(beaUser.id)).rejects.toThrow(/needs an instance admin/);
      await expect(stats(adminUser.id, hh.id)).rejects.toThrow(/needs an instance admin/);
    } finally {
      await client.end();
    }
  });

  it('show the Plaid environment when its keys are set, and the webhook URL (#84)', async () => {
    const c = await signedIn(sandboxApp);
    const res = await c.get('/api/v1/admin/bank-connections');
    expect(res.body.data.plaid).toMatchObject({
      configured: true,
      environment: 'sandbox',
      webhookUrl: WEBHOOK_URL,
      webhooks: { testAvailable: true },
    });
  });

  describe('webhook health (#85)', () => {
    it('shows the receiver’s counts by reason, and connections without a webhook', async () => {
      await owner.query('DELETE FROM plaid_webhook_stats');
      await owner.query(
        `INSERT INTO plaid_webhook_stats (hour, credential_set_id, outcome, count, last_at) VALUES
           (date_trunc('hour', now()), NULL, 'verified', 3, now() - interval '10 minutes'),
           (date_trunc('hour', now()), NULL, 'unknown_item', 1, now() - interval '5 minutes'),
           (date_trunc('hour', now()), NULL, 'body_hash', 2, now()),
           (date_trunc('hour', now() - interval '2 days'), NULL, 'unknown_key', 5,
            now() - interval '2 days')`,
      );
      const res = await (await signedIn(sandboxApp)).get('/api/v1/admin/bank-connections');
      expect(res.status).toBe(200);
      const w = res.body.data.plaid.webhooks;
      expect(w.refusals.last24h).toEqual({ ...NO_REFUSALS, body_hash: 2 });
      expect(w.refusals.last7d).toEqual({ ...NO_REFUSALS, body_hash: 2, unknown_key: 5 });
      expect(w.unknownItems).toEqual({ last24h: 1, last7d: 1 });
      // The unknown Item's was the last verified; the server's keys' 10 minutes ago.
      expect(Date.parse(w.lastVerifiedAt)).toBeGreaterThan(Date.parse(w.lastVerifiedByKeys.server));
      expect(w.lastVerifiedByKeys.household).toBeNull();
      // A refusal in the last 24 hours: polling isn't relaxed.
      expect(w.pollingRelaxed).toBe(false);
      // Every live Plaid connection from the counts test has no webhook.
      expect(w.connections).toEqual({ plaid: 4, withoutWebhook: 4 });
      await owner.query(`DELETE FROM plaid_webhook_stats WHERE outcome <> 'verified'`);
      const relaxed = await (await signedIn(sandboxApp)).get('/api/v1/admin/bank-connections');
      expect(relaxed.body.data.plaid.webhooks.pollingRelaxed).toBe(true);
      // Webhooks off: never relaxed, whatever the counts say.
      const off = await admin.get('/api/v1/admin/bank-connections');
      expect(off.body.data.plaid.webhooks.pollingRelaxed).toBe(false);
      await owner.query('DELETE FROM plaid_webhook_stats');
    });

    it('sends a test webhook in sandbox, and the panel shows it arrive', async () => {
      await owner.query('DELETE FROM plaid_webhook_stats');
      const c = await signedIn(fakeApp);
      const before = (await c.get('/api/v1/admin/bank-connections')).body.data.plaid.webhooks;
      expect(before).toMatchObject({ lastVerifiedAt: null, testAvailable: true });
      const res = await c.post('/api/v1/admin/bank-connections/test-webhook', {});
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(Object.keys(res.body.data)).toEqual(['firedAt']);
      // A test bank's Item, made with this server's URL and fired at: no household's connection.
      const made = plaid.requests.find((r) => r.path === '/sandbox/public_token/create');
      expect(jsonBody(made!)).toMatchObject({
        institution_id: TEST_WEBHOOK_INSTITUTION,
        initial_products: ['transactions'],
        options: { webhook: WEBHOOK_URL },
      });
      const fired = plaid.requests.find((r) => r.path === '/sandbox/item/fire_webhook');
      expect(jsonBody(fired!)).toMatchObject({
        webhook_type: TEST_WEBHOOK.type,
        webhook_code: TEST_WEBHOOK.code,
      });
      await vi.waitFor(async () => {
        const w = (await c.get('/api/v1/admin/bank-connections')).body.data.plaid.webhooks;
        expect(w.unknownItems.last24h).toBe(1);
        expect(Date.parse(w.lastVerifiedAt)).toBeGreaterThanOrEqual(
          Date.parse(res.body.data.firedAt),
        );
      });
      // Verified with the server's keys, and nothing else counted.
      expect(await sql('SELECT outcome, count FROM plaid_webhook_stats')).toEqual([
        { outcome: 'unknown_item', count: 1 },
      ]);
      // The test Item is still there for Plaid to send from; it's removed later.
      expect(plaid.sandboxItems).toBe(1);
      // Nothing in the answer names the Item or its token.
      expect(JSON.stringify(res.body)).not.toMatch(/item-|access-/);
    });

    it('removes the test Item when the api stops', async () => {
      fakeClosed = true;
      await fakeApp.close();
      expect(plaid.sandboxItems).toBe(0);
    });

    it('is absent in production and with webhooks off, and only for instance admins', async () => {
      const prod = await signedIn(productionApp);
      expect(
        (await prod.get('/api/v1/admin/bank-connections')).body.data.plaid.webhooks.testAvailable,
      ).toBe(false);
      const before = plaid.requests.length;
      expect((await prod.post('/api/v1/admin/bank-connections/test-webhook', {})).status).toBe(404);
      expect((await admin.post('/api/v1/admin/bank-connections/test-webhook', {})).status).toBe(
        404,
      );
      expect((await bea.post('/api/v1/admin/bank-connections/test-webhook', {})).status).toBe(403);
      const anonymous = new TestClient(sandboxApp);
      expect((await anonymous.post('/api/v1/admin/bank-connections/test-webhook', {})).status).toBe(
        401,
      );
      expect(plaid.requests.length).toBe(before);
    });
  });
});
