// SPDX-License-Identifier: AGPL-3.0-or-later
import { accounts, type Executor, householdMembers, rules, transactions } from '@fiscus/db';
import { accessLevels, type EngineRule, runRules } from '@fiscus/ledger';
import type {
  createRuleSchema,
  reorderRulesSchema,
  Rule,
  RuleActions,
  RuleConditions,
  RulePreview,
  RuleScope,
  updateRuleSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, max, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type CreateInput = z.infer<typeof createRuleSchema>;
type UpdateInput = z.infer<typeof updateRuleSchema>;
type Draft = { scope: RuleScope; conditions: RuleConditions; actions: RuleActions };

/**
 * Rules (RULE-01–07): the household's, which everyone reads and owners and members change, and
 * each member's own (#58), which only they see (row-level security, 0039). A rule acts with its
 * author's access, and editing a household rule makes you its author. Activity about your own
 * rules is yours alone, like the rules.
 */
@Injectable()
export class RulesService {
  constructor(private readonly scope: HouseholdScope) {}

  /** The household's rules, then yours, each in order. */
  async list(ctx: HouseholdContext): Promise<Rule[]> {
    return this.scope.run(ctx, async (tx) => {
      const rows = await tx
        .select({ rule: rules, leftAt: householdMembers.leftAt })
        .from(rules)
        .leftJoin(householdMembers, eq(householdMembers.id, rules.authorMemberId))
        .orderBy(sql`${rules.memberId} IS NOT NULL`, asc(rules.position), asc(rules.createdAt));
      return rows.map(({ rule, leftAt }) => toRule(rule, leftAt !== null));
    });
  }

  async create(ctx: HouseholdContext, input: CreateInput): Promise<Rule> {
    return this.scope.run(ctx, async (tx, activity) => {
      await this.#checkActions(tx, input.actions);
      const memberId = input.scope === 'mine' ? ctx.memberId : null;
      const [{ last }] = (await tx
        .select({ last: max(rules.position) })
        .from(rules)
        .where(inScope(memberId))) as [{ last: number | null }];
      const [row] = await tx
        .insert(rules)
        .values({
          householdId: ctx.householdId,
          memberId,
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
        metadata: { scope: input.scope },
        visibleToHousehold: memberId === null,
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
      // You become its author, so its transfer account must be one you own.
      await this.#checkActions(tx, patch.actions ?? (before.actions as RuleActions));
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
        visibleToHousehold: before.memberId === null,
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
      const [row] = await tx
        .delete(rules)
        .where(eq(rules.id, id))
        .returning({ id: rules.id, memberId: rules.memberId });
      if (!row) throw problems.notFound();
      await activity.record({
        action: 'rule.deleted',
        targetType: 'rule',
        targetId: id,
        visibleToHousehold: row.memberId === null,
      });
    });
  }

  /**
   * Puts the household's rules, or yours, in the given order; any of the same ones not listed keep
   * their order after these. The two are ordered apart, since yours always run after the
   * household's.
   */
  async reorder(ctx: HouseholdContext, input: z.infer<typeof reorderRulesSchema>): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const visible = await tx
        .select({ id: rules.id, memberId: rules.memberId })
        .from(rules)
        .orderBy(asc(rules.position), asc(rules.createdAt));
      const scopes = new Map(visible.map((r) => [r.id, r.memberId]));
      if (input.ids.some((id) => !scopes.has(id))) throw problems.notFound();
      const memberId = scopes.get(input.ids[0]!)!;
      if (input.ids.some((id) => scopes.get(id) !== memberId)) {
        throw new Problem(
          422,
          'mixed_scopes',
          'Household rules and your own are ordered separately',
          'Reorder one list at a time.',
        );
      }
      const all = visible.filter((r) => r.memberId === memberId).map((r) => r.id);
      const order = [...input.ids, ...all.filter((id) => !input.ids.includes(id))];
      for (const [i, id] of order.entries()) {
        await tx
          .update(rules)
          .set({ position: i + 1 })
          .where(eq(rules.id, id));
      }
      await activity.record({
        action: 'rule.reordered',
        targetType: 'rule',
        metadata: { order, scope: memberId === null ? 'household' : 'mine' },
        visibleToHousehold: memberId === null,
      });
    });
  }

  /**
   * RULE-06: what a rule would change in the transactions you can see, as if you were its author.
   * One of your own would change only the accounts you own. Changes nothing.
   */
  async preview(ctx: HouseholdContext, draft: Draft): Promise<RulePreview> {
    return this.scope.run(ctx, async (tx) => {
      const changes = await runRules(
        tx,
        ctx.householdId,
        await this.#visibleRows(tx),
        [
          {
            id: 'draft',
            memberId: draft.scope === 'mine' ? ctx.memberId : null,
            conditions: draft.conditions,
            actions: draft.actions,
            authorMemberId: ctx.memberId,
          },
        ],
        ctx.role === 'viewer' ? new Map() : await accessLevels(tx),
        null,
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
        memberId: row.rule.memberId,
        conditions: row.rule.conditions as RuleConditions,
        actions: row.rule.actions as RuleActions,
        authorMemberId: row.rule.authorMemberId,
      };
      const changes = await runRules(
        tx,
        ctx.householdId,
        await this.#visibleRows(tx),
        [rule],
        await accessLevels(tx),
        activity,
      );
      if (changes.length) {
        await activity.record({
          action: 'rule.applied',
          targetType: 'rule',
          targetId: id,
          metadata: { transactions: changes.length },
          visibleToHousehold: rule.memberId === null,
        });
      }
      return { changed: changes.length };
    });
  }

  /**
   * A transfer goes to an account you own (TXN-08), and recording its other side needs a manual
   * account that follows its transactions (transfers.md §3). Checked again whenever it runs.
   */
  async #checkActions(tx: Executor, actions: RuleActions) {
    const t = actions.transferTo;
    if (!t) return;
    if ((await accessLevels(tx)).get(t.accountId) !== 'owner') {
      throw new Problem(422, 'invalid_account', 'Choose an account you own for the transfer');
    }
    if (!t.recordIfMissing) return;
    const [target] = await tx
      .select({ connectionId: accounts.connectionId, balanceMode: accounts.balanceMode })
      .from(accounts)
      .where(eq(accounts.id, t.accountId));
    if (target!.connectionId !== null || target!.balanceMode !== 'transactions') {
      throw new Problem(
        422,
        'cannot_record',
        'Only a manual account that follows its transactions can have the other side recorded',
        'Turn off “record it if it isn’t there”, or choose another account.',
      );
    }
  }

  /** Every transaction the caller can see (row-level security), not deleted. */
  #visibleRows(tx: Parameters<Parameters<HouseholdScope['run']>[1]>[0]) {
    return tx
      .select()
      .from(transactions)
      .where(and(isNull(transactions.deletedAt), eq(transactions.hasSplits, false)));
  }
}

/** The household's rules (null), or one member's. */
const inScope = (memberId: string | null) =>
  memberId === null ? isNull(rules.memberId) : eq(rules.memberId, memberId);

const toRule = (r: typeof rules.$inferSelect, authorLeft: boolean): Rule => ({
  id: r.id,
  scope: r.memberId === null ? 'household' : 'mine',
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
