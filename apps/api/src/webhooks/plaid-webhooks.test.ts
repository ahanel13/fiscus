// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { PLAID_WEBHOOK_PATH, PlaidWebhookKeys } from '@fiscus/aggregation';
import { jsonBody, startFakePlaid, type FakePlaid } from '@fiscus/aggregation/testing';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { LoggerService } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';
import { PlaidWebhookService, WEBHOOK_RATE_LIMIT } from './plaid-webhook.service.js';

/**
 * Plaid's webhooks (#84, ADR 0008 §Sync 2, threat model T10, T32, T33), against the fake Plaid
 * and keys made here: off by default; when on, every request's ES256 JWT is checked with the key
 * for the Item's own credential set, a refusal is 401, counted and not acted on, and a verified
 * webhook only queues a sync or a check.
 */

const WEBHOOK_URL = `https://fiscus.example${PLAID_WEBHOOK_PATH}`;
const HOUSEHOLD_KEYS = { clientId: 'household-client-id-8841', secret: 'household-secret-8841' };

type Res = Awaited<ReturnType<TestClient['request']>>;
const ok = (r: Res) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);

const captured: string[] = [];
const record = (...args: unknown[]) =>
  captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
const logger: LoggerService = {
  log: record,
  error: record,
  warn: record,
  debug: record,
  verbose: record,
  fatal: record,
};

let tdb: TestDatabase;
let plaid: FakePlaid;
let on: NestFastifyApplication;
let off: NestFastifyApplication;
let db: pg.Client;
let A: TestClient;
let hh = '';
let memberId = '';
let setId = '';
let ip = 0;

/** A connection, inserted as the link flow would leave it. */
const connection = async (
  opts: { status?: string; item?: string; set?: string | null; webhookUrl?: string | null } = {},
) => {
  const id = randomUUID();
  const item = opts.item ?? `item-${id}`;
  await db.query(
    `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status,
                              credential_set_id, webhook_url, next_sync_at)
     VALUES ($1, $2, $3, 'plaid', $4, $5, $6, $7, now() + interval '3 hours')`,
    [id, hh, memberId, item, opts.status ?? 'ok', opts.set ?? null, opts.webhookUrl ?? null],
  );
  return { id, item };
};
const row = async (id: string) =>
  (
    await db.query(
      `SELECT status, sync_requested_at, check_requested_at, webhook_enabled FROM connections
       WHERE id = $1`,
      [id],
    )
  ).rows[0];
const counts = async () =>
  Object.fromEntries(
    (
      await db.query(
        `SELECT outcome, sum(count)::int AS n FROM plaid_webhook_stats GROUP BY outcome`,
      )
    ).rows.map((r) => [r.outcome, r.n]),
  );
const keyRequests = () =>
  plaid.requests
    .filter((r) => r.path === '/webhook_verification_key/get')
    .map((r) => jsonBody<{ client_id: string }>(r));

/** POSTs to the receiver, each test from its own address unless told, so rate limits don't mix. */
const post = (
  body: string,
  headers: Record<string, string>,
  { app = on, from = `10.0.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` } = {},
) =>
  app.inject({
    method: 'POST',
    url: PLAID_WEBHOOK_PATH,
    payload: body,
    headers: { 'content-type': 'application/json', ...headers },
    remoteAddress: from,
  });
const webhook = (
  item: string,
  type = 'TRANSACTIONS',
  code = 'SYNC_UPDATES_AVAILABLE',
  extra = {},
) =>
  plaid.signWebhook({
    webhook_type: type,
    webhook_code: code,
    item_id: item,
    environment: 'sandbox',
    ...extra,
  });

beforeAll(async () => {
  tdb = await startTestDatabase();
  plaid = await startFakePlaid({ otherKeys: [HOUSEHOLD_KEYS] });
  const plaidConfig = {
    clientId: plaid.clientId,
    secret: plaid.secret,
    env: 'sandbox' as const,
    apiBaseUrl: plaid.url,
  };
  // The last app made sets Nest's logger for both: `on`'s is the one captured.
  off = await createTestApp(tdb.appUrl, { signupMode: 'open', plaid: plaidConfig });
  on = await createTestApp(
    tdb.appUrl,
    { signupMode: 'open', plaid: plaidConfig, plaidWebhookUrl: WEBHOOK_URL },
    logger,
  );
  db = new pg.Client({ connectionString: tdb.ownerUrl });
  await db.connect();
  A = new TestClient(on);
  await A.post('/api/v1/auth/signup', {
    email: 'alex@webhooks.test',
    password: 'plaid webhooks test Password1!',
    displayName: 'Alex',
  });
  const created = (
    await A.post('/api/v1/households', { name: 'Riveras', baseCurrency: 'USD', timezone: 'UTC' })
  ).body.data;
  hh = created.id;
  memberId = created.you.memberId;
  ok(
    await A.request('PUT', `/api/v1/households/${hh}/plaid-credentials`, {
      ...HOUSEHOLD_KEYS,
      env: 'sandbox',
    }),
  );
  setId = (await db.query('SELECT id FROM aggregation_credentials WHERE household_id = $1', [hh]))
    .rows[0].id;
}, 180_000);

afterAll(async () => {
  await db?.end();
  await on?.close();
  await off?.close();
  await plaid?.close();
  await tdb?.stop();
});

beforeEach(async () => {
  await db.query('DELETE FROM plaid_webhook_stats');
  // A fresh key cache, so no test leans on another's fetches.
  on.get(PlaidWebhookService).keys = new PlaidWebhookKeys();
});

describe('webhooks off (the default)', () => {
  it('answers 404, and link tokens carry no webhook', async () => {
    const { item } = await connection();
    const signed = webhook(item);
    expect((await post(signed.body, signed.headers, { app: off })).statusCode).toBe(404);
    expect(await counts()).toEqual({});

    const B = new TestClient(off);
    await B.post('/api/v1/auth/signup', {
      email: 'sam@webhooks.test',
      password: 'plaid webhooks test Password1!',
      displayName: 'Sam',
    });
    const other = (
      await B.post('/api/v1/households', { name: 'Sam', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
    ok(await B.post(`/api/v1/households/${other}/plaid/link-token`));
    const last = plaid.requests.filter((r) => r.path === '/link/token/create').at(-1)!;
    expect(jsonBody<Record<string, unknown>>(last)).not.toHaveProperty('webhook');
  });
});

describe('webhooks on', () => {
  it('gives new Items the webhook URL, household keys included (WEBHOOK-002)', async () => {
    ok(await A.post(`/api/v1/households/${hh}/plaid/link-token`));
    const last = plaid.requests.filter((r) => r.path === '/link/token/create').at(-1)!;
    expect(jsonBody<Record<string, unknown>>(last)).toMatchObject({
      client_id: HOUSEHOLD_KEYS.clientId,
      webhook: WEBHOOK_URL,
    });
  });

  it('records the Item’s webhook at the exchange, from Plaid', async () => {
    plaid.override('/item/public_token/exchange', () => ({
      body: { access_token: plaid.accessToken, item_id: 'item-exchanged', request_id: 'r' },
    }));
    const r = await A.post(`/api/v1/households/${hh}/plaid/exchange`, {
      publicToken: plaid.publicToken,
    });
    ok(r);
    const { rows } = await db.query(
      'SELECT webhook_url, webhook_enabled FROM connections WHERE id = $1',
      [r.body.data.connectionId],
    );
    expect(rows[0]).toEqual({ webhook_url: WEBHOOK_URL, webhook_enabled: true });
  });

  it('accepts a webhook signed with Plaid’s ES256 key, and only queues a sync', async () => {
    const c = await connection();
    const signed = webhook(c.item);
    const res = await post(signed.body, signed.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(c.id)).toMatchObject({ status: 'ok', check_requested_at: null });
    expect((await row(c.id)).sync_requested_at).toBeInstanceOf(Date);
    expect(await counts()).toEqual({ verified: 1 });
  });

  it('merges repeats for one Item into one sync', async () => {
    const c = await connection();
    const first = webhook(c.item);
    expect((await post(first.body, first.headers)).statusCode).toBe(200);
    const at = (await row(c.id)).sync_requested_at;
    for (let i = 0; i < 3; i++) {
      const again = webhook(c.item);
      expect((await post(again.body, again.headers)).statusCode).toBe(200);
    }
    expect((await row(c.id)).sync_requested_at).toEqual(at);
  });

  it('checks with the key for the Item’s own credential set', async () => {
    const own = await connection({ set: setId });
    const signed = webhook(own.item);
    expect((await post(signed.body, signed.headers)).statusCode).toBe(200);
    expect(keyRequests().at(-1)!.client_id).toBe(HOUSEHOLD_KEYS.clientId);
    const server = await connection();
    const again = webhook(server.item);
    expect((await post(again.body, again.headers)).statusCode).toBe(200);
    expect(keyRequests().at(-1)!.client_id).toBe(plaid.clientId);
    // Each set fetched its own key, though Plaid's kid is the same.
    expect(
      keyRequests()
        .slice(-2)
        .map((k) => k.client_id),
    ).toEqual([HOUSEHOLD_KEYS.clientId, plaid.clientId]);
  });

  it('refuses an Item whose household keys are gone, without trying the server’s', async () => {
    const own = await connection({ set: setId });
    const secret = (
      await db.query('SELECT secret_enc FROM aggregation_credentials WHERE id = $1', [setId])
    ).rows[0].secret_enc;
    await db.query(`UPDATE aggregation_credentials SET secret_enc = '\\x' WHERE id = $1`, [setId]);
    try {
      const before = keyRequests().length;
      const signed = webhook(own.item);
      expect((await post(signed.body, signed.headers)).statusCode).toBe(401);
      expect(keyRequests().length).toBe(before);
      expect(await counts()).toEqual({ unknown_key: 1 });
      expect((await row(own.id)).sync_requested_at).toBeNull();
    } finally {
      await db.query('UPDATE aggregation_credentials SET secret_enc = $2 WHERE id = $1', [
        setId,
        secret,
      ]);
    }
  });

  it('refuses forgeries with 401, counts each by reason, and acts on none (T10)', async () => {
    const c = await connection();
    const good = webhook(c.item);
    const header = good.headers['plaid-verification']!;
    const [h, p] = header.split('.') as [string, string, string];
    const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const hs = part({ alg: 'HS256', kid: plaid.webhookKey.kid });
    const forgeries: [string, Record<string, string>, string][] = [
      ['missing', {}, good.body],
      [
        'algorithm',
        { 'plaid-verification': `${part({ alg: 'none', kid: 'k' })}.${p}.` },
        good.body,
      ],
      [
        'algorithm',
        {
          'plaid-verification': `${hs}.${p}.${createHmac('sha256', 'x').update(`${hs}.${p}`).digest('base64url')}`,
        },
        good.body,
      ],
      ['signature', plaid.signWebhook(good.body, { privateKey }).headers, good.body],
      ['unknown_key', plaid.signWebhook(good.body, { kid: 'kid-nobody-has' }).headers, good.body],
      [
        'stale',
        plaid.signWebhook(good.body, { iat: Math.floor(Date.now() / 1000) - 6 * 60 }).headers,
        good.body,
      ],
      ['body_hash', good.headers, good.body.replace('SYNC_UPDATES_AVAILABLE', 'LOGIN_REPAIRED')],
      ['malformed', { 'plaid-verification': `${h}.${p}` }, good.body],
    ];
    for (const [, headers, body] of forgeries) {
      const res = await post(body, headers);
      expect(res.statusCode, res.body).toBe(401);
      expect(JSON.parse(res.body).code).toBe('webhook_unverified');
    }
    expect(await row(c.id)).toMatchObject({ sync_requested_at: null, check_requested_at: null });
    const expected: Record<string, number> = {};
    for (const [reason] of forgeries) expected[reason] = (expected[reason] ?? 0) + 1;
    expect(await counts()).toEqual(expected);
    // Logged by reason only.
    const refusals = captured.filter((l) => l.includes('Refused a Plaid webhook'));
    expect(refusals.length).toBeGreaterThanOrEqual(forgeries.length);
  });

  it('only queues a check for ITEM_LOGIN_REQUIRED: nothing changes until /item/get says so', async () => {
    const c = await connection();
    const signed = webhook(c.item, 'ITEM', 'ERROR', {
      error: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' },
    });
    expect((await post(signed.body, signed.headers)).statusCode).toBe(200);
    const after = await row(c.id);
    expect(after.status).toBe('ok');
    expect(after.check_requested_at).toBeInstanceOf(Date);
    expect(after.sync_requested_at).toBeNull();
    // A login fixed at the bank reaches a connection waiting for its owner too.
    const waiting = await connection({ status: 'login_required' });
    const repaired = webhook(waiting.item, 'ITEM', 'LOGIN_REPAIRED');
    expect((await post(repaired.body, repaired.headers)).statusCode).toBe(200);
    expect(await row(waiting.id)).toMatchObject({ status: 'login_required' });
    expect((await row(waiting.id)).check_requested_at).toBeInstanceOf(Date);
  });

  it('turns webhook_enabled on when Plaid acknowledges this server’s URL', async () => {
    const moved = await connection({ webhookUrl: WEBHOOK_URL });
    const elsewhere = await connection({ webhookUrl: 'https://old.example/hook' });
    for (const c of [moved, elsewhere]) {
      const ack = webhook(c.item, 'ITEM', 'WEBHOOK_UPDATE_ACKNOWLEDGED', {
        new_webhook_url: WEBHOOK_URL,
      });
      expect((await post(ack.body, ack.headers)).statusCode).toBe(200);
    }
    expect((await row(moved.id)).webhook_enabled).toBe(true);
    expect((await row(elsewhere.id)).webhook_enabled).toBe(false);
  });

  it('answers 200 for a verified webhook for an unknown Item, and counts it', async () => {
    const signed = webhook('item-nobody-here');
    expect((await post(signed.body, signed.headers)).statusCode).toBe(200);
    expect(await counts()).toEqual({ unknown_item: 1 });
  });

  it('answers 200 and does nothing for webhooks it doesn’t act on', async () => {
    const c = await connection();
    const signed = webhook(c.item, 'TRANSACTIONS', 'DEFAULT_UPDATE');
    expect((await post(signed.body, signed.headers)).statusCode).toBe(200);
    expect(await row(c.id)).toMatchObject({ sync_requested_at: null, check_requested_at: null });
    expect(await counts()).toEqual({ verified: 1 });
  });

  it('refuses a body over 16 KB with 413, unread', async () => {
    const c = await connection();
    const big = JSON.stringify({
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: c.item,
      padding: 'x'.repeat(16 * 1024),
    });
    const signed = plaid.signWebhook(big);
    expect((await post(signed.body, signed.headers)).statusCode).toBe(413);
    expect((await row(c.id)).sync_requested_at).toBeNull();
    expect(await counts()).toEqual({});
  });

  it('rate-limits each address (T32): over the limit is 429, and others still get through', async () => {
    const c = await connection();
    const flood = '203.0.113.9';
    for (let i = 0; i < WEBHOOK_RATE_LIMIT.limit; i++) {
      expect((await post('{}', {}, { from: flood })).statusCode).toBe(401);
    }
    const signed = webhook(c.item);
    const limited = await post(signed.body, signed.headers, { from: flood });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await row(c.id)).sync_requested_at).toBeNull();
    expect((await post(signed.body, signed.headers)).statusCode).toBe(200);
  });

  it('caps key fetches (T33): made-up kids cost Plaid ten requests a minute, then 503', async () => {
    const c = await connection();
    const before = keyRequests().length;
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const signed = plaid.signWebhook(webhook(c.item).body, { kid: `made-up-${i}` });
      statuses.push((await post(signed.body, signed.headers)).statusCode);
    }
    expect(keyRequests().length - before).toBe(10);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual(Array(5).fill(503));
    // The same made-up kid again is remembered, not fetched.
    const again = plaid.signWebhook(webhook(c.item).body, { kid: 'made-up-0' });
    expect((await post(again.body, again.headers)).statusCode).toBe(401);
    expect(keyRequests().length - before).toBe(10);
    expect((await row(c.id)).sync_requested_at).toBeNull();
  });

  it('answers 503 when Plaid can’t give the key now, so Plaid sends it again (WEBHOOK-007)', async () => {
    const c = await connection();
    plaid.failNext('/webhook_verification_key/get', {
      error_type: 'API_ERROR',
      error_code: 'INTERNAL_SERVER_ERROR',
    });
    const signed = webhook(c.item);
    expect((await post(signed.body, signed.headers)).statusCode).toBe(503);
    expect((await post(signed.body, signed.headers)).statusCode).toBe(200);
  });

  it('never logs bodies, tokens or item ids', async () => {
    const c = await connection({ item: 'item-QZXV-never-logged' });
    const signed = webhook(c.item, 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE', {
      note: 'Alex Rivera QZXV',
    });
    await post(signed.body, signed.headers);
    await post(signed.body.replace('Alex', 'Sam'), signed.headers);
    const logs = captured.join('\n');
    expect(logs).toContain('Refused a Plaid webhook (body_hash)');
    expect(logs).not.toContain('QZXV');
    expect(logs).not.toContain(signed.headers['plaid-verification']!.split('.')[2]!);
    expect(logs).not.toContain(plaid.secret);
    expect(logs).not.toContain(HOUSEHOLD_KEYS.secret);
  });
});
