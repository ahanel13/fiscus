// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';
import { RateLimiter } from './rate-limiter.js';
import { SESSION_IDLE_MS, SESSION_TTL_MS, SessionService } from './session.service.js';
import { SetupService } from './setup.service.js';

const ADMIN = {
  email: 'admin@fiscus.test',
  password: 'Correct horse battery 1!',
  displayName: 'Ada',
};

describe('authentication', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let openApp: NestFastifyApplication;
  let owner: pg.Client;

  const sql = async (text: string, params: unknown[] = []) =>
    (await owner.query(text, params)).rows;
  const client = (a = app) => new TestClient(a);
  async function signedInAdmin() {
    const c = client();
    expect((await c.post('/api/v1/auth/login', ADMIN)).status).toBe(200);
    return c;
  }

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    app = await createTestApp(tdb.appUrl);
    openApp = await createTestApp(tdb.appUrl, { signupMode: 'open' });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([app?.close(), openApp?.close(), owner?.end()]);
    await tdb?.stop();
  });

  beforeEach(async () => {
    for (const a of [app, openApp]) {
      await a.get(RateLimiter).reset('login:ip:127.0.0.1');
      await a.get(RateLimiter).reset('signup:ip:127.0.0.1');
    }
  });

  describe('first-run setup', () => {
    it('reports that setup is required on an empty instance', async () => {
      const res = await client().get('/api/v1/auth/status');
      expect(res.body).toEqual({ data: { setupRequired: true, signupMode: 'invite_only' } });
    });

    it('rejects a wrong setup token', async () => {
      await app.get(SetupService).issueToken();
      const res = await client().post('/api/v1/auth/setup', { ...ADMIN, setupToken: 'nope' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('invalid_setup_token');
    });

    it('creates the first user as instance admin, signs them in, then closes setup', async () => {
      const setupToken = await app.get(SetupService).issueToken();
      const c = client();
      const res = await c.post('/api/v1/auth/setup', { ...ADMIN, setupToken });
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({ email: ADMIN.email, isInstanceAdmin: true });

      const cookie = res.raw.cookies.find(
        (k: { name: string }) => k.name === '__Host-fiscus_session',
      ) as Record<string, unknown>;
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
      expect((await c.get('/api/v1/me')).body.data.email).toBe(ADMIN.email);

      expect((await client().get('/api/v1/auth/status')).body.data.setupRequired).toBe(false);
      const again = await client().post('/api/v1/auth/setup', { ...ADMIN, setupToken });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('setup_complete');
    });
  });

  describe('CSRF', () => {
    it('rejects unsafe requests without a token', async () => {
      const res = await client().post('/api/v1/auth/login', ADMIN, { csrf: false });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('csrf_failed');
    });

    it('binds tokens to the session: a pre-login token is useless after login', async () => {
      const c = client();
      await c.get('/api/v1/auth/csrf');
      const stale = { token: c.csrfToken!, cookie: c.cookies.get('__Host-fiscus_csrf')! };
      await c.post('/api/v1/auth/login', ADMIN);
      c.csrfToken = stale.token;
      c.cookies.set('__Host-fiscus_csrf', stale.cookie);
      expect((await c.post('/api/v1/auth/logout')).body.code).toBe('csrf_failed');
    });
  });

  describe('signup', () => {
    it('is refused on an invite-only instance', async () => {
      const res = await client().post('/api/v1/auth/signup', {
        email: 'new@fiscus.test',
        password: 'long enough Password1!',
        displayName: 'New',
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('signup_invite_required');
    });

    it('creates and signs in a user on an open instance, normalizing the email', async () => {
      const c = client(openApp);
      const res = await c.post('/api/v1/auth/signup', {
        email: '  Bea@Fiscus.TEST ',
        password: 'another long Password1!',
        displayName: 'Bea',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({
        email: 'bea@fiscus.test',
        isInstanceAdmin: false,
      });
      expect((await c.get('/api/v1/me')).status).toBe(200);
    });

    it('rejects duplicate emails and passwords that miss the policy, with field errors', async () => {
      const dup = await client(openApp).post('/api/v1/auth/signup', {
        email: 'bea@fiscus.test',
        password: 'another long Password1!',
        displayName: 'Bea 2',
      });
      expect(dup.status).toBe(409);
      const weak = await client(openApp).post('/api/v1/auth/signup', {
        email: 'weak@fiscus.test',
        password: 'short',
        displayName: 'W',
      });
      expect(weak.status).toBe(422);
      expect(weak.body.errors).toEqual([expect.objectContaining({ path: 'password' })]);
      // Long but only lowercase: it says what's missing.
      const plain = await client(openApp).post('/api/v1/auth/signup', {
        email: 'plain-letters@fiscus.test',
        password: 'only lowercase letters here',
        displayName: 'P',
      });
      expect(plain.status).toBe(422);
      expect(plain.body.errors).toEqual([
        expect.objectContaining({
          path: 'password',
          message: 'Your password needs: an uppercase letter, a number, a symbol (like ! or #).',
        }),
      ]);
    });
  });

  describe('login', () => {
    it('gives identical answers for unknown email and wrong Password1!', async () => {
      const unknown = await client().post('/api/v1/auth/login', {
        email: 'nobody@fiscus.test',
        password: 'whatever Password1!',
      });
      const wrong = await client().post('/api/v1/auth/login', {
        email: ADMIN.email,
        password: 'wrong Password1!',
      });
      expect(unknown.status).toBe(401);
      const strip = ({ instance: _, ...rest }: Record<string, unknown>) => rest;
      expect(strip(unknown.body)).toEqual(strip(wrong.body));
    });

    it('rotates the session on login (old cookie stops working)', async () => {
      const c = await signedInAdmin();
      const oldToken = c.cookies.get('__Host-fiscus_session')!;
      await c.post('/api/v1/auth/login', ADMIN);
      expect(c.cookies.get('__Host-fiscus_session')).not.toBe(oldToken);

      const replay = client();
      replay.cookies.set('__Host-fiscus_session', oldToken);
      expect((await replay.get('/api/v1/me')).status).toBe(401);
    });

    it('rate-limits repeated failures per account, even for the right password', async () => {
      await sql(
        `INSERT INTO users (id, email, display_name, password_hash)
         SELECT gen_random_uuid(), 'target@fiscus.test', 'T', password_hash FROM users WHERE email = $1`,
        [ADMIN.email],
      );
      for (let i = 0; i < 10; i++) {
        await client().post('/api/v1/auth/login', {
          email: 'target@fiscus.test',
          password: 'bad guess',
        });
      }
      const blocked = await client().post('/api/v1/auth/login', {
        email: 'target@fiscus.test',
        password: ADMIN.password,
      });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('refuses disabled accounts and drops their existing sessions', async () => {
      const c = client(openApp);
      await c.post('/api/v1/auth/signup', {
        email: 'dis@fiscus.test',
        password: 'disabled user Password1!',
        displayName: 'D',
      });
      await sql("UPDATE users SET disabled_at = now() WHERE email = 'dis@fiscus.test'");
      expect((await c.get('/api/v1/me')).status).toBe(401);
      const login = await client(openApp).post('/api/v1/auth/login', {
        email: 'dis@fiscus.test',
        password: 'disabled user Password1!',
      });
      expect(login.body.code).toBe('account_disabled');
    });
  });

  describe('sessions', () => {
    it('logout ends the session', async () => {
      const c = await signedInAdmin();
      expect((await c.post('/api/v1/auth/logout')).status).toBe(200);
      expect((await c.get('/api/v1/me')).status).toBe(401);
    });

    it('lists your sessions and revokes only your own', async () => {
      const phone = await signedInAdmin();
      const laptop = await signedInAdmin();
      const list = (await laptop.get('/api/v1/me/sessions')).body.data as {
        id: string;
        current: boolean;
      }[];
      expect(list.filter((s) => s.current)).toHaveLength(1);
      const phoneId = (await phone.get('/api/v1/me/sessions')).body.data.find(
        (s: { current: boolean }) => s.current,
      ).id;

      expect((await laptop.delete(`/api/v1/me/sessions/${phoneId}`)).status).toBe(204);
      expect((await phone.get('/api/v1/me')).status).toBe(401);

      const bea = client(openApp);
      await bea.post('/api/v1/auth/login', {
        email: 'bea@fiscus.test',
        password: 'another long Password1!',
      });
      const laptopId = list.find((s) => s.current)!.id;
      expect((await bea.delete(`/api/v1/me/sessions/${laptopId}`)).status).toBe(404);
      expect((await laptop.get('/api/v1/me')).status).toBe(200);
    });

    describe('expiry (#379)', () => {
      const SECOND = 1000;
      const DAY = 24 * 60 * 60 * SECOND;
      let sessions: SessionService;
      let realNow: () => Date;
      let t0: number;
      /** Moves the sessions' clock to `ms` after t0. */
      const at = (ms: number) => {
        sessions.now = () => new Date(t0 + ms);
      };
      const currentId = async (c: TestClient) =>
        (await c.get('/api/v1/me/sessions')).body.data.find((s: { current: boolean }) => s.current)
          .id as string;
      const stored = async (id: string) =>
        (await sql('SELECT 1 FROM sessions WHERE id = $1', [id])).length === 1;

      beforeEach(() => {
        sessions = app.get(SessionService);
        realNow = sessions.now;
        t0 = Date.now();
        at(0);
      });
      afterEach(() => {
        sessions.now = realNow;
      });

      it('ends a session after 7 days without use, and use keeps it going', async () => {
        const used = await signedInAdmin();
        const idle = await signedInAdmin();
        const idleId = await currentId(idle);

        at(SESSION_IDLE_MS - SECOND);
        expect((await used.get('/api/v1/me')).status).toBe(200);

        at(SESSION_IDLE_MS + SECOND);
        expect((await idle.get('/api/v1/me')).status).toBe(401);
        expect(await stored(idleId)).toBe(false);
        // Seen a second short of 7 days in: idle for two seconds, not seven days.
        expect((await used.get('/api/v1/me')).status).toBe(200);
      });

      it('ends a session 30 days after sign-in, however much it is used', async () => {
        const c = await signedInAdmin();
        const id = await currentId(c);

        for (let day = 6; day < 30; day += 6) {
          at(day * DAY);
          expect((await c.get('/api/v1/me')).status).toBe(200);
        }
        at(SESSION_TTL_MS - SECOND);
        expect((await c.get('/api/v1/me')).status).toBe(200);

        at(SESSION_TTL_MS + SECOND);
        expect((await c.get('/api/v1/me')).status).toBe(401);
        expect(await stored(id)).toBe(false);
      });
    });

    it('requires authentication for /me', async () => {
      const res = await client().get('/api/v1/me');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.instance).toBe(res.headers['x-request-id']);
    });
  });

  describe('admin password reset link', () => {
    it('is forbidden to non-admins', async () => {
      const bea = client(openApp);
      await bea.post('/api/v1/auth/login', {
        email: 'bea@fiscus.test',
        password: 'another long Password1!',
      });
      const [target] = await sql("SELECT id FROM users WHERE email = 'bea@fiscus.test'");
      expect((await bea.post(`/api/v1/admin/users/${target.id}/password-reset-link`)).status).toBe(
        403,
      );
    });

    it('requires recent re-authentication, then resets the password and signs out everywhere', async () => {
      const admin = await signedInAdmin();
      const [target] = await sql("SELECT id FROM users WHERE email = 'bea@fiscus.test'");
      const victimSession = client(openApp);
      await victimSession.post('/api/v1/auth/login', {
        email: 'bea@fiscus.test',
        password: 'another long Password1!',
      });

      const sessions = app.get(SessionService);
      const realNow = sessions.now;
      sessions.now = () => new Date(Date.now() + 11 * 60_000);
      try {
        const stale = await admin.post(`/api/v1/admin/users/${target.id}/password-reset-link`);
        expect(stale.body.code).toBe('reauth_required');
        expect((await admin.post('/api/v1/auth/reauth', { password: 'wrong' })).status).toBe(401);
        sessions.now = realNow;
        expect((await admin.post('/api/v1/auth/reauth', { password: ADMIN.password })).status).toBe(
          204,
        );
      } finally {
        sessions.now = realNow;
      }

      const link = await admin.post(`/api/v1/admin/users/${target.id}/password-reset-link`);
      expect(link.status).toBe(201);
      const url = new URL(link.body.data.url);
      expect(url.origin + url.pathname).toBe('https://fiscus.test/reset-password');
      const token = new URLSearchParams(url.hash.slice(1)).get('token')!;

      const reset = await client(openApp).post('/api/v1/auth/password-reset', {
        token,
        password: 'brand new Password1!',
      });
      expect(reset.status).toBe(204);
      expect((await victimSession.get('/api/v1/me')).status).toBe(401);

      const login = (password: string) =>
        client(openApp).post('/api/v1/auth/login', { email: 'bea@fiscus.test', password });
      expect((await login('another long Password1!')).status).toBe(401);
      expect((await login('brand new Password1!')).status).toBe(200);

      const reuse = await client(openApp).post('/api/v1/auth/password-reset', {
        token,
        password: 'yet another Password1!',
      });
      expect(reuse.body.code).toBe('invalid_reset_token');
    });
  });

  describe('storage', () => {
    it('stores argon2id hashes and never plaintext passwords or session tokens', async () => {
      const rows = await sql('SELECT password_hash FROM users WHERE password_hash IS NOT NULL');
      for (const r of rows) expect(r.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      const dump =
        JSON.stringify(await sql('SELECT * FROM users')) +
        JSON.stringify(await sql('SELECT * FROM sessions'));
      expect(dump).not.toContain(ADMIN.password);
      const c = await signedInAdmin();
      expect(dump + JSON.stringify(await sql('SELECT * FROM sessions'))).not.toContain(
        c.cookies.get('__Host-fiscus_session'),
      );
    });

    it('records security events in the audit log', async () => {
      const actions = (await sql('SELECT DISTINCT action FROM audit_events')).map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'instance.setup_completed',
          'auth.signup',
          'auth.login',
          'auth.login_failed',
          'auth.logout',
          'auth.reauthenticated',
          'admin.user.password_reset_link_created',
          'auth.password_reset',
        ]),
      );
    });
  });

  describe('server invites', () => {
    it('[ADM-08] lets an admin invite someone to make an account, once, for that email', async () => {
      const admin = await signedInAdmin();
      // Non-admins can't.
      const plain = client(openApp);
      await plain.post('/api/v1/auth/signup', {
        email: 'plain@fiscus.test',
        password: 'plain long Password1!',
        displayName: 'Plain',
      });
      expect((await plain.post('/api/v1/admin/invites', { email: 'x@fiscus.test' })).status).toBe(
        403,
      );
      expect((await plain.get('/api/v1/admin/invites')).status).toBe(403);

      // Someone with an account already doesn't need one.
      expect(
        (await admin.post('/api/v1/admin/invites', { email: 'bea@fiscus.test' })).body.code,
      ).toBe('account_exists');

      const created = await admin.post('/api/v1/admin/invites', { email: 'Cy@Fiscus.test' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const url = new URL(created.body.data.url);
      expect(url.origin + url.pathname).toBe('https://fiscus.test/join');
      const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
      expect(
        (await admin.get('/api/v1/admin/invites')).body.data.map((i: { email: string }) => i.email),
      ).toContain('cy@fiscus.test');

      // The invitee, on this invite-only server: sees who invited them, then makes the account.
      const cy = client();
      expect(
        (
          await cy.post('/api/v1/auth/signup', {
            email: 'cy@fiscus.test',
            password: 'cy long Password1!',
            displayName: 'Cy',
          })
        ).body.code,
      ).toBe('signup_invite_required');
      const preview = await cy.post('/api/v1/auth/join/lookup', { token });
      expect(preview.body.data).toEqual({
        email: 'cy@fiscus.test',
        invitedBy: ADMIN.displayName,
        accountExists: false,
      });
      const joined = await cy.post('/api/v1/auth/join', {
        token,
        password: 'cy long Password1!',
        displayName: 'Cy',
      });
      expect(joined.status, JSON.stringify(joined.body)).toBe(201);
      expect((await cy.get('/api/v1/me')).body.data).toMatchObject({
        email: 'cy@fiscus.test',
        memberships: [],
      });

      // Once only, and gone from the pending list.
      expect(
        (
          await client().post('/api/v1/auth/join', {
            token,
            password: 'other long Password1!',
            displayName: 'X',
          })
        ).body.code,
      ).toBe('invalid_invite');
      expect((await admin.get('/api/v1/admin/invites')).body.data).toEqual([]);
    });

    it('cancelled and expired invites stop working', async () => {
      const admin = await signedInAdmin();
      const make = async (email: string) => {
        const r = await admin.post('/api/v1/admin/invites', { email });
        return {
          id: r.body.data.invite.id as string,
          token: new URLSearchParams(new URL(r.body.data.url).hash.slice(1)).get('token')!,
        };
      };
      const cancelled = await make('dee@fiscus.test');
      expect((await admin.request('DELETE', `/api/v1/admin/invites/${cancelled.id}`)).status).toBe(
        204,
      );
      expect(
        (await client().post('/api/v1/auth/join/lookup', { token: cancelled.token })).status,
      ).toBe(404);

      const expired = await make('eve@fiscus.test');
      await sql(
        "UPDATE server_invites SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [expired.id],
      );
      expect(
        (
          await client().post('/api/v1/auth/join', {
            token: expired.token,
            password: 'eve long Password1!',
            displayName: 'Eve',
          })
        ).body.code,
      ).toBe('invalid_invite');
    });
  });
});
