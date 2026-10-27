// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BudgetMonth,
  budgetMonthSchema,
  budgetScopeSchema,
  type BudgetSuggestion,
  type BudgetSummary,
  createBudgetSchema,
  setBudgetAmountSchema,
  setBudgetCategorySchema,
} from '@fiscus/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
} from '../households/household-context.js';
import { BudgetsService } from './budgets.service.js';

/**
 * Budgets (BUD-01–04): the household's, and your own. Who may change which is checked per budget
 * (BUD-03/04); whether you can see one at all is row-level security's (BUD-02).
 */
@Controller('api/v1/households/:householdId/budgets')
@UseGuards(HouseholdGuard)
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: BudgetSummary[] }> {
    return { data: await this.budgets.list(ctx) };
  }

  @Get('suggestion')
  async suggestion(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(z.object({ scope: budgetScopeSchema.optional() })))
    q: { scope?: z.infer<typeof budgetScopeSchema> },
  ): Promise<{ data: BudgetSuggestion }> {
    return { data: await this.budgets.suggestion(ctx, q.scope) };
  }

  @Post()
  async create(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createBudgetSchema)) body: z.infer<typeof createBudgetSchema>,
  ): Promise<{ data: BudgetSummary }> {
    return { data: await this.budgets.create(ctx, body) };
  }

  @Get(':budgetId/months/:month')
  async month(
    @Household() ctx: HouseholdContext,
    @Param('budgetId', UuidPipe) budgetId: string,
    @Param('month', new ZodPipe(budgetMonthSchema)) month: string,
  ): Promise<{ data: BudgetMonth }> {
    return { data: await this.budgets.month(ctx, budgetId, month) };
  }

  @Put(':budgetId/months/:month/amounts/:categoryId')
  @HttpCode(204)
  async setAmount(
    @Household() ctx: HouseholdContext,
    @Param('budgetId', UuidPipe) budgetId: string,
    @Param('month', new ZodPipe(budgetMonthSchema)) month: string,
    @Param('categoryId', UuidPipe) categoryId: string,
    @Body(new ZodPipe(setBudgetAmountSchema)) body: z.infer<typeof setBudgetAmountSchema>,
  ): Promise<void> {
    await this.budgets.setAmount(ctx, budgetId, month, categoryId, body.amountMinor);
  }

  @Put(':budgetId/categories/:categoryId')
  @HttpCode(204)
  async setCategory(
    @Household() ctx: HouseholdContext,
    @Param('budgetId', UuidPipe) budgetId: string,
    @Param('categoryId', UuidPipe) categoryId: string,
    @Body(new ZodPipe(setBudgetCategorySchema)) body: z.infer<typeof setBudgetCategorySchema>,
  ): Promise<void> {
    await this.budgets.setCategory(ctx, budgetId, categoryId, body.rollover);
  }
}
