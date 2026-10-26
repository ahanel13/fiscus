// SPDX-License-Identifier: AGPL-3.0-or-later
import { RIVERA, startFakePlaid, type FakePlaid } from '@fiscus/aggregation/testing';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Moving a bank to the household's own Plaid keys (#83, D15): connected again with the new keys,
 * the new connection takes over the old one's accounts, keeping their history, and the old one is
 * ended only once that's confirmed. The overlap the new connection sends again is matched, not
 * added twice (D5–D7).
 */

type Res = Awaited<ReturnType<TestClient['request']>>;
const ok = (r: Res) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
const refused = (r: Res, status: number, code?: string) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body.code).toBe(code);
};

const OURS = { clientId: 'household-client-id-5150', secret: 'household-sandbox-secret' };

let tdb: TestDatabase;
let app: NestFastifyApplication;
let plaid: FakePlaid;
let db: pg.Client;
let hh = '';
let A: TestClient;
let B: TestClient;
const url = (p = '') => `/api/v1/households/${hh}${p}`;
const exchanges = () => plaid.requests.filter((r) => r.path === '/item/public_token/exchange');
const connectionRow = async (id: string) =>
  (await db.query('SELECT * FROM connections WHERE id = $1', [id])).rows[0];
const listed = async (c: TestClient, id: string) =>
  ((await c.get(url('/connections'))).body.data as { id: string; onOldKeys: boolean }[]).find(
    (x) => x.id === id,
  );

beforeAll(async () => {
  tdb = await startTestDatabase();
  plaid = await startFakePlaid({ otherKeys: [OURS] });
  let items = 0;
  plaid.override('/item/public_token/exchange', () => ({
    body: { access_token: plaid.accessToken, item_id: `item-move-${++items}`, request_id: 'r' },
  }));
  plaid.override('/item/remove', { body: { request_id: 'r' } });
  app = await createTestApp(tdb.appUrl, {
    signupMode: 'open',
    plaid: {
      clientId: plaid.clientId,
      secret: plaid.secret,
      env: 'sandbox',
      apiBaseUrl: plaid.url,
    },
  });
  db = new pg.Client({ connectionString: tdb.ownerUrl });
  await db.connect();
  let n = 0;
  const signup = async (name: string) => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: `${name.toLowerCase()}${n++}@move.test`,
      password: 'plaid move test Password1!',
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
  const invite = await A.post(url('/invites'), { email: me.email, role: 'member' });
  const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
  ok(await B.post('/api/v1/invites/accept', { token }));
}, 180_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await plaid?.close();
  await tdb?.stop();
});

describe('moving a bank to the household’s own keys (#83)', () => {
  let old = '';
  const acct = { checking: '', savings: '' };
  const txn = { before: '', overlap: '', pending: '' };

  beforeAll(async () => {
    // On the server's keys: checking and savings as new accounts, the rest not tracked.
    const setup = await A.post(url('/plaid/exchange'), { publicToken: plaid.publicToken });
    ok(setup);
    old = setup.body.data.connectionId;
    const confirmed = await A.post(url(`/connections/${old}/confirm`), {
      accounts: (setup.body.data.accounts as { providerAccountId: string }[]).map((a) =>
        a.providerAccountId === RIVERA.checking || a.providerAccountId === RIVERA.savings
          ? { providerAccountId: a.providerAccountId, choice: 'new' }
          : { providerAccountId: a.providerAccountId, choice: 'skip' },
      ),
    });
    ok(confirmed);
    const tracked = confirmed.body.data.accounts as {
      providerAccountId: string;
      accountId: string;
    }[];
    acct.checking = tracked.find((t) => t.providerAccountId === RIVERA.checking)!.accountId;
    acct.savings = tracked.find((t) => t.providerAccountId === RIVERA.savings)!.accountId;
    // What its syncs brought in: one before the overlap, one in it, and one still pending.
    const synced = async (id: string, date: string, pending: boolean) =>
      (
        await db.query(
          `INSERT INTO transactions (household_id, id, account_id, amount_minor, currency,
             authorized_date, posted_date, pending, original_description, display_name, source,
             provider_transaction_id)
           VALUES ($1, gen_random_uuid(), $2, -1800, 'USD', $3, $4, $5, 'HARBOR CAFE', 'Harbor Cafe',
             'provider', $6)
           RETURNING id`,
          [hh, acct.checking, date, pending ? null : date, pending, id],
        )
      ).rows[0].id as string;
    txn.before = await synced('old-before', '2026-05-01', false);
    txn.overlap = await synced('old-overlap', '2026-05-20', false);
    txn.pending = await synced('old-pending', '2026-05-21', true);
  });

  it('says a bank is on old keys once the household has its own', async () => {
    expect(await listed(A, old)).toMatchObject({ onOldKeys: false });
    refused(
      await A.post(url('/plaid/exchange'), { publicToken: plaid.publicToken, replaces: old }),
      409,
      'same_keys',
    );
    ok(await A.request('PUT', url('/plaid-credentials'), { ...OURS, env: 'sandbox' }));
    expect(await listed(A, old)).toMatchObject({ onOldKeys: true });
    // New banks connect through the household's account now, and the connect page says so.
    expect((await A.get(url('/plaid'))).body.data).toEqual({
      available: true,
      env: 'sandbox',
      keys: 'household',
    });
    // Whoever sees its accounts sees it too, and the same flag.
    await db.query(`UPDATE accounts SET visibility = 'full' WHERE id = $1`, [acct.checking]);
    expect(await listed(B, old)).toMatchObject({ onOldKeys: true });
  });

  it('is its owner’s to move, and only to the same bank, refused before Plaid bills a new Item', async () => {
    const before = exchanges().length;
    refused(
      await B.post(url('/plaid/exchange'), { publicToken: plaid.publicToken, replaces: old }),
      403,
    );
    refused(
      await A.post(url('/plaid/exchange'), {
        publicToken: plaid.publicToken,
        replaces: old,
        link: { sessionId: 'session-move', institutionId: 'ins_somewhere_else', accounts: [] },
      }),
      422,
      'different_bank',
    );
    expect(exchanges()).toHaveLength(before);
    expect((await connectionRow(old)).status).toBe('ok');
  });

  it('suggests the old connection’s accounts, then takes them over and ends it', async () => {
    // The same bank by Link's word: no "already connected", as this is the point.
    const setup = await A.post(url('/plaid/exchange'), {
      publicToken: plaid.publicToken,
      replaces: old,
      link: {
        sessionId: 'session-move',
        institutionId: 'ins_harbor_cu',
        accounts: [{ mask: '4410', subtype: 'checking' }],
      },
    });
    ok(setup);
    const moved = setup.body.data;
    expect(moved.replacesConnectionId).toBe(old);
    const suggestion = (id: string) =>
      (moved.accounts as { providerAccountId: string; suggestion: unknown }[]).find(
        (a) => a.providerAccountId === id,
      )!.suggestion;
    expect(suggestion(RIVERA.checking)).toEqual({
      choice: 'link',
      accountId: acct.checking,
      by: 'mask',
    });
    expect(suggestion(RIVERA.savings)).toMatchObject({ choice: 'link', accountId: acct.savings });
    // A reload offers the same.
    const again = (await A.get(url(`/connections/${moved.connectionId}/setup`))).body.data;
    expect(again.replacesConnectionId).toBe(old);
    expect(again.accounts).toEqual(moved.accounts);
    // The old one keeps working until this is confirmed.
    expect((await connectionRow(old)).status).toBe('ok');
    expect(await connectionRow(moved.connectionId)).toMatchObject({
      replaces_connection_id: old,
      provider_client_id: OURS.clientId,
    });

    const confirmed = await A.post(url(`/connections/${moved.connectionId}/confirm`), {
      accounts: (moved.accounts as { providerAccountId: string; suggestion: any }[]).map((a) =>
        a.suggestion.choice === 'link'
          ? {
              providerAccountId: a.providerAccountId,
              choice: 'link',
              accountId: a.suggestion.accountId,
            }
          : { providerAccountId: a.providerAccountId, choice: 'skip' },
      ),
    });
    ok(confirmed);
    expect(confirmed.body.data.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: acct.checking, linked: true, syncFrom: '2026-05-14' }),
      ]),
    );
    const accounts = await db.query('SELECT id, connection_id FROM accounts WHERE id = ANY($1)', [
      [acct.checking, acct.savings],
    ]);
    expect(accounts.rows.every((r) => r.connection_id === moved.connectionId)).toBe(true);
    // Ended, for the worker to remove at Plaid with its own keys.
    expect(await connectionRow(old)).toMatchObject({
      status: 'disconnected',
      disconnect_requested: true,
    });
    expect(await connectionRow(moved.connectionId)).toMatchObject({ status: 'ok' });
    expect(await listed(A, moved.connectionId)).toMatchObject({ onOldKeys: false });

    // History stays. The overlap lets go of the old ids, so the new sync matches it (D7); the
    // pending one is dropped, as the bank sends it again.
    const rows = (
      await db.query(
        `SELECT id, provider_transaction_id, deleted_at IS NOT NULL AS deleted,
           provider_removed_at IS NOT NULL AS removed
         FROM transactions WHERE account_id = $1`,
        [acct.checking],
      )
    ).rows;
    const row = (id: string) => rows.find((r) => r.id === id);
    expect(row(txn.before)).toMatchObject({
      provider_transaction_id: 'old-before',
      deleted: false,
    });
    expect(row(txn.overlap)).toMatchObject({ provider_transaction_id: null, deleted: false });
    expect(row(txn.pending)).toMatchObject({ deleted: true, removed: true });

    const added = await db.query(
      `SELECT metadata FROM audit_events WHERE household_id = $1 AND action = 'connection.added'
         AND target_id = $2`,
      [hh, moved.connectionId],
    );
    expect(added.rows.map((r) => r.metadata)).toEqual([
      { provider: 'plaid', linked: true, moved: true },
      { provider: 'plaid', linked: true, moved: true },
    ]);
  });

  it('can’t move a bank that’s ended', async () => {
    refused(
      await A.post(url('/plaid/exchange'), { publicToken: plaid.publicToken, replaces: old }),
      409,
      'connection_disconnected',
    );
  });
});
