// SPDX-License-Identifier: AGPL-3.0-or-later
import { encryptMailPassword } from '@fiscus/db';
import type { MailConfig, MailTransport } from '@fiscus/notify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';
import { MailSource } from './mail-source.js';

/** The worker's mail server (D16): SMTP_URL's, else the Server page's, read as it changes. */
describe('the mail server the worker sends through', { timeout: 60_000 }, () => {
  let h: WorkerHarness;
  let clock = 0;
  let made: MailConfig[] = [];
  const transport = (config: MailConfig): MailTransport => {
    made.push(config);
    return { sendMail: async () => undefined };
  };
  const source = (env: MailConfig | null = null) =>
    new MailSource(h.worker.db, h.crypto, env, { ttlMs: 60_000, transport, now: () => clock });
  const save = (value: object) =>
    h.owner.query(
      `INSERT INTO instance_settings (key, value) VALUES ('mail.smtp', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(value)],
    );

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    made = [];
    clock = 0;
    await h.owner.query(`DELETE FROM instance_settings WHERE key = 'mail.smtp'`);
  });

  it('sends nothing without settings', async () => {
    expect(await source().current()).toBeNull();
  });

  it('uses the Server page’s settings, its password decrypted, and picks up a change', async () => {
    await save({
      host: 'mail.example.test',
      port: 587,
      security: 'starttls',
      username: 'fiscus',
      passwordEnc: encryptMailPassword(h.crypto, 'hunter2'),
      from: 'Fiscus <fiscus@example.test>',
    });
    const s = source();
    expect(await s.current()).not.toBeNull();
    expect(made).toEqual([
      {
        from: 'Fiscus <fiscus@example.test>',
        server: {
          host: 'mail.example.test',
          port: 587,
          security: 'starttls',
          username: 'fiscus',
          password: 'hunter2',
        },
      },
    ]);
    // Removed on the Server page: within the minute, no email.
    await save({});
    clock = 30_000;
    expect(await s.current()).not.toBeNull();
    clock = 61_000;
    expect(await s.current()).toBeNull();
  });

  it('lets SMTP_URL and MAIL_FROM win', async () => {
    await save({
      host: 'mail.example.test',
      port: 465,
      security: 'tls',
      username: null,
      passwordEnc: null,
      from: 'page@example.test',
    });
    const env = { smtpUrl: 'smtp://env.example.test:587', from: 'env@example.test' };
    await source(env).current();
    expect(made).toEqual([env]);
  });

  it('treats a password it can’t decrypt as none, rather than failing', async () => {
    await save({
      host: 'mail.example.test',
      port: 587,
      security: 'starttls',
      username: 'fiscus',
      passwordEnc: Buffer.from('not a ciphertext').toString('base64'),
      from: 'f@example.test',
    });
    await source().current();
    expect(made[0]!.server!.password).toBeNull();
  });
});
