// SPDX-License-Identifier: AGPL-3.0-or-later
import { type FundingTargets, setFundingTargetSchema, type SetFundingTarget } from '@fiscus/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { FundingTargetsService } from './funding-targets.service.js';

/**
 * Joint-account funding targets (#113): SHR-07 reads them, with how each is going; SHR-08 sets or
 * removes one, for an owner of a joint account you own.
 */
@Controller('api/v1/households/:householdId/funding-targets')
@UseGuards(HouseholdGuard)
export class FundingTargetsController {
  constructor(private readonly targets: FundingTargetsService) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: FundingTargets }> {
    return { data: await this.targets.list(ctx) };
  }

  @Put(':accountId/:memberId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async set(
    @Household() ctx: HouseholdContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Param('memberId', UuidPipe) memberId: string,
    @Body(new ZodPipe(setFundingTargetSchema)) body: SetFundingTarget,
  ): Promise<void> {
    await this.targets.set(ctx, accountId, memberId, body);
  }

  @Delete(':accountId/:memberId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async remove(
    @Household() ctx: HouseholdContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Param('memberId', UuidPipe) memberId: string,
  ): Promise<void> {
    await this.targets.remove(ctx, accountId, memberId);
  }
}
