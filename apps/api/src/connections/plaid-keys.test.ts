// SPDX-License-Identifier: AGPL-3.0-or-later
import { startFakePlaid, type FakePlaid } from '@fiscus/aggregation/testing';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * A household's own Plaid keys (#83, ADR 0008 §Credentials 2–5): entered by household owners,
 * checked with Plaid first, never shown again; banks connected after use them, banks connected
 * before keep theirs until each is connected again (D15); keys in use can't be removed. Who may
 * do it is HH-08 in permissions.test.ts.
 */

type Res = Awaited<ReturnType<TestClient['request']>>;
const ok = (r: Res) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
const refused = (r: Res, status: number, code?: string) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body.code).toBe(code);
};

const OURS = { clientId: 'household-client-id-7731', secret: 'household-sandbox-secret' };
const NEWER = { clientId: 'household-client-id-9902', secret: 'household-sandbox-secret-2' };

let tdb: TestDatabase;
let app: NestFastifyApplication;
let plaid: FakePlaid;
let db: pg.Client;
let hh = '';
let A: TestClient;
let B: TestClient;
const url = (p = '') => `/api/v1/households/${hh}${p}`;
const keys = async () => {
  const r = await A.get(url('/plaid-keys'));
  ok(r);
  return r.body.data;
};
const put = (body: Record<string, string>) => A.request('PUT', url('/plaid-keys'), body);
const sets = async () =>
  (
    await db.query(
      `SELECT client_id, env, revoked_at IS NOT NULL AS revoked, length(secret_enc) AS secret
       FROM aggregation_credentials WHERE household_id = $1 ORDER BY created_at`,
      [hh],
    )
  ).rows;
/** Connects the fake bank as A through the api, then confirms one new account. */
const connect = async () => {
  ok(await A.post(url('/plaid/link-token')));
  const setup = await A.post(url('/plaid/exchange'), { publicToken: plaid.publicToken });
  ok(setup);
  return setup.body.data.connectionId as string;
};
const connection = async (id: string) =>
  (
    await db.query(
      `SELECT c.credential_set_id, a.client_id, c.provider_client_id
       FROM connections c LEFT JOIN aggregation_credentials a ON a.id = c.credential_set_id
       WHERE c.id = $1`,
      [id],
    )
  ).rows[0];

beforeAll(async () => {
  tdb = await startTestDatabase();
  plaid = await startFakePlaid({ otherKeys: [OURS, NEWER] });
  // The fake has one Item; each exchange gets its own id so connections don't collide.
  let items = 0;
  plaid.override('/item/public_token/exchange', () => ({
    body: { access_token: plaid.accessToken, item_id: `item-keys-${++items}`, request_id: 'r' },
  }));
  plaid.override('/item/remove', { body: { request_id: 'r' } });
  app = await createTestApp(tdb.appUrl, {
    signupMode: 'open',
    plaid: {
      clientId: plaid.clientId,
      secret: plaid.secret,
      env: 'sandbox',
      apiBaseUrl: plaid.url,
      redirectUri: 'https://fiscus.example/connect/plaid/oauth',
    },
  });
  db = new pg.Client({ connectionString: tdb.ownerUrl });
  await db.connect();
  let n = 0;
  const signup = async (name: string) => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: `${name.toLowerCase()}${n++}@keys.test`,
      password: 'plaid keys test Password1!',
      displayName: name,
    });
    return c;
  };
  A = await signup('Alex');
  hh = (
    await A.post('/api/v1/households', { name: 'Riveras', baseCurrency: 'USD', timezone: 'UTC' })
  ).body.data.id;
  B = await signup('Sam');
  const me = (await B.get('/api/v1/me')).body.data;
  const invite = await A.post(url('/invites'), { email: me.email, role: 'owner' });
  const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
  ok(await B.post('/api/v1/invites/accept', { token }));
}, 180_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await plaid?.close();
  await tdb?.stop();
});

describe("a household's own Plaid keys (#83)", () => {
  it('saves keys Plaid accepts, shows only their last 4, and never the secret', async () => {
    expect(await keys()).toMatchObject({ allowed: true, serverKeys: true, keys: null });
    // On the server's keys, Link gets the server's redirect URI.
    ok(await A.post(url('/plaid/link-token')));
    const first = JSON.parse(plaid.requests.find((q) => q.path === '/link/token/create')!.body);
    expect(first).toMatchObject({
      client_id: plaid.clientId,
      redirect_uri: 'https://fiscus.example/connect/plaid/oauth',
    });
    const r = await put({ ...OURS, env: 'sandbox' });
    ok(r);
    expect(r.body.data.keys).toEqual({
      clientIdEnding: '7731',
      env: 'sandbox',
      addedAt: expect.any(String),
    });
    expect(JSON.stringify(r.body)).not.toContain(OURS.secret);
    expect(JSON.stringify(await keys())).not.toContain(OURS.clientId);
    // Plaid was asked before anything was saved.
    expect(plaid.requests.map((q) => q.path)).toContain('/institutions/get');
    expect(await sets()).toEqual([
      expect.objectContaining({ client_id: OURS.clientId, env: 'sandbox', revoked: false }),
    ]);
    // Stored encrypted: the secret's text isn't in the row.
    const raw = await db.query(
      `SELECT encode(secret_enc, 'escape') AS s FROM aggregation_credentials WHERE household_id = $1`,
      [hh],
    );
    expect(raw.rows[0].s).not.toContain(OURS.secret);
    const recorded = await db.query(
      `SELECT action, metadata FROM audit_events WHERE household_id = $1 AND action LIKE 'household.plaid_keys%'`,
      [hh],
    );
    expect(recorded.rows).toEqual([
      { action: 'household.plaid_keys_added', metadata: { env: 'sandbox' } },
    ]);
  });

  it('refuses keys Plaid rejects, and saves nothing', async () => {
    const before = await sets();
    refused(
      await put({ clientId: 'nope', secret: 'nope', env: 'sandbox' }),
      422,
      'plaid_keys_rejected',
    );
    expect(await sets()).toEqual(before);
  });

  it('connects new banks with them, and keeps older banks on theirs when they change (D15)', async () => {
    const mine = await connect();
    // The server's redirect URI is registered with the server's keys only, so Link goes without.
    const linkTokens = plaid.requests.filter((q) => q.path === '/link/token/create');
    const last = JSON.parse(linkTokens.at(-1)!.body);
    expect(last.client_id).toBe(OURS.clientId);
    expect(last).not.toHaveProperty('redirect_uri');
    expect(await connection(mine)).toMatchObject({
      client_id: OURS.clientId,
      provider_client_id: OURS.clientId,
    });
    // Replaced while a bank uses them: the old set is revoked, not emptied, and lists the bank.
    ok(await put({ ...NEWER, env: 'sandbox' }));
    expect(await sets()).toEqual([
      expect.objectContaining({
        client_id: OURS.clientId,
        revoked: true,
        secret: expect.any(Number),
      }),
      expect.objectContaining({ client_id: NEWER.clientId, revoked: false }),
    ]);
    expect((await sets())[0].secret).toBeGreaterThan(0);
    expect((await keys()).connections).toEqual([
      expect.objectContaining({
        id: mine,
        keys: 'previous',
        owner: expect.objectContaining({ name: 'Alex' }),
      }),
    ]);
    // The older bank still works on its own keys: "sign in again" opens with them.
    await db.query(`UPDATE connections SET status = 'ok' WHERE id = $1`, [mine]);
    ok(await A.post(url(`/plaid/link-token?connection=${mine}`)));
    const newer = await connect();
    expect(await connection(newer)).toMatchObject({ client_id: NEWER.clientId });
  });

  it('refuses to remove keys banks still use, and removes them once none do', async () => {
    refused(await A.request('DELETE', url('/plaid-keys')), 409, 'keys_in_use');
    // Disconnect everything on the current keys, as the worker would finish it.
    await db.query(
      `UPDATE connections SET status = 'disconnected', disconnect_requested = false
       WHERE household_id = $1`,
      [hh],
    );
    ok(await A.request('DELETE', url('/plaid-keys')));
    expect((await sets()).at(-1)).toMatchObject({
      client_id: NEWER.clientId,
      revoked: true,
      secret: 0,
    });
    expect((await keys()).keys).toBeNull();
    refused(await A.request('DELETE', url('/plaid-keys')), 404);
  });

  it('is refused when the admin turns household keys off', async () => {
    await db.query(`UPDATE users SET is_instance_admin = true WHERE email LIKE 'alex%@keys.test'`);
    ok(await A.request('PATCH', '/api/v1/admin/settings', { 'plaid.allowHouseholdKeys': false }));
    expect((await keys()).allowed).toBe(false);
    refused(await put({ ...OURS, env: 'sandbox' }), 403, 'household_keys_off');
    ok(await A.request('PATCH', '/api/v1/admin/settings', { 'plaid.allowHouseholdKeys': true }));
  });

  it('is for household owners: another owner may, members and viewers may not (HH-08)', async () => {
    ok(await B.get(url('/plaid-keys')));
  });
});
