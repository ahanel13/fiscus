// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Connection } from '@fiscus/shared';
import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common';
import { UuidPipe } from '../common/uuid-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { ConnectionsService } from './connections.service.js';

/** Bank connections: everyone sees the ones behind accounts they see (ACC-02); owners fix them. */
@Controller('api/v1/households/:householdId/connections')
@UseGuards(HouseholdGuard)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: Connection[] }> {
    return { data: await this.connections.list(ctx) };
  }

  /** Disconnects it (D14): its accounts and their history stay. ACC-03. */
  @Delete(':connectionId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async disconnect(
    @Household() ctx: HouseholdContext,
    @Param('connectionId', UuidPipe) id: string,
  ): Promise<void> {
    await this.connections.disconnect(ctx, id);
  }
}
