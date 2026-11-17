// SPDX-License-Identifier: AGPL-3.0-or-later
import { PLAID_WEBHOOK_PATH } from '@fiscus/aggregation';
import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { NoSession } from '../auth/decorators.js';
import { PlaidWebhookService } from './plaid-webhook.service.js';

/**
 * `POST /api/v1/webhooks/plaid` (#84): the one path that needs to be public when webhooks are on.
 * No session and no CSRF token (Plaid has neither); its own JWT is checked instead. 404 while
 * PLAID_WEBHOOK_URL is unset. 200 once queued (or ignored), 401 unverified, 429 over the rate
 * limit, 503 when the key can't be fetched now; bodies over 16 KB get 413.
 */
@NoSession()
@Controller()
export class PlaidWebhookController {
  constructor(private readonly webhooks: PlaidWebhookService) {}

  @Post(PLAID_WEBHOOK_PATH.slice(1))
  @HttpCode(200)
  async plaid(@Req() req: FastifyRequest): Promise<void> {
    const header = req.headers['plaid-verification'];
    await this.webhooks.receive({
      verification: typeof header === 'string' ? header : undefined,
      rawBody: req.rawBody ?? Buffer.alloc(0),
      body: req.body,
      ip: req.ip,
    });
  }
}
