// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto } from '@fiscus/crypto';
import { type Database, readStoredMail } from '@fiscus/db';
import { EmailChannel, type MailConfig, type MailTransport, smtpTransport } from '@fiscus/notify';

// Where the worker's email goes out (D16): SMTP_URL and MAIL_FROM when they're set, which win;
// otherwise the mail server an admin saved on the Server page, read from the database and kept
// for a minute, so a change there takes effect without a restart.

export const MAIL_SOURCE_TTL_MS = 60_000;

export class MailSource {
  #cache: { channel: EmailChannel | null; until: number } | null = null;
  #last: { key: string; channel: EmailChannel } | null = null;

  constructor(
    private readonly db: Database,
    private readonly crypto: FieldCrypto,
    /** SMTP_URL and MAIL_FROM, or null. */
    private readonly env: MailConfig | null,
    private readonly options: {
      ttlMs?: number;
      transport?: (config: MailConfig) => MailTransport;
      now?: () => number;
    } = {},
  ) {}

  /** The email channel for the settings in use now, or null when there are none. */
  async current(): Promise<EmailChannel | null> {
    const now = this.options.now?.() ?? Date.now();
    if (this.#cache && this.#cache.until > now) return this.#cache.channel;
    const config = this.env ?? (await this.#stored());
    let channel: EmailChannel | null = null;
    if (config) {
      const key = JSON.stringify(config);
      if (this.#last?.key !== key) {
        const transport = (this.options.transport ?? smtpTransport)(config);
        this.#last = { key, channel: new EmailChannel(transport, config.from) };
      }
      channel = this.#last.channel;
    }
    this.#cache = { channel, until: now + (this.options.ttlMs ?? MAIL_SOURCE_TTL_MS) };
    return channel;
  }

  async #stored(): Promise<MailConfig | null> {
    const s = await readStoredMail(this.db, this.crypto);
    if (!s) return null;
    return {
      from: s.from,
      server: {
        host: s.host,
        port: s.port,
        security: s.security,
        username: s.username,
        password: s.password,
      },
    };
  }
}
