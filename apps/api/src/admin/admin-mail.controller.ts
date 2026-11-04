// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { ChannelError, EmailChannel, renderMessage, smtpTransport } from '@fiscus/notify';
import { type MailStatus, type SetMailSettings, setMailSettingsSchema } from '@fiscus/shared';
import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { Auth, RequireInstanceAdmin, RequireRecentAuth } from '../auth/decorators.js';
import { Problem, problems } from '../common/problem.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { InstanceSettingsService } from './instance-settings.service.js';

const setByEnvironment = () =>
  new Problem(
    409,
    'mail_set_by_environment',
    'Your server’s environment sets the mail server',
    'SMTP_URL and MAIL_FROM are set, and win over the Server page. Change them there.',
  );

/**
 * Server → Email (D16, #125; ADM-05): the mail server notification email is sent through, and a
 * test to the admin's own address. It's set by SMTP_URL and MAIL_FROM, which win, or here; its
 * password is write-only and never shown. Notifications are sent by the worker, which reads the
 * same settings; the test is sent here, so the admin sees at once whether they work.
 */
@Controller('api/v1/admin/mail')
@RequireInstanceAdmin()
export class AdminMailController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly settings: InstanceSettingsService,
  ) {}

  @Get()
  async status(): Promise<{ data: MailStatus }> {
    return { data: await this.settings.mailStatus() };
  }

  @Put()
  @RequireRecentAuth()
  async set(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(setMailSettingsSchema)) body: SetMailSettings,
    @Req() req: FastifyRequest,
  ): Promise<{ data: MailStatus }> {
    if (this.config.mail) throw setByEnvironment();
    await this.settings.setMail(auth.user.id, body, req.ip);
    return { data: await this.settings.mailStatus() };
  }

  @Delete()
  @RequireRecentAuth()
  async remove(
    @Auth() auth: AuthContext,
    @Req() req: FastifyRequest,
  ): Promise<{ data: MailStatus }> {
    if (this.config.mail) throw setByEnvironment();
    if (!(await this.settings.removeMail(auth.user.id, req.ip))) throw problems.notFound();
    return { data: await this.settings.mailStatus() };
  }

  @Post('test')
  @HttpCode(204)
  async test(@Auth() auth: AuthContext): Promise<void> {
    const mail = (await this.settings.effectiveMail()).config;
    if (!mail) {
      throw new Problem(
        409,
        'mail_not_configured',
        'This server can’t send email yet',
        'Set the mail server here, or SMTP_URL and MAIL_FROM.',
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
        { reason: code },
      );
    }
  }
}
