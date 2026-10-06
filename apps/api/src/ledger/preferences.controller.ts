// SPDX-License-Identifier: AGPL-3.0-or-later
import { memberPreferences } from '@fiscus/db';
import { preferenceKeySchema, setPreferenceSchema } from '@fiscus/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { problems } from '../common/problem.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
} from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

/**
 * A member's own preferences in a household (HH-10, ADR 0011 §5), such as the default range per
 * page. Only they can read or change them; the activity is recorded but not shown to others.
 */
@Controller('api/v1/households/:householdId/preferences')
@UseGuards(HouseholdGuard)
export class PreferencesController {
  constructor(private readonly scope: HouseholdScope) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: Record<string, unknown> }> {
    const rows = await this.scope.run(ctx, (tx) => tx.select().from(memberPreferences));
    return { data: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }

  @Put(':key')
  @HttpCode(204)
  async set(
    @Household() ctx: HouseholdContext,
    @Param('key', new ZodPipe(preferenceKeySchema)) key: string,
    @Body(new ZodPipe(setPreferenceSchema)) body: z.infer<typeof setPreferenceSchema>,
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      await tx
        .insert(memberPreferences)
        .values({ householdId: ctx.householdId, memberId: ctx.memberId, key, value: body.value })
        .onConflictDoUpdate({
          target: [memberPreferences.memberId, memberPreferences.key],
          set: { value: body.value, updatedAt: new Date() },
        });
      await activity.record({
        action: 'preference.set',
        metadata: { key },
        visibleToHousehold: false,
      });
    });
  }

  @Delete(':key')
  @HttpCode(204)
  async remove(
    @Household() ctx: HouseholdContext,
    @Param('key', new ZodPipe(preferenceKeySchema)) key: string,
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const removed = await tx
        .delete(memberPreferences)
        .where(eq(memberPreferences.key, key))
        .returning({ key: memberPreferences.key });
      if (removed.length === 0) throw problems.notFound();
      await activity.record({
        action: 'preference.deleted',
        metadata: { key },
        visibleToHousehold: false,
      });
    });
  }
}
