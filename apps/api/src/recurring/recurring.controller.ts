// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createRecurringSchema,
  markOccurrenceSchema,
  recurringDraftSchema,
  type RecurringMonth,
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
  Put,
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
const monthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
const dueParam = z.iso.date();

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

  /** A month of what's due: paid, late, due or skipped, with card statements (§4, §5). */
  @Get('month')
  async month(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(monthQuery)) query: z.infer<typeof monthQuery>,
  ): Promise<{ data: RecurringMonth }> {
    return { data: await this.recurring.month(ctx, query.month) };
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

  /** Paid (by a transaction, or another way) or skipped, for one date it was due (D12). */
  @Put(':seriesId/occurrences/:due')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async mark(
    @Household() ctx: HouseholdContext,
    @Param('seriesId', UuidPipe) id: string,
    @Param('due', new ZodPipe(dueParam)) due: string,
    @Body(new ZodPipe(markOccurrenceSchema)) body: z.infer<typeof markOccurrenceSchema>,
  ): Promise<void> {
    await this.recurring.mark(ctx, id, due, body);
  }

  @Delete(':seriesId/occurrences/:due')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async unmark(
    @Household() ctx: HouseholdContext,
    @Param('seriesId', UuidPipe) id: string,
    @Param('due', new ZodPipe(dueParam)) due: string,
  ): Promise<void> {
    await this.recurring.unmark(ctx, id, due);
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
