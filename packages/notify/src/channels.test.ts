// SPDX-License-Identifier: AGPL-3.0-or-later
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { ChannelError, renderMessage, type StoredNotification } from './channel.js';
import { EmailChannel, smtpFailure, smtpTransport } from './email.js';
import { GotifyChannel, NtfyChannel, WebhookChannel, webhookSignature } from './http.js';

const stored: StoredNotification = {
  id: '0190f3c2-0000-7000-8000-000000000001',
  kind: 'connection_needs_you',
  title: 'Sign in to Harbor Credit Union again',
  body: 'Fiscus can’t sync Harbor Credit Union until you sign in to it again.',
  summary: 'A bank connection needs you to sign in again.',
  link: '/h/abc/accounts',
  createdAt: new Date('2026-11-12T15:00:00Z'),
};
const full = renderMessage(stored, 'full', 'https://fiscus.test', '/h/abc/settings/notifications');

/** A fake server: records each request and answers with `status`. */
function fakeFetch(status = 200, fail?: Error) {
  const requests: { url: string; init: RequestInit; body: any }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) });
    if (fail) throw fail;
    return new Response(status === 204 ? null : 'secret echo', { status });
  };
  return { fetch, requests };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ChannelError);
    return { code: (e as ChannelError).code, permanent: (e as ChannelError).permanent };
  }
  throw new Error('expected a failure');
};

describe('detail levels (D17)', () => {
  it('full carries the notification, with absolute links', () => {
    expect(full).toMatchObject({
      title: stored.title,
      body: stored.body,
      url: 'https://fiscus.test/h/abc/accounts',
      settingsUrl: 'https://fiscus.test/h/abc/settings/notifications',
    });
  });

  it('summary leaves out names; minimal says only that there is something new', () => {
    expect(renderMessage(stored, 'summary', 'https://fiscus.test', null)).toMatchObject({
      title: 'Fiscus',
      body: 'A bank connection needs you to sign in again.',
      url: 'https://fiscus.test/h/abc/accounts',
    });
    expect(renderMessage(stored, 'minimal', 'https://fiscus.test', null)).toMatchObject({
      title: 'Fiscus',
      body: 'You have new activity in Fiscus.',
      url: 'https://fiscus.test/',
    });
  });

  it('has no links without the server’s address', () => {
    expect(renderMessage(stored, 'full', null, '/x')).toMatchObject({
      url: null,
      settingsUrl: null,
    });
  });
});

describe('email (#125)', () => {
  it('sends plain text and HTML through the transport (a stub here)', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sent: any[] = [];
    const channel = new EmailChannel(
      {
        sendMail: async (mail) => {
          const info = await transport.sendMail(mail);
          sent.push(JSON.parse((info as { message: string }).message));
        },
      },
      'Fiscus <fiscus@example.test>',
    );
    await channel.send(full, { to: 'alex@rivera.test' });
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail.subject).toBe(stored.title);
    expect(mail.to).toEqual([{ address: 'alex@rivera.test', name: '' }]);
    expect(mail.text).toContain('Open Fiscus: https://fiscus.test/h/abc/accounts');
    expect(mail.text).toContain('Change them: https://fiscus.test/h/abc/settings/notifications');
    expect(mail.html).toContain('href="https://fiscus.test/h/abc/accounts"');
    expect(mail.headers['Auto-Submitted']).toBe('auto-generated');
  });

  it('escapes what goes into the HTML', async () => {
    let html = '';
    const channel = new EmailChannel(
      { sendMail: async (m) => void (html = m.html) },
      'fiscus@example.test',
    );
    await channel.send({ ...full, title: '<b>x</b>' }, { to: 'a@b.test' });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('turns the mail server’s refusals into codes, never its words', async () => {
    expect(smtpFailure({ responseCode: 550, response: '550 no such user' })).toMatchObject({
      code: 'smtp_550',
      permanent: true,
    });
    expect(smtpFailure({ responseCode: 421 })).toMatchObject({
      code: 'smtp_421',
      permanent: false,
    });
    expect(smtpFailure({ code: 'ETIMEDOUT' })).toMatchObject({ code: 'timeout', permanent: false });
    expect(smtpFailure(new Error('boom'))).toMatchObject({ code: 'network' });
    const channel = new EmailChannel(
      { sendMail: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EAUTH' })) },
      'f@x.test',
    );
    expect(await failure(channel.send(full, { to: 'a@b.test' }))).toEqual({
      code: 'smtp_auth',
      permanent: false,
    });
  });

  it('fails a server that isn’t there as a network error, quickly', async () => {
    const channel = new EmailChannel(
      smtpTransport({ smtpUrl: 'smtp://127.0.0.1:1', from: 'f@x.test' }),
      'f@x.test',
    );
    expect((await failure(channel.send(full, { to: 'a@b.test' }))).permanent).toBe(false);
  });
});

describe('ntfy (#126)', () => {
  it('publishes JSON to the server, with the topic, token and link', async () => {
    const { fetch, requests } = fakeFetch();
    await new NtfyChannel({ fetch }).send(full, {
      server: 'https://ntfy.example.test/',
      topic: 'rivera-alex-7f3a',
      token: 'tk_secret',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://ntfy.example.test');
    expect(requests[0]!.init.redirect).toBe('manual');
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer tk_secret',
    );
    expect(requests[0]!.body).toMatchObject({
      topic: 'rivera-alex-7f3a',
      title: stored.title,
      message: stored.body,
      click: 'https://fiscus.test/h/abc/accounts',
    });
  });

  it('treats a refusal as permanent, and a busy server as worth retrying', async () => {
    const config = { server: 'https://ntfy.sh', topic: 't' };
    expect(await failure(new NtfyChannel(fakeFetch(403)).send(full, config))).toEqual({
      code: 'http_403',
      permanent: true,
    });
    expect(await failure(new NtfyChannel(fakeFetch(429)).send(full, config))).toEqual({
      code: 'http_429',
      permanent: false,
    });
    expect(await failure(new NtfyChannel(fakeFetch(502)).send(full, config))).toEqual({
      code: 'http_502',
      permanent: false,
    });
    expect(await failure(new NtfyChannel(fakeFetch(302)).send(full, config))).toEqual({
      code: 'redirect',
      permanent: true,
    });
    const down = fakeFetch(200, new TypeError('fetch failed'));
    expect(await failure(new NtfyChannel(down).send(full, config))).toEqual({
      code: 'network',
      permanent: false,
    });
    const slow = fakeFetch(200, Object.assign(new Error('t'), { name: 'TimeoutError' }));
    expect(await failure(new NtfyChannel(slow).send(full, config))).toEqual({
      code: 'timeout',
      permanent: false,
    });
  });
});

describe('Gotify (#126)', () => {
  it('posts a message with the application token', async () => {
    const { fetch, requests } = fakeFetch();
    await new GotifyChannel({ fetch }).send(full, {
      server: 'https://gotify.example.test',
      token: 'AbCdEf',
    });
    expect(requests[0]!.url).toBe('https://gotify.example.test/message');
    expect((requests[0]!.init.headers as Record<string, string>)['x-gotify-key']).toBe('AbCdEf');
    expect(requests[0]!.body).toEqual({
      title: stored.title,
      message: stored.body,
      priority: 5,
      extras: { 'client::notification': { click: { url: 'https://fiscus.test/h/abc/accounts' } } },
    });
  });
});

describe('webhook (#126)', () => {
  it('posts the documented JSON, signed when it has a secret', async () => {
    const { fetch, requests } = fakeFetch(204);
    const now = new Date('2026-11-12T15:00:05Z');
    await new WebhookChannel({ fetch, now: () => now }).send(full, {
      url: 'https://hooks.example.test/fiscus?key=abc',
      secret: 's3cret',
    });
    const r = requests[0]!;
    expect(r.url).toBe('https://hooks.example.test/fiscus?key=abc');
    expect(r.body).toEqual({
      type: 'notification',
      id: stored.id,
      kind: 'connection_needs_you',
      detail: 'full',
      title: stored.title,
      body: stored.body,
      url: 'https://fiscus.test/h/abc/accounts',
      createdAt: '2026-11-12T15:00:00.000Z',
    });
    const headers = r.init.headers as Record<string, string>;
    expect(headers['x-fiscus-timestamp']).toBe(String(now.getTime() / 1000));
    expect(headers['x-fiscus-signature']).toBe(
      webhookSignature('s3cret', headers['x-fiscus-timestamp']!, String(r.init.body)),
    );
  });

  it('is unsigned without a secret', async () => {
    const { fetch, requests } = fakeFetch();
    await new WebhookChannel({ fetch }).send(full, { url: 'http://homeassistant.local/hook' });
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers['x-fiscus-signature']).toBeUndefined();
  });
});
