// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createRuleSchema,
  reorderRulesSchema,
  type Rule,
  ruleActionsSchema,
  ruleConditionsSchema,
  type RulePreview,
  ruleScopeSchema,
  updateRuleSchema,
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
import { RulesService } from './rules.service.js';

const draftSchema = z.object({
  scope: ruleScopeSchema.default('household'),
  conditions: ruleConditionsSchema,
  actions: ruleActionsSchema,
});

/**
 * Rules (RULE-01–04/06): everyone reads the household's and their own; owners and members change
 * and apply them. Row-level security keeps each member's rules to them.
 */
@Controller('api/v1/households/:householdId/rules')
@UseGuards(HouseholdGuard)
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: Rule[] }> {
    return { data: await this.rules.list(ctx) };
  }

  @Post()
  @HouseholdRoles('owner', 'member')
  async create(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createRuleSchema)) body: z.infer<typeof createRuleSchema>,
  ): Promise<{ data: Rule }> {
    return { data: await this.rules.create(ctx, body) };
  }

  /** What a rule (saved or not) would change in the transactions you can see. */
  @Post('preview')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async preview(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(draftSchema)) body: z.infer<typeof draftSchema>,
  ): Promise<{ data: RulePreview }> {
    return { data: await this.rules.preview(ctx, body) };
  }

  @Put('order')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async reorder(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(reorderRulesSchema)) body: z.infer<typeof reorderRulesSchema>,
  ): Promise<void> {
    await this.rules.reorder(ctx, body);
  }

  @Patch(':ruleId')
  @HouseholdRoles('owner', 'member')
  async update(
    @Household() ctx: HouseholdContext,
    @Param('ruleId', UuidPipe) id: string,
    @Body(new ZodPipe(updateRuleSchema)) body: z.infer<typeof updateRuleSchema>,
  ): Promise<{ data: Rule }> {
    return { data: await this.rules.update(ctx, id, body) };
  }

  @Delete(':ruleId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async remove(
    @Household() ctx: HouseholdContext,
    @Param('ruleId', UuidPipe) id: string,
  ): Promise<void> {
    await this.rules.remove(ctx, id);
  }

  /** Applies a rule to existing transactions you can see (RULE-06). */
  @Post(':ruleId/apply')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async apply(
    @Household() ctx: HouseholdContext,
    @Param('ruleId', UuidPipe) id: string,
  ): Promise<{ data: { changed: number } }> {
    return { data: await this.rules.apply(ctx, id) };
  }
}
