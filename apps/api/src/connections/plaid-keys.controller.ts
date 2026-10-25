// SPDX-License-Identifier: AGPL-3.0-or-later
import { type HouseholdPlaidKeys, type PlaidKeysInput, plaidKeysSchema } from '@fiscus/shared';
import { Body, Controller, Delete, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { RequireRecentAuth } from '../auth/decorators.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { PlaidKeysService } from './plaid-keys.service.js';

/**
 * A household's own Plaid keys (#83, ADR 0008 §Credentials 2): household owners only (HH-08).
 * The secret is write-only; changing or removing keys needs a recent password check.
 */
@Controller('api/v1/households/:householdId/plaid-keys')
@UseGuards(HouseholdGuard)
@HouseholdRoles('owner')
export class PlaidKeysController {
  constructor(private readonly keys: PlaidKeysService) {}

  /** Whether they're allowed, the keys as far as they're shown, and which banks use which. */
  @Get()
  async get(@Household() ctx: HouseholdContext): Promise<{ data: HouseholdPlaidKeys }> {
    return { data: await this.keys.get(ctx) };
  }

  @Put()
  @RequireRecentAuth()
  async put(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(plaidKeysSchema)) body: PlaidKeysInput,
  ): Promise<{ data: HouseholdPlaidKeys }> {
    return { data: await this.keys.put(ctx, body) };
  }

  @Delete()
  @RequireRecentAuth()
  @HttpCode(204)
  async remove(@Household() ctx: HouseholdContext): Promise<void> {
    await this.keys.remove(ctx);
  }
}
