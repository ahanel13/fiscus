// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AttributionFlag,
  type AttributionFlagStatus,
  flagAttributionSchema,
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
import { AttributionFlagsService } from './attribution-flags.service.js';

/** Flagging a change to who a transaction is for (#60, ATT-03, ATT-04). */
@Controller('api/v1/households/:householdId/transactions/:transactionId/flag')
@UseGuards(HouseholdGuard)
export class AttributionFlagsController {
  constructor(private readonly flags: AttributionFlagsService) {}

  @Get()
  async status(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
  ): Promise<{ data: AttributionFlagStatus }> {
    return { data: await this.flags.status(ctx, id) };
  }

  @Post()
  @HouseholdRoles('owner', 'member')
  async flag(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
    @Body(new ZodPipe(flagAttributionSchema)) body: z.infer<typeof flagAttributionSchema>,
  ): Promise<{ data: AttributionFlag }> {
    return { data: await this.flags.flag(ctx, id, body.note) };
  }

  /** Resolves the open flag (the paying account's owners) or withdraws it (whoever raised it). */
  @Delete()
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async resolve(
    @Household() ctx: HouseholdContext,
    @Param('transactionId', UuidPipe) id: string,
  ): Promise<void> {
    await this.flags.resolve(ctx, id);
  }
}
