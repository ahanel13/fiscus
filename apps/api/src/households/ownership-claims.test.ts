// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

const PASSWORD = 'ownership claim Password1!';

/**
 * Ownership claims through the api (#267, HH-17, D35): who can start one and when, who ends it,
 * what everyone sees, and the activity each step leaves. The worker's part (notices, cancelling,
 * granting) is tested in the worker.
 */
describe('ownership claims', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client;
  let ann: TestClient; // owner
  let ben: TestClient; // member
  let cat: TestClient; // member
  let vic: TestClient; // viewer
  let hid: string;
  const ids: Record<string, string> = {};
  const url = (path = '') => `/api/v1/households/${hid}/ownership-claims${path}`;

  async function user(name: string) {
    const c = new TestClient(app);
    const res = await c.post('/api/v1/auth/signup', {
      email: `${name}@claims.test`,
      password: PASSWORD,
      displayName: name[0]!.toUpperCase() + name.slice(1),
    });
    expect(res.status).toBe(201);
    return c;
  }
  /** Ann was last here `days` ago. */
  const annAway = (days: number) =>
    owner.query(
      `UPDATE users SET last_active_at = now() - make_interval(days => $1::int)
       WHERE email = 'ann@claims.test'`,
      [days],
    );
  const actions = async () =>
    (
      await owner.query(
        `SELECT action, actor_member_id, metadata FROM audit_events
         WHERE household_id = $1 AND action LIKE 'ownership_claim.%' ORDER BY seq`,
        [hid],
      )
    ).rows;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    [ann, ben, cat, vic] = await Promise.all([user('ann'), user('ben'), user('cat'), user('vic')]);
    const created = await ann.post('/api/v1/households', {
      name: 'Our Home',
      baseCurrency: 'USD',
      timezone: 'UTC',
    });
    hid = created.body.data.id;
    ids.ann = created.body.data.you.memberId;
    for (const [c, name, role] of [
      [ben, 'ben', 'member'],
      [cat, 'cat', 'member'],
      [vic, 'vic', 'viewer'],
    ] as const) {
      const inv = await ann.post(`/api/v1/households/${hid}/invites`, {
        email: `${name}@claims.test`,
        role,
      });
      const token = new URLSearchParams(new URL(inv.body.data.url).hash.slice(1)).get('token');
      const res = await c.post('/api/v1/invites/accept', { token });
      expect(res.status).toBe(200);
      ids[name] = res.body.data.memberId;
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all([app?.close(), owner?.end()]);
    await tdb?.stop();
  });

  it('records when someone last used Fiscus, from signing in', async () => {
    await annAway(40);
    const signin = await new TestClient(app).post('/api/v1/auth/login', {
      email: 'ann@claims.test',
      password: PASSWORD,
    });
    expect(signin.status, JSON.stringify(signin.body)).toBeLessThan(300);
    const { rows } = await owner.query(
      `SELECT now() - last_active_at < interval '1 minute' AS recent FROM users
       WHERE email = 'ann@claims.test'`,
    );
    expect(rows).toEqual([{ recent: true }]);
  });

  it('can’t start while an owner has used Fiscus in the last 30 days', async () => {
    await annAway(29);
    expect((await ben.get(url('/current'))).body.data).toEqual({ claim: null, canClaim: false });
    const res = await ben.post(url());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('owners_active');
  });

  it('is started by a member, never an owner or a viewer', async () => {
    await annAway(31);
    // Only members learn whether they could claim.
    expect((await ben.get(url('/current'))).body.data).toEqual({ claim: null, canClaim: true });
    for (const c of [ann, vic]) {
      expect((await c.get(url('/current'))).body.data).toEqual({ claim: null, canClaim: false });
      expect((await c.post(url())).status).toBe(403);
    }
    const res = await ben.post(url());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const claim = res.body.data;
    expect(claim).toMatchObject({ claimantMemberId: ids.ben, status: 'open' });
    expect(Date.parse(claim.endsAt) - Date.parse(claim.createdAt)).toBe(30 * 24 * 60 * 60_000);
    // Everyone sees it; nobody can start another.
    for (const c of [ann, ben, cat, vic]) {
      expect((await c.get(url('/current'))).body.data).toEqual({ claim, canClaim: false });
    }
    const again = await cat.post(url());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('claim_open');
  });

  it('is rejected by an owner in one step, and by nobody else', async () => {
    const { claim } = (await ann.get(url('/current'))).body.data;
    expect((await vic.post(url(`/${claim.id}/reject`))).status).toBe(403);
    expect((await ben.post(url(`/${claim.id}/reject`))).status).toBe(403);
    expect((await cat.post(url(`/${claim.id}/withdraw`))).status).toBe(403);
    expect((await ann.post(url(`/${claim.id}/reject`))).status).toBe(204);
    const again = await ann.post(url(`/${claim.id}/reject`));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('claim_ended');
    expect((await ben.get(url('/current'))).body.data.claim).toBeNull();
    expect(await actions()).toEqual([
      {
        action: 'ownership_claim.started',
        actor_member_id: ids.ben,
        metadata: { claimantMemberId: ids.ben, endsAt: claim.endsAt },
      },
      {
        action: 'ownership_claim.rejected',
        actor_member_id: ids.ann,
        metadata: { claimantMemberId: ids.ben },
      },
    ]);
  });

  it('is withdrawn by the claimant', async () => {
    await annAway(31);
    const { body } = await cat.post(url());
    expect((await ann.post(url(`/${body.data.id}/withdraw`))).status).toBe(403);
    expect((await cat.post(url(`/${body.data.id}/withdraw`))).status).toBe(204);
    expect((await cat.get(url('/current'))).body.data).toEqual({ claim: null, canClaim: true });
    expect((await actions()).at(-1)).toMatchObject({
      action: 'ownership_claim.withdrawn',
      actor_member_id: ids.cat,
    });
  });

  it('needs a recent sign-in to start', async () => {
    await annAway(31);
    await owner.query(
      `UPDATE sessions SET reauthenticated_at = now() - interval '1 hour'
       WHERE user_id = (SELECT id FROM users WHERE email = 'ben@claims.test')`,
    );
    const res = await ben.post(url());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });

  it('404s for claims of other households and unknown ids', async () => {
    expect((await ann.post(url(`/${crypto.randomUUID()}/reject`))).status).toBe(404);
    expect((await ann.post(url('/not-a-uuid/reject'))).status).toBe(404);
  });
});
