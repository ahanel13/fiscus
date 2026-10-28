// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  budgetMonthSchema,
  recordSettlementSchema,
  type Settlement,
  type SettlementCandidate,
  type SharedCosts,
} from '@fiscus/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { SharedCostsService } from './shared-costs.service.js';

/**
 * Who owes whom (#111): your balance with each person, and a month's shared expenses. Settling
 * up (#112): one of the two people records it, as a transfer in Fiscus, paid another way, or an
 * adjustment.
 */
@Controller('api/v1/households/:householdId/shared-costs')
@UseGuards(HouseholdGuard)
export class SharedCostsController {
  constructor(private readonly costs: SharedCostsService) {}

  @Get()
  async get(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(z.object({ month: budgetMonthSchema }))) q: { month: string },
  ): Promise<{ data: SharedCosts }> {
    return { data: await this.costs.get(ctx, q.month) };
  }

  /** SHR-04: one of the two people records a settle-up between them. */
  @Post('settlements')
  @HouseholdRoles('owner', 'member')
  async record(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(recordSettlementSchema)) body: z.infer<typeof recordSettlementSchema>,
  ): Promise<{ data: Settlement }> {
    return { data: await this.costs.record(ctx, body) };
  }

  @Delete('settlements/:settlementId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async remove(
    @Household() ctx: HouseholdContext,
    @Param('settlementId', UuidPipe) id: string,
  ): Promise<void> {
    await this.costs.remove(ctx, id);
  }

  /** Transfers that could settle the balance with someone, closest first (D20). */
  @Get('settlement-candidates')
  async candidates(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(z.object({ memberId: z.uuid(), balanceMinor: z.coerce.number().int() })))
    q: { memberId: string; balanceMinor: number },
  ): Promise<{ data: SettlementCandidate[] }> {
    return { data: await this.costs.candidates(ctx, q.memberId, q.balanceMinor) };
  }
}
