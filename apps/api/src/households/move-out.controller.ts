// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type MemberMove,
  type MoveOutPreview,
  type StartMoveOut,
  startMoveOutSchema,
} from '@fiscus/shared';
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { Auth, RequireRecentAuth } from '../auth/decorators.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { Household, type HouseholdContext, HouseholdGuard } from './household-context.js';
import { MoveOutService } from './move-out.service.js';

/**
 * HH-20 (#253, ADR 0012 step 3): moving out into a household of your own, with your history.
 * Anyone with a login can, whatever their role: nobody can stop it.
 */
@Controller('api/v1/households/:householdId')
@UseGuards(HouseholdGuard)
export class MoveOutController {
  constructor(private readonly moveOut: MoveOutService) {}

  /** What would move, stay and be copied. */
  @Get('move-out/preview')
  async preview(@Household() ctx: HouseholdContext): Promise<{ data: MoveOutPreview }> {
    return { data: await this.moveOut.preview(ctx) };
  }

  /** Starts it, after a recent sign-in: the new household, then the worker moves your data. */
  @Post('move-out')
  @RequireRecentAuth()
  async start(
    @Household() ctx: HouseholdContext,
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(startMoveOutSchema)) body: StartMoveOut,
  ): Promise<{ data: { householdId: string; moveId: string } }> {
    return { data: await this.moveOut.start(ctx, auth.user, body) };
  }

  /** In the new household: how the move into it is going. */
  @Get('move-in')
  async moveIn(@Household() ctx: HouseholdContext): Promise<{ data: MemberMove }> {
    return { data: await this.moveOut.moveIn(ctx) };
  }
}
