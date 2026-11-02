// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createRecurringSchema,
  recurringDraftSchema,
  type RecurringPreview,
  type RecurringSeries,
  type RecurringSuggestion,
  updateRecurringSchema,
} from '@fiscus/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { RecurringService } from './recurring.service.js';

const suggestQuery = z.object({ transactionId: z.uuid() });

/**
 * Recurring series (REC-01–03): everyone reads the series on accounts whose transactions they
 * see; owners and members with owner or full access to its account make and change them.
 */
@Controller('api/v1/households/:householdId/recurring')
@UseGuards(HouseholdGuard)
export class RecurringController {
  constructor(private readonly recurring: RecurringService) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: RecurringSeries[] }> {
    return { data: await this.recurring.list(ctx) };
  }

  /** A starting point for Make recurring, from one transaction. */
  @Get('suggest')
  @HouseholdRoles('owner', 'member')
  async suggest(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(suggestQuery)) query: z.infer<typeof suggestQuery>,
  ): Promise<{ data: RecurringSuggestion }> {
    return { data: await this.recurring.suggest(ctx, query.transactionId) };
  }

  /** What a series (not saved yet) would match, and when it's next due. */
  @Post('preview')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async preview(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(recurringDraftSchema)) body: z.infer<typeof recurringDraftSchema>,
  ): Promise<{ data: RecurringPreview }> {
    return { data: await this.recurring.preview(ctx, body) };
  }

  @Post()
  @HouseholdRoles('owner', 'member')
  async create(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createRecurringSchema)) body: z.infer<typeof createRecurringSchema>,
  ): Promise<{ data: RecurringSeries }> {
    return { data: await this.recurring.create(ctx, body) };
  }

  @Patch(':seriesId')
  @HouseholdRoles('owner', 'member')
  async update(
    @Household() ctx: HouseholdContext,
    @Param('seriesId', UuidPipe) id: string,
    @Body(new ZodPipe(updateRecurringSchema)) body: z.infer<typeof updateRecurringSchema>,
  ): Promise<{ data: RecurringSeries }> {
    return { data: await this.recurring.update(ctx, id, body) };
  }

  @Delete(':seriesId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async remove(
    @Household() ctx: HouseholdContext,
    @Param('seriesId', UuidPipe) id: string,
  ): Promise<void> {
    await this.recurring.remove(ctx, id);
  }
}
