// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BankConnectionsOverview,
  bankConnectionsOverviewSchema,
  type InstanceSettings,
  instanceSettingsSchema,
  type UpdateInstanceSettings,
  updateInstanceSettingsSchema,
} from '@fiscus/shared';
import { Body, Controller, Get, Inject, Patch, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { Auth, RequireInstanceAdmin, RequireRecentAuth } from '../auth/decorators.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { InstanceSettingsService } from './instance-settings.service.js';

/**
 * Instance settings (permissions ADM-05, #400): instance admins only, with a session (personal
 * access tokens never reach /admin). Responses go through the strict schemas in @fiscus/shared, so
 * a field nobody allowed fails the request instead of reaching the admin.
 */
@Controller('api/v1/admin')
@RequireInstanceAdmin()
export class AdminSettingsController {
  constructor(
    private readonly settings: InstanceSettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('settings')
  async get(): Promise<{ data: InstanceSettings }> {
    return { data: instanceSettingsSchema.parse(await this.settings.all()) };
  }

  @Patch('settings')
  @RequireRecentAuth()
  async update(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(updateInstanceSettingsSchema)) body: UpdateInstanceSettings,
    @Req() req: FastifyRequest,
  ): Promise<{ data: InstanceSettings }> {
    return {
      data: instanceSettingsSchema.parse(await this.settings.update(auth.user.id, body, req.ip)),
    };
  }

  /**
   * Server → Bank connections (walkthrough §8): how this server reaches banks, as settings and
   * counts, never content (D16).
   */
  @Get('bank-connections')
  async bankConnections(@Auth() auth: AuthContext): Promise<{ data: BankConnectionsOverview }> {
    const settings = await this.settings.all();
    const stats = await this.settings.bankStats(auth.user.id);
    const plaid = this.config.plaid;
    return {
      data: bankConnectionsOverviewSchema.parse({
        plaid: { configured: !!plaid, environment: plaid?.env ?? null },
        simplefin: { enabled: settings['simplefin.enabled'] },
        settings,
        stats,
      }),
    };
  }
}
