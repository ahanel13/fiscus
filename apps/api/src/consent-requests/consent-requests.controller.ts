// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ConsentRequest,
  type CreateConsentRequest,
  createConsentRequestSchema,
} from '@fiscus/shared';
import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { ConsentRequestsService } from './consent-requests.service.js';

/**
 * Consent requests (#265, D34, SHR-10): everyone in the household sees them; owners and members
 * ask, the person asked declines (or agrees where the thing asked for is agreed to), and whoever
 * asked withdraws.
 */
@Controller('api/v1/households/:householdId/consent-requests')
@UseGuards(HouseholdGuard)
export class ConsentRequestsController {
  constructor(private readonly requests: ConsentRequestsService) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: ConsentRequest[] }> {
    return { data: await this.requests.list(ctx) };
  }

  @Post()
  @HouseholdRoles('owner', 'member')
  async create(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createConsentRequestSchema)) body: CreateConsentRequest,
  ): Promise<{ data: ConsentRequest }> {
    return { data: await this.requests.create(ctx, body) };
  }

  @Post(':requestId/decline')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async decline(
    @Household() ctx: HouseholdContext,
    @Param('requestId', UuidPipe) id: string,
  ): Promise<{ data: ConsentRequest }> {
    return { data: await this.requests.decline(ctx, id) };
  }

  @Post(':requestId/withdraw')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async withdraw(
    @Household() ctx: HouseholdContext,
    @Param('requestId', UuidPipe) id: string,
  ): Promise<{ data: ConsentRequest }> {
    return { data: await this.requests.withdraw(ctx, id) };
  }
}
