// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ConnectionSetup,
  type PlaidAvailability,
  plaidExchangeSchema,
  type PlaidLinkExit,
  plaidLinkExitSchema,
  type PlaidLinkToken,
} from '@fiscus/shared';
import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { ConnectService } from './connect.service.js';

/** Connecting a bank through Plaid Link (#79, D2): owners and members; viewers can't (ACC-01). */
@Controller('api/v1/households/:householdId/plaid')
@UseGuards(HouseholdGuard)
@HouseholdRoles('owner', 'member')
export class PlaidController {
  constructor(private readonly connect: ConnectService) {}

  /** Whether Plaid is available here, so the app offers "Connect a bank" only when it is. */
  @Get()
  async availability(@Household() ctx: HouseholdContext): Promise<{ data: PlaidAvailability }> {
    return { data: await this.connect.availability(ctx) };
  }

  /** For Link. With `?connection=`, update mode: its owner signs in again (ACC-03, #81). */
  @Post('link-token')
  @HttpCode(200)
  async linkToken(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(z.object({ connection: z.uuid().optional() })))
    query: { connection?: string },
  ): Promise<{ data: PlaidLinkToken }> {
    return { data: await this.connect.linkToken(ctx, query.connection) };
  }

  /** Link's public token, exchanged once: a connection in `setup`, and what the bank offers. */
  @Post('exchange')
  @HttpCode(201)
  async exchange(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(plaidExchangeSchema)) body: z.infer<typeof plaidExchangeSchema>,
  ): Promise<{ data: ConnectionSetup }> {
    return { data: await this.connect.exchange(ctx, body) };
  }

  /** Link closed without connecting: recorded for you, so Plaid's support can trace it. */
  @Post('link-exit')
  @HttpCode(204)
  async linkExit(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(plaidLinkExitSchema)) body: PlaidLinkExit,
  ): Promise<void> {
    await this.connect.linkExit(ctx, body);
  }
}
