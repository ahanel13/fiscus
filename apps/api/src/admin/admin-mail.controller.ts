// SPDX-License-Identifier: AGPL-3.0-or-later
import { ChannelError, EmailChannel, renderMessage, smtpTransport } from '@fiscus/notify';
import type { MailStatus } from '@fiscus/shared';
import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context.js';
import { Auth, RequireInstanceAdmin } from '../auth/decorators.js';
import { Problem } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';

/**
 * Server → Email (D16, #125; ADM-05): whether this server can send notification email, and a
 * test to the admin's own address. The settings are SMTP_URL and MAIL_FROM; the URL, which holds
 * the mail server's password, is never shown. Notifications themselves are sent by the worker;
 * the test is sent here, so the admin sees at once whether the settings work.
 */
@Controller('api/v1/admin/mail')
@RequireInstanceAdmin()
export class AdminMailController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  status(): { data: MailStatus } {
    return {
      data: { configured: !!this.config.mail, from: this.config.mail?.from ?? null },
    };
  }

  @Post('test')
  @HttpCode(204)
  async test(@Auth() auth: AuthContext): Promise<void> {
    const mail = this.config.mail;
    if (!mail) {
      throw new Problem(
        409,
        'mail_not_configured',
        'This server can’t send email yet',
        'Set SMTP_URL and MAIL_FROM, then restart Fiscus.',
      );
    }
    const channel = new EmailChannel(this.config.mailTransport ?? smtpTransport(mail), mail.from);
    const message = renderMessage(
      {
        id: randomUUID(),
        kind: 'test',
        title: 'A test from Fiscus',
        body: 'Your server can send email. Everyone in it can now choose to get their notifications by email.',
        summary: 'A test from Fiscus.',
        link: '/server',
        createdAt: new Date(),
      },
      'full',
      this.config.publicUrl,
      null,
    );
    try {
      await channel.send(message, { to: auth.user.email });
    } catch (error) {
      const code = error instanceof ChannelError ? error.code : 'internal';
      // The code only: the mail server's own words can quote the settings.
      throw new Problem(
        502,
        'mail_failed',
        'The test email didn’t go through',
        code,
        undefined,
        {},
        {
          reason: code,
        },
      );
    }
  }
}
