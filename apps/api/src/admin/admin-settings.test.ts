// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionService } from '../auth/session.service.js';
import { SetupService } from '../auth/setup.service.js';
import { createTestApp, TestClient } from '../testing/test-app.js';

const ADMIN = {
  email: 'admin@fiscus.test',
  password: 'Correct horse battery 1!',
  displayName: 'Ada',
};
const BEA = { email: 'bea@fiscus.test', password: 'another long Password1!', displayName: 'Bea' };
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
 * ADM-05, and the start of ADM-07 (counts arrive with #78). Admin responses are allow-lists
 * (permissions §5, §7): these tests list every field, so adding one fails them.
 */
describe('instance settings (ADM-05, in part)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let sandboxApp: NestFastifyApplication;
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
    sandboxApp = await createTestApp(tdb.appUrl, { plaid: { environment: 'sandbox' } });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([app?.close(), sandboxApp?.close(), owner?.end()]);
    await tdb?.stop();
  });

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
      plaid: { configured: false, environment: null },
      simplefin: { enabled: false },
      settings: { ...DEFAULTS, 'sync.intervalHours': 6, 'simplefin.enabled': false },
    });
    // The complete allow-list (D16: counts, never content). A new field fails here until it's
    // added to permissions §5 and to this list.
    expect(paths(res.body).sort()).toEqual(
      [
        'data/plaid/configured',
        'data/plaid/environment',
        'data/simplefin/enabled',
        'data/settings/plaid.allowHouseholdKeys',
        'data/settings/simplefin.enabled',
        'data/settings/sync.intervalHours',
        'data/settings/plaid.refreshNowEnabled',
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

  it('show the Plaid environment when its keys are set', async () => {
    const c = new TestClient(sandboxApp);
    expect((await c.post('/api/v1/auth/login', ADMIN)).status).toBe(200);
    const res = await c.get('/api/v1/admin/bank-connections');
    expect(res.body.data.plaid).toEqual({ configured: true, environment: 'sandbox' });
  });
});
