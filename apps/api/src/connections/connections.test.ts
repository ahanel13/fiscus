// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * A connection day to day (#81, the bank connections walkthrough §5–§6, D10–D12): its status for
 * whoever sees its accounts, "Refresh now" and its limit, and signing in again. Connections are
 * made directly here; the link flow is plaid-link.test.ts.
 */

type Res = Awaited<ReturnType<TestClient['request']>>;
const ok = (r: Res) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
const refused = (r: Res, status: number, code?: string) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body.code).toBe(code);
};

let tdb: TestDatabase;
let app: NestFastifyApplication;
let db: pg.Client;
let hh = '';
let A: TestClient;
let B: TestClient;
let V: TestClient;
const member = { A: '', B: '' };
const url = (p = '') => `/api/v1/households/${hh}${p}`;

/** A connection owned by `memberId`, syncing these accounts, with these columns set. */
const connection = async (
  memberId: string,
  accountIds: string[],
  set: { status?: string; provider?: string; firstFailedAgo?: string } = {},
) => {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status,
       first_failed_at, next_sync_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - $7::interval, now() + interval '4 hours')`,
    [
      id,
      hh,
      memberId,
      set.provider ?? 'plaid',
      `item-${id}`,
      set.status ?? 'ok',
      set.firstFailedAgo ?? null,
    ],
  );
  await db.query('UPDATE accounts SET connection_id = $1 WHERE id = ANY($2)', [id, accountIds]);
  return id;
};
const account = async (c: TestClient, visibility = 'full') => {
  const r = await c.post(url('/accounts'), { name: 'Checking', type: 'depository', visibility });
  ok(r);
  return r.body.data.id as string;
};
const listed = async (c: TestClient, id: string) =>
  ((await c.get(url('/connections'))).body.data as any[]).find((x) => x.id === id);
const row = async (id: string) =>
  (await db.query('SELECT * FROM connections WHERE id = $1', [id])).rows[0];
const dueNow = (r: { next_sync_at: Date }) => r.next_sync_at.getTime() <= Date.now() + 1000;

beforeAll(async () => {
  tdb = await startTestDatabase();
  app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
  db = new pg.Client({ connectionString: tdb.ownerUrl });
  await db.connect();
  let n = 0;
  const signup = async (name: string) => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: `${name.toLowerCase()}${n++}@connections.test`,
      password: 'connections test Password1!',
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
  member.B = (await B.get(url())).body.data.you.memberId;
}, 180_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await tdb?.stop();
});

describe('a connection day to day (#81)', () => {
  it('[TXN-008] says while Plaid is still sending older history; SimpleFIN never does', async () => {
    const plaid = await connection(member.A, [await account(A)]);
    const simplefin = await connection(member.A, [await account(A)], { provider: 'simplefin' });
    expect((await listed(A, plaid)).importingHistory).toBe(true);
    expect((await listed(A, simplefin)).importingHistory).toBe(false);
    await db.query('UPDATE connections SET historical_complete = true WHERE id = $1', [plaid]);
    expect((await listed(A, plaid)).importingHistory).toBe(false);
  });

  it('[D11, D12] tells everyone who sees its accounts how it is, and which accounts', async () => {
    const shared = await account(A);
    const mine = await account(A, 'private');
    const id = await connection(member.A, [shared, mine], {
      status: 'login_required',
      firstFailedAgo: '2 hours',
    });
    const forA = await listed(A, id);
    expect(forA).toMatchObject({
      status: 'login_required',
      owner: { memberId: member.A, name: 'Alex' },
      accountCount: 2,
      notWorking: false,
      refreshAvailableAt: null,
    });
    expect(forA.accountIds.sort()).toEqual([shared, mine].sort());
    expect(Date.now() - Date.parse(forA.failingSince)).toBeGreaterThan(60 * 60_000);
    // Sam sees it too, with only the account Sam sees.
    const forB = await listed(B, id);
    expect(forB).toMatchObject({ status: 'login_required', accountIds: [shared], accountCount: 1 });
  });

  it('says a connection failing for 3 days is not working; a working one has no failure', async () => {
    const acc = await account(A);
    const stale = await connection(member.A, [acc], {
      status: 'error',
      firstFailedAgo: '73 hours',
    });
    expect(await listed(A, stale)).toMatchObject({ status: 'error', notWorking: true });
    const recent = await connection(member.A, [acc], {
      status: 'error',
      firstFailedAgo: '71 hours',
    });
    expect(await listed(A, recent)).toMatchObject({ notWorking: false });
    // first_failed_at left over on a working one isn't a failure.
    const fine = await connection(member.A, [acc], { firstFailedAgo: '80 hours' });
    expect(await listed(A, fine)).toMatchObject({ failingSince: null, notWorking: false });
  });

  describe('Refresh now (D10)', () => {
    it('makes it due now, then refuses another within 15 minutes, saying when', async () => {
      const id = await connection(member.A, [await account(A)]);
      const r = await A.post(url(`/connections/${id}/refresh`));
      ok(r);
      expect(dueNow(await row(id))).toBe(true);
      const until = Date.parse(r.body.data.refreshAvailableAt);
      expect(until - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000);

      const again = await A.post(url(`/connections/${id}/refresh`));
      refused(again, 429, 'refresh_too_soon');
      expect(again.body.availableAt).toBe(r.body.data.refreshAvailableAt);
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(14 * 60);
      expect(again.body.detail).toContain('every 15 minutes');

      // After the limit, it works again.
      await db.query(
        `UPDATE connections SET refresh_requested_at = now() - interval '16 minutes' WHERE id = $1`,
        [id],
      );
      expect((await listed(A, id)).refreshAvailableAt).toBeNull();
      ok(await A.post(url(`/connections/${id}/refresh`)));
    });

    it('allows SimpleFIN one every 6 hours', async () => {
      const id = await connection(member.A, [await account(A)], { provider: 'simplefin' });
      ok(await A.post(url(`/connections/${id}/refresh`)));
      const again = await A.post(url(`/connections/${id}/refresh`));
      refused(again, 429, 'refresh_too_soon');
      expect(Date.parse(again.body.availableAt) - Date.now()).toBeGreaterThan(5.9 * 3_600_000);
      expect(again.body.detail).toContain('SimpleFIN');
    });

    it('[ACC-03] is its owner’s: others who see it can’t, and one needing sign-in signs in first', async () => {
      const acc = await account(A);
      const id = await connection(member.A, [acc]);
      refused(await B.post(url(`/connections/${id}/refresh`)), 403);
      refused(await V.post(url(`/connections/${id}/refresh`)), 403);
      refused(await A.post(url(`/connections/${crypto.randomUUID()}/refresh`)), 404);
      // Sam can't see Alex's private one at all.
      const hidden = await connection(member.A, [await account(A, 'private')]);
      refused(await B.post(url(`/connections/${hidden}/refresh`)), 404);

      const broken = await connection(member.A, [acc], { status: 'login_required' });
      refused(await A.post(url(`/connections/${broken}/refresh`)), 409, 'login_required');
      const setup = await connection(member.A, [], { status: 'setup' });
      refused(await A.post(url(`/connections/${setup}/refresh`)), 409, 'connection_in_setup');
      expect(dueNow(await row(broken))).toBe(false);
    });

    it('works while it’s failing, cutting its backoff short', async () => {
      const id = await connection(member.A, [await account(A)], {
        status: 'error',
        firstFailedAgo: '1 hour',
      });
      ok(await A.post(url(`/connections/${id}/refresh`)));
      expect(await row(id)).toMatchObject({ status: 'error' });
      expect(dueNow(await row(id))).toBe(true);
    });
  });

  describe('signing in again (D11)', () => {
    it('puts it back to ok and syncs it now, for everyone to see', async () => {
      const acc = await account(A);
      const id = await connection(member.A, [acc], {
        status: 'login_required',
        firstFailedAgo: '5 hours',
      });
      await db.query(
        `UPDATE connections SET last_error_code = 'ITEM_LOGIN_REQUIRED', consecutive_failures = 3
         WHERE id = $1`,
        [id],
      );
      const r = await A.post(url(`/connections/${id}/reauthed`));
      ok(r);
      expect(r.body.data).toMatchObject({ status: 'ok', failingSince: null });
      const after = await row(id);
      expect(after).toMatchObject({
        status: 'ok',
        last_error_code: null,
        first_failed_at: null,
        consecutive_failures: 0,
      });
      expect(dueNow(after)).toBe(true);
      expect(await listed(B, id)).toMatchObject({ status: 'ok' });
      const feed = (await B.get(url('/activity?limit=50'))).body.data as any[];
      expect(feed.some((e) => e.action === 'connection.signed_in_again' && e.targetId === id)).toBe(
        true,
      );
    });

    it('[ACC-03] is its owner’s only', async () => {
      const id = await connection(member.A, [await account(A)], { status: 'login_required' });
      refused(await B.post(url(`/connections/${id}/reauthed`)), 403);
      refused(await V.post(url(`/connections/${id}/reauthed`)), 403);
      const setup = await connection(member.A, [], { status: 'setup' });
      refused(await A.post(url(`/connections/${setup}/reauthed`)), 409, 'connection_in_setup');
      expect(await row(id)).toMatchObject({ status: 'login_required' });
    });
  });
});
