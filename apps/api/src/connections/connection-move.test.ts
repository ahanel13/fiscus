// SPDX-License-Identifier: AGPL-3.0-or-later
import { RIVERA, startFakeSimpleFin, type FakeSimpleFin } from '@fiscus/aggregation/testing';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Moving an account from one bank connection to another (Plaid to SimpleFIN, or back): connecting
 * the bank the other way suggests not tracking it twice, linking it moves it with its history, and
 * the connection it left ends once it syncs nothing. Someone else's connection keeps its accounts.
 */

type Res = Awaited<ReturnType<TestClient['request']>>;
const ok = (r: Res) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);

let tdb: TestDatabase;
let app: NestFastifyApplication;
let bridge: FakeSimpleFin;
let db: pg.Client;
let hh = '';
let A: TestClient;
const member = { A: '', B: '' };
const user = { A: '', B: '' };
const url = (p = '') => `/api/v1/households/${hh}${p}`;
const acct = { checking: '', visa: '', brokerage: '', savings: '' };
const conn = { chase: '', amex: '', sams: '', simplefin: '' };

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
      email: `${name.toLowerCase()}${n++}@move.test`,
      password: 'connection move Password1!',
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
  user.A = (await A.get('/api/v1/me')).body.data.id;
  const B = await signup('Sam');
  const me = (await B.get('/api/v1/me')).body.data;
  user.B = me.id;
  const invite = await A.post(url('/invites'), { email: me.email, role: 'member' });
  const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
  ok(await B.post('/api/v1/invites/accept', { token }));
  member.B = (await B.get(url())).body.data.you.memberId;

  // Alex's accounts, as Plaid synced them: Chase syncs the checking alone, Amex the card and a
  // brokerage account; Sam's connection syncs Alex's savings.
  const plaid = async (owner: string, item: string) =>
    (
      await db.query(
        `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status)
         VALUES (gen_random_uuid(), $1, $2, 'plaid', $3, 'ok') RETURNING id`,
        [hh, owner, item],
      )
    ).rows[0].id as string;
  conn.chase = await plaid(member.A, 'item-chase');
  conn.amex = await plaid(member.A, 'item-amex');
  conn.sams = await plaid(member.B, 'item-sams');
  const account = async (name: string, type: string, mask: string, c: string, p: string) => {
    const r = await A.post(url('/accounts'), { name, type, mask });
    ok(r);
    await db.query(
      'UPDATE accounts SET connection_id = $2, provider_account_id = $3 WHERE id = $1',
      [r.body.data.id, c, p],
    );
    return r.body.data.id as string;
  };
  acct.checking = await account('Harbor CU Checking', 'depository', '4410', conn.chase, 'p-chk');
  acct.visa = await account('Harbor CU Visa', 'credit', '3301', conn.amex, 'p-visa');
  acct.brokerage = await account('Brokerage', 'investment', '9001', conn.amex, 'p-brk');
  acct.savings = await account('Rainy day', 'depository', '8812', conn.sams, 'p-sav');
}, 180_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await bridge?.close();
  await tdb?.stop();
});

const status = async (id: string) =>
  (await db.query('SELECT status, disconnect_requested FROM connections WHERE id = $1', [id]))
    .rows[0];
const syncsFrom = async (id: string) =>
  (await db.query('SELECT connection_id FROM accounts WHERE id = $1', [id])).rows[0].connection_id;

describe('moving accounts between bank connections', () => {
  it('suggests not tracking twice what another of your connections syncs', async () => {
    const r = await A.post(url('/simplefin/connect'), { setupToken: bridge.setupToken });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    conn.simplefin = r.body.data.connectionId;
    const offered = Object.fromEntries(
      (r.body.data.accounts as any[]).map((a) => [a.providerAccountId, a.suggestion]),
    );
    expect(offered[RIVERA.checking]).toEqual({
      choice: 'skip',
      reason: 'synced',
      accountId: acct.checking,
    });
    expect(offered[RIVERA.visa]).toEqual({
      choice: 'skip',
      reason: 'synced',
      accountId: acct.visa,
    });
    // Sam's connection syncs the savings: not one Alex can move, so not suggested.
    expect(offered[RIVERA.savings]).toMatchObject({ choice: 'new' });
  });

  it('refuses to take an account from someone else’s connection', async () => {
    const r = await A.post(url(`/connections/${conn.simplefin}/confirm`), {
      accounts: [
        { providerAccountId: RIVERA.checking, choice: 'skip' },
        { providerAccountId: RIVERA.visa, choice: 'skip' },
        { providerAccountId: RIVERA.savings, choice: 'link', accountId: acct.savings },
        { providerAccountId: RIVERA.oldSavings, choice: 'skip' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe('account_already_connected');
    expect(await syncsFrom(acct.savings)).toBe(conn.sams);
  });

  it('moves linked accounts here, and ends a connection left syncing nothing', async () => {
    ok(
      await A.post(url(`/connections/${conn.simplefin}/confirm`), {
        accounts: [
          { providerAccountId: RIVERA.checking, choice: 'link', accountId: acct.checking },
          { providerAccountId: RIVERA.visa, choice: 'link', accountId: acct.visa },
          { providerAccountId: RIVERA.savings, choice: 'skip' },
          { providerAccountId: RIVERA.oldSavings, choice: 'skip' },
        ],
      }),
    );
    expect(await syncsFrom(acct.checking)).toBe(conn.simplefin);
    expect(await syncsFrom(acct.visa)).toBe(conn.simplefin);
    // Chase synced only the checking: it ends, at Plaid too (the worker's disconnect_requested).
    expect(await status(conn.chase)).toEqual({
      status: 'disconnected',
      disconnect_requested: true,
    });
    // Amex still syncs the brokerage account; Sam's is untouched.
    expect(await status(conn.amex)).toEqual({ status: 'ok', disconnect_requested: false });
    expect(await syncsFrom(acct.brokerage)).toBe(conn.amex);
    expect(await syncsFrom(acct.savings)).toBe(conn.sams);
    const moved = (
      await db.query(
        `SELECT metadata FROM audit_events
          WHERE action = 'connection.added' AND target_id = $1`,
        [conn.simplefin],
      )
    ).rows;
    expect(moved.every((m) => m.metadata.moved === true)).toBe(true);
    expect(moved).toHaveLength(2);
  });

  it('answers whether a connection syncs anything to its owner only', async () => {
    const ask = async (who: 'A' | 'B', id: string) => {
      await db.query('BEGIN');
      try {
        await db.query(
          `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                  set_config('app.user_id', $3, true), set_config('app.system', 'off', true)`,
          [hh, member[who], user[who]],
        );
        return (await db.query('SELECT fiscus_connection_has_accounts($1) AS has', [id])).rows[0]
          .has;
      } finally {
        await db.query('ROLLBACK');
      }
    };
    expect(await ask('A', conn.amex)).toBe(true);
    expect(await ask('A', conn.chase)).toBe(false);
    expect(await ask('B', conn.amex)).toBe(null);
  });
});
