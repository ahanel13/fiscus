// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ConnectionSetup,
  type SimpleFinAvailability,
  simpleFinConnectSchema,
} from '@fiscus/shared';
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { ConnectService } from './connect.service.js';

/** Connecting the SimpleFIN Bridge (#91, D3): owners and members; viewers can't (ACC-01). */
@Controller('api/v1/households/:householdId/simplefin')
@UseGuards(HouseholdGuard)
@HouseholdRoles('owner', 'member')
export class SimpleFinController {
  constructor(private readonly connect: ConnectService) {}

  /** Whether SimpleFIN is on here, so the app offers it only when it is. */
  @Get()
  async availability(): Promise<{ data: SimpleFinAvailability }> {
    return { data: { available: await this.connect.simpleFinAvailable() } };
  }

  /** A setup token, claimed once: a connection in `setup`, and the accounts the Bridge offers. */
  @Post('connect')
  @HttpCode(201)
  async connectBridge(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(simpleFinConnectSchema)) body: z.infer<typeof simpleFinConnectSchema>,
  ): Promise<{ data: ConnectionSetup }> {
    return { data: await this.connect.connectSimpleFin(ctx, body.setupToken) };
  }
}
