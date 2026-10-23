// SPDX-License-Identifier: AGPL-3.0-or-later
import { RIVERA, startFakeSimpleFin, type FakeSimpleFin } from '@fiscus/aggregation/testing';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InstanceSettingsService } from '../admin/instance-settings.service.js';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Connecting the SimpleFIN Bridge (#91, D3, D4) against the fake Bridge: a setup token claimed
 * once by the server, the access URL kept only encrypted, and the same choose step as Plaid's.
 */

type Res = Awaited<ReturnType<TestClient['request']>>;
const ok = (r: Res) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
const refused = (r: Res, status: number, code?: string) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body.code).toBe(code);
};
/** The fake Bridge's credentials: in nothing a client or a log sees. */
const SECRETS = ['rivera-bridge-password', 'rivera-bridge-user'];

let tdb: TestDatabase;
let app: NestFastifyApplication;
let bridge: FakeSimpleFin;
let db: pg.Client;
let hh = '';
let A: TestClient;
let B: TestClient;
let V: TestClient;
const member = { A: '' };
const url = (p = '') => `/api/v1/households/${hh}${p}`;
const connect = (c: TestClient, setupToken = bridge.setupToken) =>
  c.post(url('/simplefin/connect'), { setupToken });
const b64 = (s: string) => Buffer.from(s).toString('base64');

beforeAll(async () => {
  tdb = await startTestDatabase();
  bridge = await startFakeSimpleFin();
  app = await createTestApp(tdb.appUrl, {
    signupMode: 'open',
    simplefin: { allowedHosts: [bridge.host], allowHttp: true },
  });
  db = new pg.Client({ connectionString: tdb.ownerUrl });
  await db.connect();
  let n = 0;
  const signup = async (name: string) => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: `${name.toLowerCase()}${n++}@simplefin.test`,
      password: 'simplefin test Password1!',
      displayName: name,
    });
    return c;
  };
  A = await signup('Alex');
  const created = (
    await A.post('/api/v1/households', { name: 'Riveras', baseCurrency: 'USD', timezone: 'UTC' })
  ).body.data;
  hh = created.id;
  member.A = created.you.memberId;
  const join = async (name: string, role: 'member' | 'viewer') => {
    const c = await signup(name);
    const me = (await c.get('/api/v1/me')).body.data;
    const invite = await A.post(url('/invites'), { email: me.email, role });
    const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
    ok(await c.post('/api/v1/invites/accept', { token }));
    return c;
  };
  B = await join('Sam', 'member');
  V = await join('Val', 'viewer');
}, 180_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await bridge?.close();
  await tdb?.stop();
});

describe('connecting the SimpleFIN Bridge (#91)', () => {
  let connId = '';

  it('[ACC-01] is offered to owners and members when the admin has it on; viewers can’t', async () => {
    for (const c of [A, B])
      expect((await c.get(url('/simplefin'))).body.data).toEqual({ available: true });
    refused(await V.get(url('/simplefin')), 403);
    refused(await connect(V), 403);
    const settings = app.get(InstanceSettingsService);
    const off = vi.spyOn(settings, 'get').mockResolvedValue(false);
    try {
      expect((await A.get(url('/simplefin'))).body.data).toEqual({ available: false });
      refused(await connect(A), 409, 'simplefin_unavailable');
    } finally {
      off.mockRestore();
    }
    // Nothing was claimed.
    expect(bridge.requests).toEqual([]);
  });

  it('refuses what isn’t a token, or one pointing anywhere but the Bridge, before any request', async () => {
    refused(await connect(A, 'my bank password'), 422, 'not_a_setup_token');
    refused(await connect(A, b64('https://evil.example/claim/x')), 422, 'setup_token_host');
    refused(await connect(A, b64('http://169.254.169.254/latest')), 422, 'setup_token_host');
    refused(await A.post(url('/simplefin/connect'), {}), 422);
    expect(bridge.requests).toEqual([]);
  });

  it('[D3] claims the token once, keeps only the encrypted access URL, and offers the accounts', async () => {
    const r = await connect(A);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    connId = r.body.data.connectionId;
    expect(r.body.data.institutionName).toBe('SimpleFIN Bridge');
    for (const s of SECRETS) expect(JSON.stringify(r.body)).not.toContain(s);
    const offered = Object.fromEntries(
      (r.body.data.accounts as any[]).map((a) => [a.providerAccountId, a]),
    );
    expect(offered[RIVERA.checking]).toMatchObject({
      name: 'Harbor CU Checking',
      type: 'depository',
      subtype: 'checking',
      currency: 'USD',
      balance: { amountMinor: 651_240, currency: 'USD' },
      suggestion: { choice: 'new', visibility: 'private' },
    });
    expect(offered[RIVERA.visa]).toMatchObject({
      type: 'credit',
      balance: { amountMinor: -180_722, currency: 'USD' },
    });

    const row = (await db.query('SELECT * FROM connections WHERE id = $1', [connId])).rows[0];
    expect(row).toMatchObject({
      provider: 'simplefin',
      status: 'setup',
      owner_member_id: member.A,
      next_sync_at: null,
      provider_env: null,
    });
    expect(row.provider_item_id).toMatch(/^sfin-[0-9a-f]{32}$/);
    const [secret] = (
      await db.query('SELECT secret_enc FROM connection_secrets WHERE connection_id = $1', [connId])
    ).rows;
    for (const s of SECRETS) {
      expect(Buffer.from(secret.secret_enc).toString('latin1')).not.toContain(s);
    }
    // Claimed once: the same token again is refused, by the Bridge.
    refused(await connect(A), 422, 'setup_token_used');
    expect(
      bridge.requests.filter((q) => q.path === '/claim/rivera-setup').map((q) => q.method),
    ).toEqual(['POST', 'POST']);
  });

  it('[D4] offers them again after a reload, to its owner only', async () => {
    const r = await A.get(url(`/connections/${connId}/setup`));
    ok(r);
    expect(r.body.data.accounts).toHaveLength(4);
    refused(await B.get(url(`/connections/${connId}/setup`)), 404);
  });

  it('isn’t fixed through Plaid Link', async () => {
    refused(await A.post(url(`/plaid/link-token?connection=${connId}`)), 409);
  });

  it('[D4, D5] confirms like Plaid’s: then it syncs', async () => {
    const r = await A.post(url(`/connections/${connId}/confirm`), {
      accounts: [
        { providerAccountId: RIVERA.checking, choice: 'new' },
        { providerAccountId: RIVERA.visa, choice: 'new', visibility: 'full' },
        { providerAccountId: RIVERA.savings, choice: 'skip' },
        { providerAccountId: RIVERA.oldSavings, choice: 'skip' },
      ],
    });
    ok(r);
    const made = (
      await db.query(
        `SELECT provider_account_id, type, visibility, connection_id FROM accounts
          WHERE connection_id = $1 ORDER BY provider_account_id`,
        [connId],
      )
    ).rows;
    expect(made).toEqual([
      {
        provider_account_id: RIVERA.checking,
        type: 'depository',
        visibility: 'private',
        connection_id: connId,
      },
      {
        provider_account_id: RIVERA.visa,
        type: 'credit',
        visibility: 'full',
        connection_id: connId,
      },
    ]);
    const row = (
      await db.query('SELECT status, next_sync_at FROM connections WHERE id = $1', [connId])
    ).rows[0];
    expect(row.status).toBe('ok');
    expect(row.next_sync_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const listed = ((await A.get(url('/connections'))).body.data as any[]).find(
      (c) => c.id === connId,
    );
    expect(listed).toMatchObject({ provider: 'simplefin', institutionName: 'SimpleFIN Bridge' });
  });

  it('keeps a claimed token’s connection when the Bridge then fails, to come back to', async () => {
    const second = await startFakeSimpleFin({ user: 'kai-bridge-user' });
    try {
      const app2 = await createTestApp(tdb.appUrl, {
        signupMode: 'open',
        simplefin: { allowedHosts: [second.host], allowHttp: true },
      });
      try {
        const c = new TestClient(app2);
        await c.post('/api/v1/auth/signup', {
          email: 'kai@simplefin.test',
          password: 'simplefin test Password1!',
          displayName: 'Kai',
        });
        const id = (
          await c.post('/api/v1/households', { name: 'Kai', baseCurrency: 'USD', timezone: 'UTC' })
        ).body.data.id;
        second.failNext({ status: 503, body: 'Down, Kai' });
        const r = await c.post(`/api/v1/households/${id}/simplefin/connect`, {
          setupToken: second.setupToken,
        });
        refused(r, 502, 'provider_unavailable');
        expect(r.body.detail).toContain('kept the connection');
        expect(JSON.stringify(r.body)).not.toContain('Kai');
        const kept = r.body.connectionId as string;
        const row = (await db.query('SELECT status FROM connections WHERE id = $1', [kept]))
          .rows[0];
        expect(row.status).toBe('setup');
        // The Bridge answers again: the setup is there.
        ok(await c.get(`/api/v1/households/${id}/connections/${kept}/setup`));
      } finally {
        await app2.close();
      }
    } finally {
      await second.close();
    }
  });
});
