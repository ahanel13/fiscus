// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  setCategorySplitSchema,
  setDefaultSplitSchema,
  type SplitPolicies,
  type SplitPolicy,
} from '@fiscus/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { SplitPoliciesService } from './split-policies.service.js';

/**
 * Split rules for shared costs (SHR-01/02): everyone reads them; owners and members change them.
 * Split by income needs members' consent first (#110), so it isn't accepted here yet.
 */
@Controller('api/v1/households/:householdId/split-rules')
@UseGuards(HouseholdGuard)
export class SplitPoliciesController {
  constructor(private readonly policies: SplitPoliciesService) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: SplitPolicies }> {
    return { data: await this.policies.list(ctx) };
  }

  @Put('default')
  @HouseholdRoles('owner', 'member')
  async setDefault(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(setDefaultSplitSchema)) body: z.infer<typeof setDefaultSplitSchema>,
  ): Promise<{ data: SplitPolicy }> {
    return { data: await this.policies.set(ctx, null, body.rule, body.effectiveFrom) };
  }

  @Put('categories/:categoryId')
  @HouseholdRoles('owner', 'member')
  async setCategory(
    @Household() ctx: HouseholdContext,
    @Param('categoryId', UuidPipe) categoryId: string,
    @Body(new ZodPipe(setCategorySplitSchema)) body: z.infer<typeof setCategorySplitSchema>,
  ): Promise<{ data: SplitPolicy }> {
    return { data: await this.policies.set(ctx, categoryId, body.rule, body.effectiveFrom) };
  }

  /** Cancels a change that hasn't started yet. */
  @Delete(':splitRuleId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async cancel(
    @Household() ctx: HouseholdContext,
    @Param('splitRuleId', UuidPipe) id: string,
  ): Promise<void> {
    await this.policies.cancel(ctx, id);
  }
}
