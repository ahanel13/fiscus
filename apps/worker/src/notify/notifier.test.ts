// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import {
  encryptChannelSecret,
  enqueueNotification,
  notificationChannels,
  systemContext,
  withContext,
} from '@fiscus/db';
import {
  EmailChannel,
  GotifyChannel,
  type MailTransport,
  NtfyChannel,
  WebhookChannel,
} from '@fiscus/notify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';
import { notifyConnectionTrouble } from './connection-trouble.js';
import { Notifier, type NotifierChannels } from './notifier.js';

/**
 * Delivering notifications (#125, #126, #130) against Postgres, as the fiscus_worker role: routing
 * to the recipient's channels, sending (a stub mail transport, a fake HTTP server), retrying with
 * backoff, and sending each once (D20).
 */

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/** A fake mail server and a fake web server, both recording what they get. */
function fakes() {
  const mail: { to: string; subject: string; text: string }[] = [];
  const http: { url: string; body: any; headers: Record<string, string> }[] = [];
  let httpStatus = 200;
  let mailFailure: unknown = null;
  const transport: MailTransport = {
    async sendMail(m) {
      if (mailFailure) throw mailFailure;
      mail.push(m);
    },
  };
  const fetch = async (url: string, init: RequestInit) => {
    http.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return new Response(null, { status: httpStatus });
  };
  const channels = (email = true): NotifierChannels => ({
    email: email ? new EmailChannel(transport, 'Fiscus <fiscus@worker.test>') : null,
    ntfy: new NtfyChannel({ fetch }),
    gotify: new GotifyChannel({ fetch }),
    webhook: new WebhookChannel({ fetch }),
  });
  return {
    mail,
    http,
    channels,
    setHttpStatus: (s: number) => void (httpStatus = s),
    setMailFailure: (e: unknown) => void (mailFailure = e),
  };
}

describe('notification delivery', { timeout: 60_000 }, () => {
  let h: WorkerHarness;

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  const notifier = (channels: NotifierChannels, backoffMs = [60_000, 300_000]) =>
    new Notifier(
      { db: h.worker.db, crypto: h.crypto, channels, logger: quiet },
      { publicUrl: 'https://fiscus.test', backoffMs },
    );

  const enqueue = (memberId: string, fields: Partial<{ kind: string; testChannel: string }> = {}) =>
    withContext(h.worker.db, systemContext(h.householdId), (tx) =>
      enqueueNotification(tx, {
        householdId: h.householdId,
        memberId,
        kind: fields.kind ?? 'connection_needs_you',
        dedupeKey: `test:${randomUUID()}`,
        title: 'Sign in to Harbor Credit Union again',
        body: 'Fiscus can’t sync Harbor Credit Union until you sign in to it again.',
        summary: 'A bank connection needs you to sign in again.',
        link: `/h/${h.householdId}/accounts`,
        testChannel: fields.testChannel ?? null,
      }),
    );

  /** Sets up a channel as Settings saves it: its secrets encrypted with the household key. */
  const channel = (
    memberId: string,
    kind: 'ntfy' | 'gotify' | 'webhook',
    secret: Record<string, string>,
    settings: Record<string, string> = {},
    detail = 'full',
  ) =>
    withContext(h.worker.db, systemContext(h.householdId), async (tx) => {
      const id = randomUUID();
      const secretEnc = await encryptChannelSecret(h.crypto, h.householdId, id, secret);
      await tx
        .insert(notificationChannels)
        .values({ id, householdId: h.householdId, memberId, kind, detail, settings, secretEnc });
    });

  const deliveries = async (notificationId: string) =>
    (
      await h.owner.query(
        `SELECT channel, status, attempts, last_error_code,
                round(extract(epoch FROM next_attempt_at - now()) / 60)::int AS next_in_minutes
         FROM notification_deliveries WHERE notification_id = $1 ORDER BY channel`,
        [notificationId],
      )
    ).rows;
  const notification = async (id: string) =>
    (await h.owner.query(`SELECT in_app, routed_at FROM notifications WHERE id = $1`, [id]))
      .rows[0];
  const makeDue = (notificationId: string) =>
    h.owner.query(
      `UPDATE notification_deliveries SET next_attempt_at = now() - interval '1 second'
       WHERE notification_id = $1`,
      [notificationId],
    );

  it('sends a rule to In Fiscus and email by default (D18), once', async () => {
    const f = fakes();
    const member = await h.member(h.householdId, 'Alex');
    const id = (await enqueue(member))!;
    const n = notifier(f.channels());
    await n.pass();
    expect(await notification(id)).toMatchObject({ in_app: true });
    expect(await deliveries(id)).toMatchObject([{ channel: 'email', status: 'sent', attempts: 1 }]);
    expect(f.mail).toHaveLength(1);
    expect(f.mail[0]!.to).toMatch(/@worker\.test$/);
    expect(f.mail[0]!.subject).toBe('Sign in to Harbor Credit Union again');
    expect(f.mail[0]!.text).toContain(`https://fiscus.test/h/${h.householdId}/accounts`);
    // Another pass, or another worker started afresh, sends nothing more.
    await n.pass();
    await notifier(f.channels()).pass();
    expect(f.mail).toHaveLength(1);
  });

  it('leaves email out when the server can’t send it, and push channels until set up', async () => {
    const f = fakes();
    const member = await h.member(h.householdId);
    const id = (await enqueue(member))!;
    await notifier(f.channels(false)).pass();
    expect(await notification(id)).toMatchObject({ in_app: true });
    expect(await deliveries(id)).toEqual([]);
  });

  it('adds a push channel once set up, at its detail level, with its secrets decrypted', async () => {
    const f = fakes();
    const member = await h.member(h.householdId);
    await channel(
      member,
      'ntfy',
      { topic: 'rivera-alex-7f3a', token: 'tk_1' },
      { server: 'https://ntfy.example.test', hint: 'topic rivera-alex-…' },
      'summary',
    );
    const id = (await enqueue(member))!;
    await notifier(f.channels()).pass();
    expect((await deliveries(id)).map((d) => [d.channel, d.status])).toEqual([
      ['email', 'sent'],
      ['ntfy', 'sent'],
    ]);
    expect(f.http).toHaveLength(1);
    expect(f.http[0]!.url).toBe('https://ntfy.example.test');
    expect(f.http[0]!.headers.authorization).toBe('Bearer tk_1');
    // Summary detail: no bank's name.
    expect(f.http[0]!.body).toMatchObject({
      topic: 'rivera-alex-7f3a',
      title: 'Fiscus',
      message: 'A bank connection needs you to sign in again.',
    });
  });

  it('follows what the member ticked, In Fiscus included', async () => {
    const f = fakes();
    const member = await h.member(h.householdId);
    await channel(member, 'webhook', { url: 'https://hooks.example.test/x', secret: 's' });
    await h.owner.query(
      `INSERT INTO notification_preferences (household_id, member_id, kind, channels)
       VALUES ($1, $2, 'connection_needs_you', ARRAY['webhook'])`,
      [h.householdId, member],
    );
    const id = (await enqueue(member))!;
    await notifier(f.channels()).pass();
    expect(await notification(id)).toMatchObject({ in_app: false });
    expect((await deliveries(id)).map((d) => d.channel)).toEqual(['webhook']);
    expect(f.http[0]!.body).toMatchObject({
      type: 'notification',
      id,
      kind: 'connection_needs_you',
    });
    expect(f.http[0]!.headers['x-fiscus-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(f.mail).toEqual([]);
  });

  it('backs off and retries a failure, then sends it', async () => {
    const f = fakes();
    const member = await h.member(h.householdId);
    await channel(member, 'gotify', { token: 'g' }, { server: 'https://gotify.example.test' });
    const id = (await enqueue(member))!;
    f.setHttpStatus(503);
    const n = notifier(f.channels(false));
    await n.pass();
    expect(await deliveries(id)).toMatchObject([
      {
        channel: 'gotify',
        status: 'pending',
        attempts: 1,
        last_error_code: 'http_503',
        next_in_minutes: 1,
      },
    ]);
    // Not due yet: nothing is sent.
    await n.pass();
    expect(f.http).toHaveLength(1);
    await makeDue(id);
    f.setHttpStatus(200);
    await n.pass();
    expect(await deliveries(id)).toMatchObject([
      { status: 'sent', attempts: 2, last_error_code: null },
    ]);
    expect(f.http).toHaveLength(2);
  });

  it('gives up after its retries, and at once when the other end refuses it', async () => {
    const f = fakes();
    const member = await h.member(h.householdId);
    await channel(member, 'gotify', { token: 'g' }, { server: 'https://gotify.example.test' });
    const busy = (await enqueue(member))!;
    f.setHttpStatus(502);
    const n = notifier(f.channels(false), [60_000]);
    await n.pass();
    await makeDue(busy);
    await n.pass();
    expect(await deliveries(busy)).toMatchObject([
      { status: 'failed', attempts: 2, last_error_code: 'http_502' },
    ]);
    const refused = (await enqueue(member))!;
    f.setHttpStatus(401);
    await n.pass();
    expect(await deliveries(refused)).toMatchObject([
      { status: 'failed', attempts: 1, last_error_code: 'http_401' },
    ]);
  });

  it('records the mail server’s refusal as a code', async () => {
    const f = fakes();
    const member = await h.member(h.householdId);
    const id = (await enqueue(member))!;
    f.setMailFailure(Object.assign(new Error('550 5.1.1 <x> no such user'), { responseCode: 550 }));
    await notifier(f.channels()).pass();
    expect(await deliveries(id)).toMatchObject([
      { channel: 'email', status: 'failed', last_error_code: 'smtp_550' },
    ]);
  });

  it('sends each delivery once with two workers at it', async () => {
    const f = fakes();
    const member = await h.member(h.householdId);
    const ids = await Promise.all([enqueue(member), enqueue(member), enqueue(member)]);
    await Promise.all([notifier(f.channels()).pass(), notifier(f.channels()).pass()]);
    for (const id of ids) expect(await deliveries(id!)).toMatchObject([{ status: 'sent' }]);
    expect(f.mail).toHaveLength(3);
  });

  it('sends a test to its channel only, and says why when it can’t', async () => {
    const f = fakes();
    const member = await h.member(h.householdId);
    const notSetUp = (await enqueue(member, { kind: 'test', testChannel: 'webhook' }))!;
    const email = (await enqueue(member, { kind: 'test', testChannel: 'email' }))!;
    await notifier(f.channels(false)).pass();
    expect(await notification(notSetUp)).toMatchObject({ in_app: false });
    expect(await deliveries(notSetUp)).toMatchObject([
      { channel: 'webhook', status: 'failed', last_error_code: 'not_configured' },
    ]);
    expect(await deliveries(email)).toMatchObject([
      { channel: 'email', status: 'failed', last_error_code: 'email_unavailable' },
    ]);
  });

  it('sends nothing to someone who has left the household', async () => {
    const f = fakes();
    const member = await h.member(h.householdId);
    const id = (await enqueue(member))!;
    await h.owner.query(`UPDATE household_members SET left_at = now() WHERE id = $1`, [member]);
    await notifier(f.channels()).pass();
    expect(await notification(id)).toMatchObject({ in_app: false });
    expect(await deliveries(id)).toEqual([]);
  });
});

describe('a bank connection needs you (D18)', { timeout: 60_000 }, () => {
  let h: WorkerHarness;

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  const failing = async (status: string, since: string, owner?: string) => {
    const id = await h.connection({ status, ownerMemberId: owner ?? h.memberId });
    await h.owner.query(
      `UPDATE connections SET first_failed_at = now() - $2::interval WHERE id = $1`,
      [id, since],
    );
    return id;
  };
  const notified = async (connectionId: string) =>
    (
      await h.owner.query(
        `SELECT member_id, kind, title, link FROM notifications WHERE dedupe_key LIKE $1`,
        [`connection_needs_you:${connectionId}:%`],
      )
    ).rows;

  it('tells whoever linked it at once when it needs them to sign in, once', async () => {
    const id = await failing('login_required', '1 minute');
    expect(await notifyConnectionTrouble(h.worker.db, h.householdId, id)).toBe('needs_sign_in');
    // The next failure, or a restart, doesn't tell them again.
    expect(await notifyConnectionTrouble(h.worker.db, h.householdId, id)).toBeNull();
    expect(await notified(id)).toEqual([
      {
        member_id: h.memberId,
        kind: 'connection_needs_you',
        title: 'Sign in to your bank again',
        link: `/h/${h.householdId}/accounts`,
      },
    ]);
  });

  it('waits 3 days of failures before saying it isn’t working, as Accounts does', async () => {
    const recent = await failing('error', '2 days');
    expect(await notifyConnectionTrouble(h.worker.db, h.householdId, recent)).toBeNull();
    const old = await failing('error', '3 days 1 hour');
    expect(await notifyConnectionTrouble(h.worker.db, h.householdId, old)).toBe('not_working');
    expect((await notified(old))[0]).toMatchObject({
      title: 'A bank connection hasn’t synced for 3 days',
    });
  });

  it('says nothing about a connection that works, or whose owner has left', async () => {
    const fine = await h.connection({ status: 'ok' });
    expect(await notifyConnectionTrouble(h.worker.db, h.householdId, fine)).toBeNull();
    const gone = await h.member(h.householdId, 'Gone');
    const theirs = await failing('login_required', '1 minute', gone);
    await h.owner.query(`UPDATE household_members SET left_at = now() WHERE id = $1`, [gone]);
    expect(await notifyConnectionTrouble(h.worker.db, h.householdId, theirs)).toBeNull();
  });
});
