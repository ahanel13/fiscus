// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type IncomeSplit,
  type IncomeSplitConsent,
  incomeSplitConsentSchema,
} from '@fiscus/shared';
import { Body, Controller, Delete, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { IncomeSplitService } from './income-split.service.js';

/**
 * A split by income (F4, #110): who has agreed and the split it makes, for everyone (SHR-06);
 * agreeing, changing the income it uses, or withdrawing, for yourself (SHR-05).
 */
@Controller('api/v1/households/:householdId/income-split')
@UseGuards(HouseholdGuard)
export class IncomeSplitController {
  constructor(private readonly income: IncomeSplitService) {}

  @Get()
  async get(@Household() ctx: HouseholdContext): Promise<{ data: IncomeSplit }> {
    return { data: await this.income.get(ctx) };
  }

  @Put('consent')
  @HouseholdRoles('owner', 'member')
  async consent(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(incomeSplitConsentSchema)) body: IncomeSplitConsent,
  ): Promise<{ data: IncomeSplit }> {
    return { data: await this.income.consent(ctx, body) };
  }

  @Delete('consent')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async withdraw(@Household() ctx: HouseholdContext): Promise<void> {
    await this.income.withdraw(ctx);
  }
}
