// SPDX-License-Identifier: AGPL-3.0-or-later
import { categories, type Executor, householdMembers, splitPolicies } from '@fiscus/db';
import { householdRanges } from '@fiscus/ledger';
import {
  type SplitPolicies,
  type SplitPolicy,
  type SplitRule,
  splitRuleSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type Row = typeof splitPolicies.$inferSelect;

const notThisEarly = (earliest: string) =>
  new Problem(
    422,
    'split_month_started',
    'A split rule can only change from this month on',
    `Choose ${earliest} or later: earlier months keep the rule they had.`,
  );

/**
 * Split rules (SHR-01/02, ADR 0006 §7): the household's default and its rules for categories,
 * each from a month on. Everyone reads them; owners and members change them, and every change is
 * in the household's activity. A change never reaches back before this month: it adds a row from
 * the month chosen, or replaces one that hasn't started yet.
 */
@Injectable()
export class SplitPoliciesService {
  constructor(private readonly scope: HouseholdScope) {}

  async list(ctx: HouseholdContext): Promise<SplitPolicies> {
    return this.scope.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(splitPolicies)
        .orderBy(asc(splitPolicies.effectiveFrom), asc(splitPolicies.createdAt));
      return { earliestMonth: await earliestMonth(tx, ctx), policies: rows.map(toPolicy) };
    });
  }

  /** Sets the household's default, or a category's rule (null: back to the default). */
  async set(
    ctx: HouseholdContext,
    categoryId: string | null,
    rule: SplitRule | null,
    effectiveFrom: string,
  ): Promise<SplitPolicy> {
    return this.scope.run(ctx, async (tx, activity) => {
      const earliest = await earliestMonth(tx, ctx);
      if (effectiveFrom < earliest) throw notThisEarly(earliest);
      if (categoryId !== null) {
        const [cat] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.id, categoryId));
        if (!cat) throw problems.notFound();
      }
      if (rule) await checkMembers(tx, rule);

      const scope =
        categoryId === null
          ? isNull(splitPolicies.categoryId)
          : eq(splitPolicies.categoryId, categoryId);
      const [before] = await tx
        .select()
        .from(splitPolicies)
        .where(and(scope, sql`${splitPolicies.effectiveFrom} <= ${effectiveFrom}`))
        .orderBy(sql`${splitPolicies.effectiveFrom} DESC`)
        .limit(1);
      // A rule that hasn't started yet is replaced; one that has stays, and this follows it.
      const [row] = await tx
        .insert(splitPolicies)
        .values({
          householdId: ctx.householdId,
          categoryId,
          effectiveFrom,
          method: rule?.method ?? null,
          params: rule ? paramsOf(rule) : {},
          createdByMemberId: ctx.memberId,
        })
        .onConflictDoUpdate({
          target: [
            splitPolicies.householdId,
            splitPolicies.categoryId,
            splitPolicies.effectiveFrom,
          ],
          set: {
            method: rule?.method ?? null,
            params: rule ? paramsOf(rule) : {},
            createdByMemberId: ctx.memberId,
            createdAt: sql`now()`,
          },
        })
        .returning();
      await activity.record({
        action: 'split_rule.changed',
        targetType: categoryId === null ? 'household' : 'category',
        targetId: categoryId ?? ctx.householdId,
        metadata: { categoryId, effectiveFrom, method: rule?.method ?? null },
        changes: {
          before: { rule: before ? ruleOf(before) : null },
          after: { rule },
        },
      });
      return toPolicy(row!);
    });
  }

  /** Cancels a change that hasn't started yet. One that has stays, as the months it covered. */
  async cancel(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const earliest = await earliestMonth(tx, ctx);
      const [row] = await tx.select().from(splitPolicies).where(eq(splitPolicies.id, id));
      if (!row) throw problems.notFound();
      if (row.effectiveFrom <= earliest) {
        throw new Problem(
          409,
          'split_rule_started',
          'This rule has already started',
          'Change it from next month instead: the months it covered keep it.',
        );
      }
      await tx
        .delete(splitPolicies)
        .where(and(eq(splitPolicies.id, id), gt(splitPolicies.effectiveFrom, earliest)));
      await activity.record({
        action: 'split_rule.cancelled',
        targetType: row.categoryId === null ? 'household' : 'category',
        targetId: row.categoryId ?? ctx.householdId,
        metadata: { categoryId: row.categoryId, effectiveFrom: row.effectiveFrom },
        changes: { before: { rule: ruleOf(row) } },
      });
    });
  }
}

/** This month's first day, in the household's time zone. */
async function earliestMonth(tx: Executor, ctx: HouseholdContext): Promise<string> {
  const { today } = await householdRanges(tx, ctx.householdId);
  return `${today.slice(0, 7)}-01`;
}

/** A rule names only active members of the household. */
async function checkMembers(tx: Executor, rule: SplitRule): Promise<void> {
  const named =
    rule.method === 'fixed_percent'
      ? rule.shares.map((s) => s.memberId)
      : rule.method === 'fixed_amount'
        ? rule.amounts.map((a) => a.memberId)
        : [];
  if (named.length === 0) return;
  const active = new Set(
    (
      await tx
        .select({ id: householdMembers.id })
        .from(householdMembers)
        .where(isNull(householdMembers.leftAt))
    ).map((m) => m.id),
  );
  if (named.some((id) => !active.has(id))) {
    throw new Problem(
      422,
      'split_unknown_member',
      'A split rule can only name people in the household',
      undefined,
      [{ path: 'rule', code: 'custom', message: 'Someone named here isn’t in the household' }],
    );
  }
}

const paramsOf = (rule: SplitRule): Record<string, unknown> => {
  const { method: _method, ...params } = rule;
  return params;
};

const ruleOf = (row: Row): SplitRule | null =>
  row.method === null || row.method === 'income_proportional'
    ? null
    : splitRuleSchema.parse({ method: row.method, ...row.params });

const toPolicy = (row: Row): SplitPolicy => ({
  id: row.id,
  categoryId: row.categoryId,
  effectiveFrom: row.effectiveFrom,
  rule: ruleOf(row),
  createdByMemberId: row.createdByMemberId,
});
