// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

const PASSWORD = 'moving out Password1!';

/**
 * Moving out through the api (#253, HH-20, D37): the preview, who can start it and when, and what
 * starting it makes. The move itself is the worker's (apps/worker move-out).
 */
describe('moving out', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client;
  let ann: TestClient; // owner
  let ben: TestClient; // member
  let vic: TestClient; // viewer
  let hid: string;
  const ids: Record<string, string> = {};
  const url = (path = '') => `/api/v1/households/${hid}/move-out${path}`;

  async function user(name: string) {
    const c = new TestClient(app);
    const res = await c.post('/api/v1/auth/signup', {
      email: `${name}@moving.test`,
      password: PASSWORD,
      displayName: name[0]!.toUpperCase() + name.slice(1),
    });
    expect(res.status).toBe(201);
    return c;
  }

  async function account(name: string, owners: string[]) {
    const id = randomUUID();
    await owner.query('BEGIN');
    await owner.query(
      `INSERT INTO accounts (id, household_id, name, type, currency, visibility, balance_mode)
       VALUES ($1, $2, $3, 'depository', 'USD', 'private', 'transactions')`,
      [id, hid, name],
    );
    for (const [i, m] of owners.entries()) {
      await owner.query(
        `INSERT INTO account_owners (account_id, member_id, household_id, share_bps)
         VALUES ($1, $2, $3, $4)`,
        [id, m, hid, owners.length === 1 ? 10000 : i === 0 ? 6000 : 4000],
      );
    }
    await owner.query('COMMIT');
    return id;
  }

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    [ann, ben, vic] = await Promise.all([user('ann'), user('ben'), user('vic')]);
    const created = await ann.post('/api/v1/households', {
      name: 'Our Home',
      baseCurrency: 'EUR',
      timezone: 'Europe/Berlin',
      weekStart: 0,
    });
    hid = created.body.data.id;
    ids.ann = created.body.data.you.memberId;
    for (const [c, name, role] of [
      [ben, 'ben', 'member'],
      [vic, 'vic', 'viewer'],
    ] as const) {
      const inv = await ann.post(`/api/v1/households/${hid}/invites`, {
        email: `${name}@moving.test`,
        role,
      });
      const token = new URLSearchParams(new URL(inv.body.data.url).hash.slice(1)).get('token');
      const res = await c.post('/api/v1/invites/accept', { token });
      expect(res.status).toBe(200);
      ids[name] = res.body.data.memberId;
    }
    ids.checking = await account('Ben’s checking', [ids.ben!]);
    ids.joint = await account('Joint', [ids.ben!, ids.ann!]);
    await account('Ann’s card', [ids.ann!]);
    const groceries = await owner.query(
      `SELECT id FROM categories WHERE household_id = $1 AND name = 'Groceries'`,
      [hid],
    );
    await owner.query(
      `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency,
         authorized_date, original_description, display_name, source, category_id)
       VALUES ($1, $2, $3, -2500, 'EUR', current_date, 'Shop', 'Shop', 'manual', $4)`,
      [randomUUID(), hid, ids.checking, groceries.rows[0].id],
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([app?.close(), owner?.end()]);
    await tdb?.stop();
  });

  it('[HH-20/MEM] previews what moves, what stays and what’s copied, about you only', async () => {
    const res = await ben.get(url('/preview'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body.data;
    expect(p.blockers).toEqual([]);
    expect(p.moving).toBeNull();
    expect(p.moves.accounts).toEqual([
      { id: ids.checking, name: 'Ben’s checking', transactionCount: 1, connection: null },
    ]);
    expect(p.stays.jointAccounts).toEqual([
      {
        id: ids.joint,
        name: 'Joint',
        relink: false,
        owners: [{ memberId: ids.ann, displayName: 'Ann', shareBps: 10000 }],
      },
    ]);
    expect(p.copied.categories).toEqual([
      expect.objectContaining({ name: 'Groceries', groupName: 'Food' }),
    ]);
    expect(p.household).toEqual({
      name: 'Our Home',
      baseCurrency: 'EUR',
      timezone: 'Europe/Berlin',
    });
    expect(p.settleUp).toEqual([]);
    // Ann's own account isn't in anything Ben sees.
    expect(JSON.stringify(p)).not.toContain('Ann’s card');
  });

  it('[HH-20/OWN] refuses the only owner, and says why', async () => {
    const res = await ann.get(url('/preview'));
    expect(res.body.data.blockers).toEqual(['last_owner']);
    const start = await ann.post(url(), { name: 'Ann alone' });
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('move_out_blocked');
    expect(start.body.blockers).toEqual(['last_owner']);
  });

  it('needs a recent sign-in to start', async () => {
    await owner.query(
      `UPDATE sessions SET reauthenticated_at = now() - interval '1 hour'
       WHERE user_id = (SELECT id FROM users WHERE email = 'ben@moving.test')`,
    );
    const res = await ben.post(url(), { name: 'Ben’s place' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    await owner.query(
      `UPDATE sessions SET reauthenticated_at = now()
       WHERE user_id = (SELECT id FROM users WHERE email = 'ben@moving.test')`,
    );
  });

  it('[HH-20/MEM] starts it: a household of their own, its settings copied, and the move in it', async () => {
    const res = await ben.post(url(), { name: 'Ben’s place' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { householdId, moveId } = res.body.data;
    const home = await ben.get(`/api/v1/households/${householdId}`);
    expect(home.body.data).toMatchObject({
      name: 'Ben’s place',
      baseCurrency: 'EUR',
      timezone: 'Europe/Berlin',
      weekStart: 0,
      you: { role: 'owner' },
    });
    const moveIn = await ben.get(`/api/v1/households/${householdId}/move-in`);
    expect(moveIn.body.data).toMatchObject({ id: moveId, status: 'pending', step: 0, steps: 5 });
    // The household being left learns nothing of it yet, and never where they went.
    const { rows } = await owner.query(
      `SELECT action FROM audit_events WHERE household_id = $1 AND (action LIKE 'member_move%'
         OR metadata::text LIKE '%' || $2 || '%')`,
      [hid, householdId],
    );
    expect(rows).toEqual([]);
    expect((await ann.get(`/api/v1/households/${householdId}/move-in`)).status).toBe(404);
    // Ben sees it's under way, and can't start another.
    expect((await ben.get(url('/preview'))).body.data.moving).toEqual({ householdId });
    const again = await ben.post(url(), { name: 'Elsewhere' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_moving');
  });

  it('[HH-20/VIEW] lets a viewer move out too: nobody can stop it', async () => {
    const preview = await vic.get(url('/preview'));
    expect(preview.body.data.blockers).toEqual([]);
    expect(preview.body.data.moves.accounts).toEqual([]);
    const res = await vic.post(url(), { name: 'Vic’s' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('checks the name', async () => {
    const res = await ann.post(url(), { name: '' });
    expect(res.status).toBe(422);
  });
});
