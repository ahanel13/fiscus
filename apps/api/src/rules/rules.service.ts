// SPDX-License-Identifier: AGPL-3.0-or-later
import { householdMembers, rules, transactions } from '@fiscus/db';
import type {
  createRuleSchema,
  reorderRulesSchema,
  Rule,
  RuleActions,
  RuleConditions,
  RulePreview,
  updateRuleSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import type { z } from 'zod';
import { problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import { accessLevels } from '../visibility/visibility-scope.js';
import { type EngineRule, runRules } from './engine.js';

type CreateInput = z.infer<typeof createRuleSchema>;
type UpdateInput = z.infer<typeof updateRuleSchema>;
type Draft = { conditions: RuleConditions; actions: RuleActions };

/**
 * Household-wide rules (RULE-01/03/05/06/07). Everyone reads them; owners and members change
 * them. A rule acts with its author's access, and editing one makes you its author.
 */
@Injectable()
export class RulesService {
  constructor(private readonly scope: HouseholdScope) {}

  async list(ctx: HouseholdContext): Promise<Rule[]> {
    return this.scope.run(ctx, async (tx) => {
      const rows = await tx
        .select({ rule: rules, leftAt: householdMembers.leftAt })
        .from(rules)
        .leftJoin(householdMembers, eq(householdMembers.id, rules.authorMemberId))
        .orderBy(asc(rules.position), asc(rules.createdAt));
      return rows.map(({ rule, leftAt }) => toRule(rule, leftAt !== null));
    });
  }

  async create(ctx: HouseholdContext, input: CreateInput): Promise<Rule> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [{ last }] = (await tx.select({ last: max(rules.position) }).from(rules)) as [
        { last: number | null },
      ];
      const [row] = await tx
        .insert(rules)
        .values({
          householdId: ctx.householdId,
          name: input.name ?? null,
          position: (last ?? 0) + 1,
          enabled: input.enabled ?? true,
          conditions: input.conditions,
          actions: input.actions,
          authorMemberId: ctx.memberId,
        })
        .returning();
      await activity.record({
        action: 'rule.created',
        targetType: 'rule',
        targetId: row!.id,
        changes: {
          after: { name: input.name ?? null, conditions: input.conditions, actions: input.actions },
        },
      });
      return toRule(row!, false);
    });
  }

  /** Editing a rule makes you its author: from now on it acts with your access (RULE-05). */
  async update(ctx: HouseholdContext, id: string, patch: UpdateInput): Promise<Rule> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [before] = await tx.select().from(rules).where(eq(rules.id, id));
      if (!before) throw problems.notFound();
      const [row] = await tx
        .update(rules)
        .set({
          ...patch,
          authorMemberId: ctx.memberId,
          version: before.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(rules.id, id))
        .returning();
      await activity.record({
        action: 'rule.updated',
        targetType: 'rule',
        targetId: id,
        metadata: { fields: Object.keys(patch), author: ctx.memberId },
        changes: {
          before: Object.fromEntries(
            Object.keys(patch).map((k) => [k, before[k as keyof typeof before]]),
          ),
          after: patch,
        },
      });
      return toRule(row!, false);
    });
  }

  async remove(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [row] = await tx.delete(rules).where(eq(rules.id, id)).returning({ id: rules.id });
      if (!row) throw problems.notFound();
      await activity.record({ action: 'rule.deleted', targetType: 'rule', targetId: id });
    });
  }

  /** Puts rules in the given order; any not listed keep their order after these. */
  async reorder(ctx: HouseholdContext, input: z.infer<typeof reorderRulesSchema>): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const all = await tx
        .select({ id: rules.id })
        .from(rules)
        .orderBy(asc(rules.position), asc(rules.createdAt));
      const known = new Set(all.map((r) => r.id));
      if (input.ids.some((id) => !known.has(id))) throw problems.notFound();
      const order = [...input.ids, ...all.map((r) => r.id).filter((id) => !input.ids.includes(id))];
      for (const [i, id] of order.entries()) {
        await tx
          .update(rules)
          .set({ position: i + 1 })
          .where(eq(rules.id, id));
      }
      await activity.record({ action: 'rule.reordered', targetType: 'rule', metadata: { order } });
    });
  }

  /**
   * RULE-06: what a rule would change in the transactions you can see, as if you were its author.
   * Changes nothing.
   */
  async preview(ctx: HouseholdContext, draft: Draft): Promise<RulePreview> {
    return this.scope.run(ctx, async (tx) => {
      const changes = await runRules(
        tx,
        ctx,
        await this.#visibleRows(tx),
        [{ id: 'draft', ...draft, authorMemberId: ctx.memberId }],
        ctx.role === 'viewer' ? new Map() : await accessLevels(tx),
        false,
      );
      return { total: changes.length, changes: changes.slice(0, 200) };
    });
  }

  /** RULE-06: applies a saved rule to the transactions you can see, within your reach and its author's. */
  async apply(ctx: HouseholdContext, id: string): Promise<{ changed: number }> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [row] = await tx
        .select({ rule: rules, leftAt: householdMembers.leftAt })
        .from(rules)
        .leftJoin(householdMembers, eq(householdMembers.id, rules.authorMemberId))
        .where(eq(rules.id, id));
      if (!row) throw problems.notFound();
      if (row.leftAt) return { changed: 0 }; // RULE-07: edit it to adopt it first
      const rule: EngineRule = {
        id: row.rule.id,
        conditions: row.rule.conditions as RuleConditions,
        actions: row.rule.actions as RuleActions,
        authorMemberId: row.rule.authorMemberId,
      };
      const changes = await runRules(
        tx,
        ctx,
        await this.#visibleRows(tx),
        [rule],
        await accessLevels(tx),
        true,
      );
      if (changes.length) {
        await activity.record({
          action: 'rule.applied',
          targetType: 'rule',
          targetId: id,
          metadata: { transactions: changes.length },
        });
      }
      return { changed: changes.length };
    });
  }

  /** Every transaction the caller can see (row-level security), not deleted. */
  #visibleRows(tx: Parameters<Parameters<HouseholdScope['run']>[1]>[0]) {
    return tx
      .select()
      .from(transactions)
      .where(and(isNull(transactions.deletedAt), eq(transactions.hasSplits, false)));
  }
}

const toRule = (r: typeof rules.$inferSelect, authorLeft: boolean): Rule => ({
  id: r.id,
  name: r.name,
  position: r.position,
  enabled: r.enabled,
  conditions: r.conditions as RuleConditions,
  actions: r.actions as RuleActions,
  authorMemberId: r.authorMemberId,
  authorLeft,
  version: r.version,
  updatedAt: r.updatedAt.toISOString(),
});
