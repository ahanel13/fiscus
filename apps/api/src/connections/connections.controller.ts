// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Connection,
  type ConnectionConfirmed,
  type ConnectionSetup,
  confirmConnectionSchema,
} from '@fiscus/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { ConnectService } from './connect.service.js';
import { ConnectionsService } from './connections.service.js';

/** Bank connections: everyone sees the ones behind accounts they see (ACC-02); owners fix them. */
@Controller('api/v1/households/:householdId/connections')
@UseGuards(HouseholdGuard)
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly connect: ConnectService,
  ) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: Connection[] }> {
    return { data: await this.connections.list(ctx) };
  }

  /** A connection being set up, and what the bank offers: its owner only (D4). */
  @Get(':connectionId/setup')
  @HouseholdRoles('owner', 'member')
  async setup(
    @Household() ctx: HouseholdContext,
    @Param('connectionId', UuidPipe) id: string,
  ): Promise<{ data: ConnectionSetup }> {
    return { data: await this.connect.setup(ctx, id) };
  }

  /** What each offered account becomes; then the first sync starts (D4–D6). Its owner only. */
  @Post(':connectionId/confirm')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async confirm(
    @Household() ctx: HouseholdContext,
    @Param('connectionId', UuidPipe) id: string,
    @Body(new ZodPipe(confirmConnectionSchema)) body: z.infer<typeof confirmConnectionSchema>,
  ): Promise<{ data: ConnectionConfirmed }> {
    return { data: await this.connect.confirm(ctx, id, body) };
  }

  /** "Refresh now" (D10): a sync on the worker's next pass. Its owner only (ACC-03). */
  @Post(':connectionId/refresh')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async refresh(
    @Household() ctx: HouseholdContext,
    @Param('connectionId', UuidPipe) id: string,
  ): Promise<{ data: Connection }> {
    return { data: await this.connections.refresh(ctx, id) };
  }

  /** Signed in again through the provider (D11): it's `ok`, and syncs now. Its owner only. */
  @Post(':connectionId/reauthed')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async reauthed(
    @Household() ctx: HouseholdContext,
    @Param('connectionId', UuidPipe) id: string,
  ): Promise<{ data: Connection }> {
    return { data: await this.connections.reauthed(ctx, id) };
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
