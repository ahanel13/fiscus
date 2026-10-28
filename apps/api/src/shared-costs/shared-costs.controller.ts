// SPDX-License-Identifier: AGPL-3.0-or-later
import { budgetMonthSchema, type SharedCosts } from '@fiscus/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
} from '../households/household-context.js';
import { SharedCostsService } from './shared-costs.service.js';

/** Who owes whom (#111): your balance with each person, and a month's shared expenses. */
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
}
