// SPDX-License-Identifier: AGPL-3.0-or-later
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { ChannelError, type NotificationChannel, type OutgoingMessage } from './channel.js';
import { renderEmail } from './templates.js';

// Email (D16, #125): sent by the server, set up once by whoever runs it: with SMTP_URL and
// MAIL_FROM, or on the Server page (stored in instance settings), the environment winning. Each
// member's go to the address they sign in with.

export const mailEnvVars = {
  SMTP_URL: {
    schema: z.url({ protocol: /^smtps?$/, error: 'must be an smtp:// or smtps:// URL' }).optional(),
    description:
      'Mail server for notification emails, as smtp://user:password@host:587 (STARTTLS) or ' +
      'smtps://user:password@host:465. Set it with MAIL_FROM. Unset: an instance admin can set ' +
      'the mail server on the Server page instead; set, it wins over that.',
    example: 'smtp://fiscus:password@mail.example.com:587',
    secret: true,
  },
  MAIL_FROM: {
    schema: z.string().trim().min(3).max(200).optional(),
    description:
      'Who notification emails are from, such as "Fiscus <fiscus@example.com>". Set it with ' +
      'SMTP_URL (or set both on the Server page).',
  },
};

export interface MailEnv {
  SMTP_URL?: string | undefined;
  MAIL_FROM?: string | undefined;
}

export const MAIL_SECURITY = ['tls', 'starttls', 'none'] as const;
/** TLS from the start (usually port 465), STARTTLS after connecting (587), or none (25). */
export type MailSecurity = (typeof MAIL_SECURITY)[number];

/** A mail server as the Server page sets it. */
export interface SmtpServer {
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null;
  password: string | null;
}

/**
 * The server's mail settings: SMTP_URL's, or the Server page's. Never logged or returned whole
 * (they hold a password).
 */
export type MailConfig = { from: string } & (
  { smtpUrl: string; server?: undefined } | { server: SmtpServer; smtpUrl?: undefined }
);

/** What the Server page shows of the settings in use: never the password. */
export interface MailSummary {
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null;
  hasPassword: boolean;
  from: string;
}

/** The settings in use, as the Server page shows them. */
export function summarizeMail(config: MailConfig): MailSummary {
  if (config.server) {
    const { password, ...rest } = config.server;
    return { ...rest, hasPassword: !!password, from: config.from };
  }
  const url = new URL(config.smtpUrl);
  const tls = url.protocol === 'smtps:';
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : tls ? 465 : 587,
    security: tls ? 'tls' : 'starttls',
    username: url.username ? decodeURIComponent(url.username) : null,
    hasPassword: !!url.password,
    from: config.from,
  };
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
  const timeouts = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };
  if (!config.server) {
    return nodemailer.createTransport({
      url: config.smtpUrl,
      ...timeouts,
    } as Parameters<typeof nodemailer.createTransport>[0]);
  }
  const s = config.server;
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    ...(s.username ? { auth: { user: s.username, pass: s.password ?? '' } } : {}),
    ...timeouts,
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
    const { subject, text, html } = renderEmail(message);
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
