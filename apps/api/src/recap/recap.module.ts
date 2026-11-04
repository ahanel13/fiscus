// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildWeeklyRecap, householdRanges, lastWeekStart } from '@fiscus/ledger';
import type { WeeklyRecap } from '@fiscus/shared';
import { Controller, Get, Injectable, Module, UseGuards } from '@nestjs/common';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
} from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import { HouseholdsModule } from '../households/households.module.js';

/**
 * Your weekly recap (#128; bills walkthrough §8, D21): last week, as the household counts weeks,
 * built in your own context, so it's only what you can see (SYS-02). Worked out when it's read.
 */
@Injectable()
export class RecapService {
  constructor(private readonly scope: HouseholdScope) {}

  async latest(ctx: HouseholdContext): Promise<WeeklyRecap> {
    return this.scope.run(ctx, async (tx) => {
      const { settings, today } = await householdRanges(tx, ctx.householdId);
      return buildWeeklyRecap(tx, {
        memberId: ctx.memberId,
        weekStart: lastWeekStart(today, settings.weekStart),
        today,
      });
    });
  }
}

@Controller('api/v1/households/:householdId/recap')
@UseGuards(HouseholdGuard)
export class RecapController {
  constructor(private readonly recap: RecapService) {}

  /** Your recap of last week, with what's coming up from today. Everyone has their own. */
  @Get()
  async latest(@Household() ctx: HouseholdContext): Promise<{ data: WeeklyRecap }> {
    return { data: await this.recap.latest(ctx) };
  }
}

@Module({
  imports: [HouseholdsModule],
  controllers: [RecapController],
  providers: [RecapService],
})
export class RecapModule {}
