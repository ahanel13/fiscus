// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { MailTransport } from '@fiscus/notify';
import type { NotificationList, NotificationSettingsView } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Notifications and their settings (#125, #126, #130; bills walkthrough §7, D15–D18). Each
 * member's are their own (HH-10): nobody else, household owners included, reads or changes them.
 */
describe('notifications', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  const members: Record<'A' | 'B' | 'V', string> = { A: '', B: '', V: '' };
  const sent: { to: string; subject: string; text: string }[] = [];
  let mailFails = false;
  const transport: MailTransport = {
    async sendMail(m) {
      if (mailFails) throw Object.assign(new Error('535 bad password hunter2'), { code: 'EAUTH' });
      sent.push(m);
    },
  };
  const url = (p = '') => `/api/v1/households/${hh}/notifications${p}`;
  const settings = async (c: TestClient) =>
    (await c.get(url('/settings'))).body.data as NotificationSettingsView;

  /** A notification for a member, as the worker writes and routes one. */
  const notify = async (member: string, title = 'Sign in to Harbor Credit Union again') => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO notifications (id, household_id, member_id, kind, dedupe_key, title, body, summary,
         link, in_app, routed_at)
       VALUES ($1, $2, $3, 'connection_needs_you', $4, $5, 'body', 'summary', $6, true, now())`,
      [id, hh, member, `k:${id}`, title, `/h/${hh}/accounts`],
    );
    return id;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    app = await createTestApp(tdb.appUrl, {
      signupMode: 'open',
      mail: { smtpUrl: 'smtp://mail.test:587', from: 'Fiscus <fiscus@notify.test>' },
      mailTransport: transport,
    });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@notify.test`,
        password: 'notifications test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    V = await signup('vic');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'hybrid',
      })
    ).body.data.id;
    for (const [c, email, role] of [
      [B, 'bea@notify.test', 'member'],
      [V, 'vic@notify.test', 'viewer'],
    ] as const) {
      const invite = await A.post(`/api/v1/households/${hh}/invites`, { email, role });
      await c.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    for (const [k, c] of [
      ['A', A],
      ['B', B],
      ['V', V],
    ] as const) {
      members[k] = (await c.get(`/api/v1/households/${hh}`)).body.data.you.memberId;
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await owner?.end();
    await tdb?.stop();
  });

  it('starts with D18’s defaults, and email when the server can send it', async () => {
    const s = await settings(A);
    expect(s.emailAvailable).toBe(true);
    expect(s.channels.map((c) => [c.kind, c.configured, c.hint])).toEqual([
      ['email', true, 'ada@notify.test'],
      ['ntfy', false, null],
      ['gotify', false, null],
      ['webhook', false, null],
    ]);
    const rule = (kind: string) => s.rules.find((r) => r.kind === kind)!;
    expect(rule('bill_due')).toEqual({
      kind: 'bill_due',
      channels: ['in_app', 'email'],
      settings: { daysBefore: 3 },
      isDefault: true,
    });
    expect(rule('big_transaction')).toMatchObject({
      channels: ['in_app'],
      settings: { overMinor: 50_000 },
    });
    expect(rule('weekly_recap').settings).toEqual({ day: 'monday', hour: 8 });
    expect(rule('low_balance').settings).toEqual({ accountIds: [], underMinor: 100_000 });
    expect(s.rules).toHaveLength(10);
  });

  it('sets up ntfy with its secrets encrypted, never returned, and adds it to push rules', async () => {
    const r = await A.request('PUT', url('/channels/ntfy'), {
      detail: 'summary',
      server: 'https://ntfy.sh',
      topic: 'rivera-alex-7f3a9c2e',
      token: 'tk_supersecret',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ntfy = (r.body.data as NotificationSettingsView).channels.find((c) => c.kind === 'ntfy');
    expect(ntfy).toEqual({
      kind: 'ntfy',
      configured: true,
      detail: 'summary',
      server: 'https://ntfy.sh',
      hint: 'topic rivera-alex-…',
      signed: false,
    });
    expect(JSON.stringify(r.body)).not.toMatch(/7f3a9c2e|tk_supersecret/);
    const { rows } = await owner.query(
      `SELECT secret_enc FROM notification_channels WHERE member_id = $1 AND kind = 'ntfy'`,
      [members.A],
    );
    expect(rows[0].secret_enc.toString('latin1')).not.toMatch(/tk_supersecret|rivera-alex/);
    const rules = (r.body.data as NotificationSettingsView).rules;
    expect(rules.find((x) => x.kind === 'bill_due')!.channels).toEqual(['in_app', 'email', 'ntfy']);
    expect(rules.find((x) => x.kind === 'weekly_recap')!.channels).toEqual(['in_app', 'email']);
    // A change without the topic keeps the one saved.
    const again = await A.request('PUT', url('/channels/ntfy'), {
      detail: 'full',
      server: 'https://ntfy.sh',
    });
    expect(again.status).toBe(200);
    expect(
      (again.body.data as NotificationSettingsView).channels.find((c) => c.kind === 'ntfy')!.hint,
    ).toBe('topic rivera-alex-…');
  });

  it('asks for what a channel needs, and refuses an address with a password in it', async () => {
    const noTopic = await B.request('PUT', url('/channels/ntfy'), {
      detail: 'full',
      server: 'https://ntfy.sh',
    });
    expect(noTopic.status).toBe(422);
    const creds = await B.request('PUT', url('/channels/gotify'), {
      detail: 'full',
      server: 'https://user:pw@gotify.example.test',
      token: 't',
    });
    expect(creds.status).toBe(422);
    const ftp = await B.request('PUT', url('/channels/webhook'), {
      detail: 'full',
      url: 'ftp://x.test/',
    });
    expect(ftp.status).toBe(422);
    const unknown = await B.request('PUT', url('/channels/pager'), { detail: 'full' });
    expect(unknown.status).toBe(422);
  });

  it('sets up a signed webhook, and removes it, unticking it from the rules', async () => {
    const r = await B.request('PUT', url('/channels/webhook'), {
      detail: 'minimal',
      url: 'https://hooks.example.test/fiscus?key=abc',
      secret: 'signing-secret',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(
      (r.body.data as NotificationSettingsView).channels.find((c) => c.kind === 'webhook'),
    ).toMatchObject({ configured: true, hint: 'hooks.example.test', signed: true });
    expect(JSON.stringify(r.body)).not.toMatch(/key=abc|signing-secret/);
    await B.request('PUT', url('/rules/connection_needs_you'), { channels: ['in_app', 'webhook'] });
    const removed = await B.request('DELETE', url('/channels/webhook'));
    expect(removed.status).toBe(200);
    const s = removed.body.data as NotificationSettingsView;
    expect(s.channels.find((c) => c.kind === 'webhook')!.configured).toBe(false);
    expect(s.rules.find((x) => x.kind === 'connection_needs_you')!.channels).toEqual(['in_app']);
    expect((await B.request('DELETE', url('/channels/webhook'))).status).toBe(404);
  });

  it('keeps each member’s channels and rules their own [HH-10/OWN] [HH-10/MEM]', async () => {
    // A set up ntfy above; B sees none of it.
    const b = await settings(B);
    expect(b.channels.find((c) => c.kind === 'ntfy')!.configured).toBe(false);
    expect(b.channels.find((c) => c.kind === 'email')!.hint).toBe('bea@notify.test');
    await B.request('PUT', url('/rules/big_transaction'), {
      channels: ['in_app', 'email'],
      settings: { overMinor: 25_000 },
    });
    expect((await settings(A)).rules.find((r) => r.kind === 'big_transaction')).toMatchObject({
      settings: { overMinor: 50_000 },
      isDefault: true,
    });
    expect((await settings(B)).rules.find((r) => r.kind === 'big_transaction')).toMatchObject({
      channels: ['in_app', 'email'],
      settings: { overMinor: 25_000 },
      isDefault: false,
    });
  });

  it('lets a viewer choose their own notifications too [HH-10/VIEW]', async () => {
    const r = await V.request('PUT', url('/rules/weekly_recap'), {
      channels: ['in_app'],
      settings: { day: 'friday', hour: 17 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(
      (r.body.data as NotificationSettingsView).rules.find((x) => x.kind === 'weekly_recap'),
    ).toMatchObject({ channels: ['in_app'], settings: { day: 'friday', hour: 17 } });
  });

  it('checks a rule’s settings, and watches only accounts you can see', async () => {
    const bad = await A.request('PUT', url('/rules/bill_due'), {
      channels: ['in_app'],
      settings: { daysBefore: 99 },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].path).toBe('settings.daysBefore');
    const extra = await A.request('PUT', url('/rules/bill_due'), {
      channels: ['in_app'],
      settings: { amount: 1 },
    });
    expect(extra.status).toBe(422);
    const notAChannel = await A.request('PUT', url('/rules/bill_due'), { channels: ['sms'] });
    expect(notAChannel.status).toBe(422);
    const unknown = await A.request('PUT', url('/rules/lottery'), { channels: [] });
    expect(unknown.status).toBe(422);

    const bPrivate = (
      await B.post(`/api/v1/households/${hh}/accounts`, {
        name: 'Bea’s card',
        type: 'credit',
        visibility: 'private',
      })
    ).body.data.id;
    const aChecking = (
      await A.post(`/api/v1/households/${hh}/accounts`, {
        name: 'Checking',
        type: 'depository',
        visibility: 'full',
      })
    ).body.data.id;
    const theirs = await A.request('PUT', url('/rules/low_balance'), {
      channels: ['in_app'],
      settings: { accountIds: [bPrivate], underMinor: 10_000 },
    });
    expect(theirs.status).toBe(404);
    const mine = await A.request('PUT', url('/rules/low_balance'), {
      channels: ['in_app', 'email'],
      settings: { accountIds: [aChecking], underMinor: 10_000 },
    });
    expect(mine.status).toBe(200);
    // Only what changed is sent: the rest stays.
    const partial = await A.request('PUT', url('/rules/low_balance'), {
      channels: ['in_app'],
      settings: { underMinor: 20_000 },
    });
    expect(
      (partial.body.data as NotificationSettingsView).rules.find((r) => r.kind === 'low_balance')!
        .settings,
    ).toEqual({ accountIds: [aChecking], underMinor: 20_000 });
  });

  it('lists only your own notifications in the bell, newest first, with the unread count', async () => {
    const older = await notify(members.A, 'Older');
    const newer = await notify(members.A, 'Newer');
    const bs = await notify(members.B, 'Bea’s');
    const list = (await A.get(url())).body.data as NotificationList;
    expect(list.notifications.map((n) => n.title)).toEqual(['Newer', 'Older']);
    expect(list.unread).toBe(2);
    expect(list.notifications[0]).toEqual({
      id: newer,
      kind: 'connection_needs_you',
      title: 'Newer',
      body: 'body',
      link: `/h/${hh}/accounts`,
      createdAt: expect.any(String),
      readAt: null,
    });
    expect((await A.get(url('/unread-count'))).body.data).toEqual({ count: 2 });

    // Someone else's is not found, as if it weren't there.
    expect((await B.post(url(`/${older}/read`))).status).toBe(404);
    expect((await A.post(url(`/${bs}/read`))).status).toBe(404);
    expect((await A.post(url('/not-a-uuid/read'))).status).toBe(404);

    expect((await A.post(url(`/${older}/read`))).status).toBe(204);
    expect((await A.get(url('/unread-count'))).body.data).toEqual({ count: 1 });
    expect((await A.post(url('/read-all'))).status).toBe(204);
    expect((await A.get(url('/unread-count'))).body.data).toEqual({ count: 0 });
    // B's is still unread: read-all is yours only.
    expect((await B.get(url('/unread-count'))).body.data).toEqual({ count: 1 });
    // Reading is recorded, but only for you (HH-10).
    const { rows } = await owner.query(
      `SELECT visible_to_household FROM audit_events WHERE action = 'notification.read'`,
    );
    expect(rows).toEqual([{ visible_to_household: false }]);
  });

  it('queues a channel’s test for the worker, and reports how it went to you only', async () => {
    const r = await A.post(url('/channels/ntfy/test'));
    expect(r.status).toBe(202);
    const id = r.body.data.id as string;
    expect((await A.get(url(`/tests/${id}`))).body.data).toEqual({ status: 'pending', code: null });
    expect((await B.get(url(`/tests/${id}`))).status).toBe(404);
    const { rows } = await owner.query(
      `SELECT kind, test_channel, member_id FROM notifications WHERE id = $1`,
      [id],
    );
    expect(rows).toEqual([{ kind: 'test', test_channel: 'ntfy', member_id: members.A }]);
    // As the worker leaves it.
    await owner.query(
      `INSERT INTO notification_deliveries (id, household_id, notification_id, channel, status,
         attempts, last_error_code)
       VALUES ($1, $2, $3, 'ntfy', 'failed', 1, 'http_401')`,
      [randomUUID(), hh, id],
    );
    expect((await A.get(url(`/tests/${id}`))).body.data).toEqual({
      status: 'failed',
      code: 'http_401',
    });
    // Tests aren't in the bell.
    const list = (await A.get(url())).body.data as NotificationList;
    expect(list.notifications.some((n) => n.id === id)).toBe(false);
  });

  it('is only for members of the household', async () => {
    const outsider = new TestClient(app);
    await outsider.post('/api/v1/auth/signup', {
      email: 'out@notify.test',
      password: 'notifications test Password1!',
      displayName: 'Out',
    });
    expect((await outsider.get(url())).status).toBe(404);
    expect((await outsider.get(url('/settings'))).status).toBe(404);
  });

  describe('Server → Email (D16, ADM-05)', () => {
    it('says whether the server can send email, to instance admins only', async () => {
      expect((await A.get('/api/v1/admin/mail')).status).toBe(403);
      await owner.query(
        `UPDATE users SET is_instance_admin = true WHERE email = 'ada@notify.test'`,
      );
      const r = await A.get('/api/v1/admin/mail');
      expect(r.body.data).toEqual({ configured: true, from: 'Fiscus <fiscus@notify.test>' });
      expect(JSON.stringify(r.body)).not.toContain('smtp://');
    });

    it('sends the admin a test, and says why one fails without the server’s words', async () => {
      expect((await A.post('/api/v1/admin/mail/test')).status).toBe(204);
      expect(sent.at(-1)).toMatchObject({ to: 'ada@notify.test', subject: 'A test from Fiscus' });
      mailFails = true;
      const failed = await A.post('/api/v1/admin/mail/test');
      expect(failed.status).toBe(502);
      expect(failed.body).toMatchObject({ code: 'mail_failed', detail: 'smtp_auth' });
      expect(JSON.stringify(failed.body)).not.toContain('hunter2');
      mailFails = false;
      expect((await B.post('/api/v1/admin/mail/test')).status).toBe(403);
    });
  });
});

describe('notifications without the server’s mail settings', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('says email isn’t available, and leaves its ticks off nothing', async () => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: 'solo@notify.test',
      password: 'notifications test Password1!',
      displayName: 'Solo',
    });
    const hh = (
      await c.post('/api/v1/households', {
        name: 'Solo',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'combined',
      })
    ).body.data.id;
    const s = (await c.get(`/api/v1/households/${hh}/notifications/settings`)).body
      .data as NotificationSettingsView;
    expect(s.emailAvailable).toBe(false);
    expect(s.channels[0]).toMatchObject({ kind: 'email', configured: false });
  });
});
