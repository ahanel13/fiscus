// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Allowance, setAllowanceSchema } from '@fiscus/shared';
import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
} from '../households/household-context.js';
import { AllowancesService } from './allowances.service.js';

/** Allowances (#114, D15): everyone reads them (BUD-07); owners and members set them (BUD-08). */
@Controller('api/v1/households/:householdId/allowances')
@UseGuards(HouseholdGuard)
export class AllowancesController {
  constructor(private readonly allowances: AllowancesService) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: Allowance[] }> {
    return { data: await this.allowances.list(ctx) };
  }

  /** A member's allowance from a month on; zero stops it. */
  @Put(':memberId')
  async set(
    @Household() ctx: HouseholdContext,
    @Param('memberId', UuidPipe) memberId: string,
    @Body(new ZodPipe(setAllowanceSchema)) body: z.infer<typeof setAllowanceSchema>,
  ): Promise<{ data: Allowance[] }> {
    return { data: await this.allowances.set(ctx, memberId, body) };
  }
}
