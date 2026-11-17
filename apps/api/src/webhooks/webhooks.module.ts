// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PlaidWebhookController } from './plaid-webhook.controller.js';
import { PlaidWebhookService } from './plaid-webhook.service.js';

/** Providers' webhooks (#84): Plaid's, when the admin turns them on. */
@Module({
  imports: [AuthModule],
  controllers: [PlaidWebhookController],
  providers: [PlaidWebhookService],
})
export class WebhooksModule {}
