// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OwnershipClaim, OwnershipClaimState } from '@fiscus/shared';
import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { RequireRecentAuth } from '../auth/decorators.js';
import { UuidPipe } from '../common/uuid-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from './household-context.js';
import { OwnershipClaimsService } from './ownership-claims.service.js';

/**
 * HH-17 (#267, ADR 0012 §Departures item 7): claiming ownership when no owner has used Fiscus
 * for 30 days. Owners are told and have 30 days to reject it; any owner using Fiscus ends it.
 */
@Controller('api/v1/households/:householdId/ownership-claims')
@UseGuards(HouseholdGuard)
export class OwnershipClaimsController {
  constructor(private readonly claims: OwnershipClaimsService) {}

  /** Everyone sees an open claim; only members learn whether they could start one. */
  @Get('current')
  async current(@Household() ctx: HouseholdContext): Promise<{ data: OwnershipClaimState }> {
    return { data: await this.claims.current(ctx) };
  }

  /** A member claims. Owners already are, and viewers can't: both 403. */
  @Post()
  @HouseholdRoles('member')
  @RequireRecentAuth()
  async start(@Household() ctx: HouseholdContext): Promise<{ data: OwnershipClaim }> {
    return { data: await this.claims.start(ctx) };
  }

  /** Any owner rejects it. */
  @Post(':claimId/reject')
  @HouseholdRoles('owner')
  @HttpCode(204)
  async reject(
    @Household() ctx: HouseholdContext,
    @Param('claimId', UuidPipe) claimId: string,
  ): Promise<void> {
    await this.claims.reject(ctx, claimId);
  }

  /** The claimant withdraws it, whatever their role is now. */
  @Post(':claimId/withdraw')
  @HttpCode(204)
  async withdraw(
    @Household() ctx: HouseholdContext,
    @Param('claimId', UuidPipe) claimId: string,
  ): Promise<void> {
    await this.claims.withdraw(ctx, claimId);
  }
}
