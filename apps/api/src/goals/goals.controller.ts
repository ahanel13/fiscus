// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseIfMatch } from '@fiscus/domain';
import {
  createGoalSchema,
  giveWaySchema,
  type Goal,
  goalClaimSchema,
  goalImageSchema,
  type GoalsOverview,
  orderGoalsSchema,
  updateGoalSchema,
} from '@fiscus/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Problem } from '../common/problem.js';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
} from '../households/household-context.js';
import { GoalsService } from './goals.service.js';

const archiveSchema = z.object({ archived: z.boolean() }).strict();

/**
 * Goals (GOAL-01–07): the household's, and your own. Who may change a goal is checked per goal
 * (GOAL-03/04); who may claim an account, by the database (GOAL-05); whether you see a goal at
 * all, by row-level security (GOAL-02).
 */
@Controller('api/v1/households/:householdId/goals')
@UseGuards(HouseholdGuard)
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  async overview(@Household() ctx: HouseholdContext): Promise<{ data: GoalsOverview }> {
    return { data: await this.goals.overview(ctx) };
  }

  @Post()
  async create(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createGoalSchema)) body: z.infer<typeof createGoalSchema>,
  ): Promise<{ data: Goal }> {
    return { data: await this.goals.create(ctx, body) };
  }

  /** Priority, highest first (G19). */
  @Put('order')
  @HttpCode(204)
  async order(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(orderGoalsSchema)) body: z.infer<typeof orderGoalsSchema>,
  ): Promise<void> {
    await this.goals.order(ctx, body.ids);
  }

  /** Which goal gives way to a shortfall (G3, G19). */
  @Post('give-way')
  @HttpCode(204)
  async giveWay(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(giveWaySchema)) body: z.infer<typeof giveWaySchema>,
  ): Promise<void> {
    await this.goals.giveWay(ctx, body.accountId, body.take);
  }

  /** Requires If-Match: first save wins. */
  @Patch(':goalId')
  async update(
    @Household() ctx: HouseholdContext,
    @Param('goalId', UuidPipe) goalId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateGoalSchema)) body: z.infer<typeof updateGoalSchema>,
  ): Promise<{ data: Goal }> {
    const version = parseIfMatch(ifMatch);
    if (version === undefined) {
      throw new Problem(428, 'if_match_required', 'Send If-Match with the version you edited');
    }
    return { data: await this.goals.update(ctx, goalId, body, version) };
  }

  @Delete(':goalId')
  @HttpCode(204)
  async remove(
    @Household() ctx: HouseholdContext,
    @Param('goalId', UuidPipe) goalId: string,
  ): Promise<void> {
    await this.goals.remove(ctx, goalId);
  }

  /** Its photo, for whoever sees the goal (GOAL-01/02), from Fiscus's own origin. */
  @Get(':goalId/image')
  async image(
    @Household() ctx: HouseholdContext,
    @Param('goalId', UuidPipe) goalId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const image = await this.goals.image(ctx, goalId);
    void reply
      .header('content-type', image.type)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff');
    return image.data;
  }

  @Put(':goalId/image')
  async setImage(
    @Household() ctx: HouseholdContext,
    @Param('goalId', UuidPipe) goalId: string,
    @Body(new ZodPipe(goalImageSchema)) body: z.infer<typeof goalImageSchema>,
  ): Promise<{ data: Goal }> {
    return { data: await this.goals.setImage(ctx, goalId, body) };
  }

  @Delete(':goalId/image')
  async removeImage(
    @Household() ctx: HouseholdContext,
    @Param('goalId', UuidPipe) goalId: string,
  ): Promise<{ data: Goal }> {
    return { data: await this.goals.setImage(ctx, goalId, null) };
  }

  /** Puts it away, or brings it back. */
  @Put(':goalId/archived')
  async archive(
    @Household() ctx: HouseholdContext,
    @Param('goalId', UuidPipe) goalId: string,
    @Body(new ZodPipe(archiveSchema)) body: z.infer<typeof archiveSchema>,
  ): Promise<{ data: Goal }> {
    return { data: await this.goals.archive(ctx, goalId, body.archived) };
  }

  @Put(':goalId/claims/:accountId')
  async claim(
    @Household() ctx: HouseholdContext,
    @Param('goalId', UuidPipe) goalId: string,
    @Param('accountId', UuidPipe) accountId: string,
    @Body(new ZodPipe(goalClaimSchema)) body: z.infer<typeof goalClaimSchema>,
  ): Promise<{ data: Goal }> {
    return { data: await this.goals.claim(ctx, goalId, accountId, body) };
  }

  @Delete(':goalId/claims/:accountId')
  async release(
    @Household() ctx: HouseholdContext,
    @Param('goalId', UuidPipe) goalId: string,
    @Param('accountId', UuidPipe) accountId: string,
  ): Promise<{ data: Goal }> {
    return { data: await this.goals.release(ctx, goalId, accountId) };
  }
}
