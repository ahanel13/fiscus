// SPDX-License-Identifier: AGPL-3.0-or-later
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { ChannelError, type NotificationChannel, type OutgoingMessage } from './channel.js';
import { renderEmail } from './templates.js';

// Email (D16, #125): sent by the server, set up once by whoever runs it with SMTP_URL and
// MAIL_FROM. Each member's go to the address they sign in with.

export const mailEnvVars = {
  SMTP_URL: {
    schema: z.url({ protocol: /^smtps?$/, error: 'must be an smtp:// or smtps:// URL' }).optional(),
    description:
      'Mail server for notification emails, as smtp://user:password@host:587 (STARTTLS) or ' +
      'smtps://user:password@host:465. Unset: Fiscus sends no email. Set it with MAIL_FROM.',
    example: 'smtp://fiscus:password@mail.example.com:587',
    secret: true,
  },
  MAIL_FROM: {
    schema: z.string().trim().min(3).max(200).optional(),
    description:
      'Who notification emails are from, such as "Fiscus <fiscus@example.com>". Set it with ' +
      'SMTP_URL.',
  },
};

export interface MailEnv {
  SMTP_URL?: string | undefined;
  MAIL_FROM?: string | undefined;
}

/** The server's mail settings; never logged or returned (the URL has a password). */
export interface MailConfig {
  smtpUrl: string;
  from: string;
}

/**
 * The mail settings, or null without them. One without the other is a mistake worth stopping
 * for, as with Plaid's keys: `fatal` is called with what's missing.
 */
export function mailConfigOrExit(
  env: MailEnv,
  fatal: (message: string) => void,
): MailConfig | null {
  if (!env.SMTP_URL && !env.MAIL_FROM) return null;
  if (!env.SMTP_URL || !env.MAIL_FROM) {
    fatal(
      `Set both SMTP_URL and MAIL_FROM to send email, or neither (${env.SMTP_URL ? 'MAIL_FROM' : 'SMTP_URL'} is missing)`,
    );
    process.exit(1);
  }
  return { smtpUrl: env.SMTP_URL, from: env.MAIL_FROM };
}

/** What sending needs of a transport: nodemailer's, or a stub's in tests. */
export interface MailTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }): Promise<unknown>;
}

/** A transport for the server's mail settings, with timeouts so a dead server fails quickly. */
export function smtpTransport(config: MailConfig): MailTransport {
  return nodemailer.createTransport({
    url: config.smtpUrl,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  } as Parameters<typeof nodemailer.createTransport>[0]);
}

export interface EmailConfig {
  to: string;
}

/** nodemailer's error codes, as ours: never its message, which can quote the server. */
export function smtpFailure(error: unknown): ChannelError {
  const e = error as { responseCode?: unknown; code?: unknown };
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 600) {
    // 5xx: the server refused it for good (no such mailbox, not allowed to relay).
    return new ChannelError(`smtp_${e.responseCode}`, e.responseCode >= 500);
  }
  switch (e.code) {
    case 'ETIMEDOUT':
      return new ChannelError('timeout');
    case 'EAUTH':
      return new ChannelError('smtp_auth');
    case 'ETLS':
      return new ChannelError('smtp_tls');
    case 'EENVELOPE':
      return new ChannelError('smtp_envelope', true);
    default:
      return new ChannelError('network');
  }
}

export class EmailChannel implements NotificationChannel<EmailConfig> {
  readonly kind = 'email' as const;

  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {}

  async send(message: OutgoingMessage, config: EmailConfig): Promise<void> {
    if (!config.to) throw new ChannelError('no_address', true);
    const { subject, text, html } = message.email ?? renderEmail(message);
    try {
      await this.transport.sendMail({
        from: this.from,
        to: config.to,
        subject,
        text,
        html,
        // Not a person's mail: auto-replies stay away (RFC 3834).
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
    } catch (error) {
      throw smtpFailure(error);
    }
  }
}
