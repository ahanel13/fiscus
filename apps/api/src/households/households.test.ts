// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

const PASSWORD = 'household test password';

describe('households, members, and invites', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication; // signup open, to create test users quickly
  let inviteOnlyApp: NestFastifyApplication;
  let closedApp: NestFastifyApplication;
  let owner: pg.Client;
  let ann: TestClient; // owner
  let ben: TestClient; // member
  let vic: TestClient; // viewer
  let oscar: TestClient; // outsider
  let hid: string;
  const ids: Record<string, string> = {};

  const sql = async (text: string, params: unknown[] = []) =>
    (await owner.query(text, params)).rows;
  const tokenFrom = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;

  async function user(name: string, a = app) {
    const c = new TestClient(a);
    const res = await c.post('/api/v1/auth/signup', {
      email: `${name}@fiscus.test`,
      password: PASSWORD,
      displayName: name[0]!.toUpperCase() + name.slice(1),
    });
    expect(res.status).toBe(201);
    return c;
  }
  async function invite(email: string, role: string) {
    const res = await ann.post(`/api/v1/households/${hid}/invites`, { email, role });
    expect(res.status).toBe(201);
    return tokenFrom(res.body.data.url);
  }

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    inviteOnlyApp = await createTestApp(tdb.appUrl, { signupMode: 'invite_only' });
    closedApp = await createTestApp(tdb.appUrl, { signupMode: 'closed' });
    [ann, ben, vic, oscar] = await Promise.all([
      user('ann'),
      user('ben'),
      user('vic'),
      user('oscar'),
    ]);

    const created = await ann.post('/api/v1/households', {
      name: 'Our Home',
      baseCurrency: 'usd',
      timezone: 'America/Chicago',
    });
    expect(created.status).toBe(201);
    hid = created.body.data.id;
    ids.ann = created.body.data.you.memberId;

    for (const [c, name, role] of [
      [ben, 'ben', 'member'],
      [vic, 'vic', 'viewer'],
    ] as const) {
      const token = await invite(`${name}@fiscus.test`, role);
      const res = await c.post('/api/v1/invites/accept', { token });
      expect(res.status).toBe(200);
      ids[name] = res.body.data.memberId;
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all([app?.close(), inviteOnlyApp?.close(), closedApp?.close(), owner?.end()]);
    await tdb?.stop();
  });

  describe('creation', () => {
    it('makes the creator owner, normalizes currency, and generates the data key atomically', async () => {
      const res = await ann.get(`/api/v1/households/${hid}`);
      expect(res.body.data).toMatchObject({
        name: 'Our Home',
        baseCurrency: 'USD',
        financeStyle: 'hybrid',
        you: { role: 'owner' },
      });
      expect(
        await sql('SELECT version FROM household_keys WHERE household_id = $1', [hid]),
      ).toEqual([{ version: 1 }]);
    });

    it('rejects unknown currencies and time zones', async () => {
      const res = await ann.post('/api/v1/households', {
        name: 'X',
        baseCurrency: 'ABC',
        timezone: 'Mars/Olympus',
      });
      expect(res.status).toBe(422);
      expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
        'baseCurrency',
        'timezone',
      ]);
    });

    it('lists memberships on /me', async () => {
      const me = (await ben.get('/api/v1/me')).body.data;
      expect(me.memberships).toEqual([
        { householdId: hid, householdName: 'Our Home', memberId: ids.ben, role: 'member' },
      ]);
    });
  });

  describe('HH-01 read settings', () => {
    it.each([
      ['owner', () => ann, 200],
      ['member', () => ben, 200],
      ['viewer', () => vic, 200],
      ['outsider', () => oscar, 404],
    ] as const)('%s → %i', async (_, c, status) => {
      expect((await c().get(`/api/v1/households/${hid}`)).status).toBe(status);
    });

    it('404s malformed and unknown ids alike', async () => {
      expect((await ann.get('/api/v1/households/not-a-uuid')).status).toBe(404);
      expect((await ann.get(`/api/v1/households/${crypto.randomUUID()}`)).status).toBe(404);
    });
  });

  describe('HH-02 update settings', () => {
    const patch = (c: TestClient, body: object) =>
      c.request('PATCH', `/api/v1/households/${hid}`, body);
    const withIfMatch = (c: TestClient, body: object, version: number) =>
      c.request('PATCH', `/api/v1/households/${hid}`, body, {
        headers: { 'if-match': `"v${version}"` },
      });

    it('requires If-Match', async () => {
      const res = await patch(ann, { name: 'X' });
      expect(res.status).toBe(428);
      expect(res.body.code).toBe('precondition_required');
    });

    it.each([
      ['member', () => ben, 403],
      ['viewer', () => vic, 403],
      ['outsider', () => oscar, 404],
    ] as const)('%s → %i', async (_, c, status) => {
      expect((await withIfMatch(c(), { name: 'Hijacked' }, 1)).status).toBe(status);
    });

    it('first save wins per field; other fields still merge', async () => {
      const v1 = (await ann.get(`/api/v1/households/${hid}`)).body.data.version;
      const first = await withIfMatch(ann, { name: 'Casa' }, v1);
      expect(first.status).toBe(200);
      expect(first.headers.etag).toBe(`"v${v1 + 1}"`);

      const stale = await withIfMatch(ann, { name: 'Maison' }, v1);
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('edit_conflict');
      expect(stale.body.conflicts).toEqual([
        { field: 'name', yourValue: 'Maison', currentValue: 'Casa', changedInVersion: v1 + 1 },
      ]);

      const merged = await withIfMatch(ann, { weekStart: 0 }, v1);
      expect(merged.status).toBe(200);
      expect(merged.body.data).toMatchObject({ name: 'Casa', weekStart: 0, version: v1 + 2 });
    });
  });

  describe('HH-03 members list', () => {
    it('shows members to everyone, emails only to owners', async () => {
      const asOwner = (await ann.get(`/api/v1/households/${hid}/members`)).body.data;
      const asViewer = (await vic.get(`/api/v1/households/${hid}/members`)).body.data;
      expect(asOwner.map((m: { email?: string }) => m.email)).toEqual([
        'ann@fiscus.test',
        'ben@fiscus.test',
        'vic@fiscus.test',
      ]);
      expect(asViewer.every((m: { email?: string }) => m.email === undefined)).toBe(true);
      expect(asViewer.find((m: { isYou: boolean }) => m.isYou).role).toBe('viewer');
      expect(new Set(asOwner.map((m: { color: string }) => m.color)).size).toBe(3);
      expect((await oscar.get(`/api/v1/households/${hid}/members`)).status).toBe(404);
    });
  });

  describe('HH-04 invite, change role, remove', () => {
    it.each([
      ['member', () => ben],
      ['viewer', () => vic],
    ] as const)('%s cannot invite, change roles, or remove', async (_, c) => {
      expect(
        (await c().post(`/api/v1/households/${hid}/invites`, { email: 'x@fiscus.test' })).status,
      ).toBe(403);
      expect(
        (
          await c().request('PATCH', `/api/v1/households/${hid}/members/${ids.ann}`, {
            role: 'viewer',
          })
        ).status,
      ).toBe(403);
      expect((await c().delete(`/api/v1/households/${hid}/members/${ids.ann}`)).status).toBe(403);
    });

    it('the last owner cannot be demoted, and owners leave rather than remove themselves', async () => {
      const demote = await ann.request('PATCH', `/api/v1/households/${hid}/members/${ids.ann}`, {
        role: 'member',
      });
      expect(demote.body.code).toBe('last_owner');
      expect((await ann.delete(`/api/v1/households/${hid}/members/${ids.ann}`)).body.code).toBe(
        'use_leave',
      );
    });

    it('cannot target a member of another household', async () => {
      const other = await oscar.post('/api/v1/households', {
        name: 'Oscar Place',
        baseCurrency: 'EUR',
        timezone: 'Europe/Berlin',
      });
      const oscarMember = other.body.data.you.memberId;
      expect((await ann.delete(`/api/v1/households/${hid}/members/${oscarMember}`)).status).toBe(
        404,
      );
      expect((await oscar.get(`/api/v1/households/${other.body.data.id}`)).status).toBe(200);
    });

    it('owner promotes, demotes, and removes', async () => {
      expect(
        (
          await ann.request('PATCH', `/api/v1/households/${hid}/members/${ids.vic}`, {
            role: 'member',
          })
        ).status,
      ).toBe(204);
      expect((await ann.delete(`/api/v1/households/${hid}/members/${ids.vic}`)).status).toBe(204);
      expect((await vic.get(`/api/v1/households/${hid}`)).status).toBe(404);
      expect((await vic.get('/api/v1/me')).body.data.memberships).toEqual([]);
    });
  });

  describe('HH-05 leave', () => {
    it('the last owner cannot leave; after promoting someone, they can', async () => {
      expect((await ann.post(`/api/v1/households/${hid}/leave`)).body.code).toBe('last_owner');
      await ann.request('PATCH', `/api/v1/households/${hid}/members/${ids.ben}`, { role: 'owner' });
      expect((await ann.post(`/api/v1/households/${hid}/leave`)).status).toBe(204);
      expect((await ann.get(`/api/v1/households/${hid}`)).status).toBe(404);
      expect((await ben.get(`/api/v1/households/${hid}`)).body.data.you.role).toBe('owner');
    });
  });

  describe('invites', () => {
    // Ben is now the only owner.
    const benInvite = async (email: string, role = 'member') => {
      const res = await ben.post(`/api/v1/households/${hid}/invites`, { email, role });
      return { token: tokenFrom(res.body.data.url), id: res.body.data.invite.id };
    };

    it('previews an invite without revealing anything for a bad token', async () => {
      const { token } = await benInvite('newbie@fiscus.test', 'viewer');
      const preview = await new TestClient(app).post('/api/v1/invites/lookup', { token });
      expect(preview.body.data).toEqual({
        householdName: 'Casa',
        invitedBy: 'Ben',
        email: 'newbie@fiscus.test',
        role: 'viewer',
        accountExists: false,
      });
      const bad = await new TestClient(app).post('/api/v1/invites/lookup', { token: 'nope' });
      expect(bad.status).toBe(404);
      expect(bad.body.code).toBe('invalid_invite');
    });

    it('only the invited email can accept, and only once', async () => {
      const { token } = await benInvite('oscar@fiscus.test');
      const wrong = await vic.post('/api/v1/invites/accept', { token });
      expect(wrong.body.code).toBe('invite_email_mismatch');
      expect((await oscar.post('/api/v1/invites/accept', { token })).status).toBe(200);
      expect((await oscar.post('/api/v1/invites/accept', { token })).body.code).toBe(
        'invalid_invite',
      );
    });

    it('revoked and expired invites stop working', async () => {
      const revoked = await benInvite('r@fiscus.test');
      expect((await ben.delete(`/api/v1/households/${hid}/invites/${revoked.id}`)).status).toBe(
        204,
      );
      const expired = await benInvite('e@fiscus.test');
      await sql("UPDATE invites SET expires_at = now() - interval '1 second' WHERE id = $1", [
        expired.id,
      ]);
      for (const { token } of [revoked, expired]) {
        const res = await new TestClient(app).post('/api/v1/invites/lookup', { token });
        expect(res.body.code).toBe('invalid_invite');
      }
      const pending = (await ben.get(`/api/v1/households/${hid}/invites`)).body.data;
      expect(pending.map((i: { email: string }) => i.email)).not.toContain('r@fiscus.test');
    });

    it('lets a new person sign up through an invite on an invite-only instance', async () => {
      const { token } = await benInvite('newbie@fiscus.test', 'viewer');
      const c = new TestClient(inviteOnlyApp);
      const res = await c.post('/api/v1/invites/signup', {
        token,
        password: 'newbie long password',
        displayName: 'Newbie',
      });
      expect(res.status).toBe(201);
      const me = (await c.get('/api/v1/me')).body.data;
      expect(me.email).toBe('newbie@fiscus.test');
      expect(me.memberships).toEqual([
        expect.objectContaining({ householdId: hid, role: 'viewer' }),
      ]);
    });

    it('refuses invite signups when signups are closed or the account exists', async () => {
      const { token } = await benInvite('closed@fiscus.test');
      const closed = await new TestClient(closedApp).post('/api/v1/invites/signup', {
        token,
        password: 'closed long password',
        displayName: 'C',
      });
      expect(closed.body.code).toBe('signup_closed');

      const existing = await benInvite('vic@fiscus.test');
      const dup = await new TestClient(app).post('/api/v1/invites/signup', {
        token: existing.token,
        password: 'another long password',
        displayName: 'V',
      });
      expect(dup.body.code).toBe('account_exists');
    });
  });

  it('records household events visible to the household', async () => {
    const rows = await sql(
      'SELECT DISTINCT action FROM audit_events WHERE household_id = $1 AND visible_to_household',
      [hid],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'household.created',
        'household.updated',
        'invite.created',
        'invite.revoked',
        'member.joined',
        'member.role_changed',
        'member.removed',
        'member.left',
      ]),
    );
  });
});
