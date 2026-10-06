// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountOwners,
  accounts,
  categories,
  type Executor,
  householdMembers,
  rules,
  tags,
  transactionAttributions,
  transactions,
  transactionTags,
} from '@fiscus/db';
import {
  type AccessLevel,
  type RuleActions,
  type RuleChange,
  type RuleConditions,
  ruleMatches,
} from '@fiscus/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { HouseholdContext } from '../households/household-context.js';

// The rules engine (docs/design/imports.md §3, permissions RULE-05). Given transactions and
// rules, it works out what each rule may change and, when asked, changes it:
// - rules run in order; every matching rule applies; a later one wins for the same field;
// - a field a person set (or a file they imported supplied) is never changed: field_versions
//   records those (transactions.service.ts, markPersonSet);
// - each action reaches only where the rule's author could act by hand, re-checked every run,
//   and only where the person running it could too (applying to existing transactions).

export interface EngineRule {
  id: string;
  conditions: RuleConditions;
  actions: RuleActions;
  authorMemberId: string;
}

type Row = typeof transactions.$inferSelect;

interface Plan {
  row: Row;
  set: Partial<Pick<Row, 'displayName' | 'categoryId' | 'reviewStatus' | 'excluded'>>;
  addTags: Set<string>;
  attribution: { memberId: string; shareBps?: number | undefined }[] | null;
}

/** What may be done to a transaction in an account at a level (permissions §4.3–4.4). */
const canCategorize = (l: AccessLevel | undefined) => l === 'owner' || l === 'full';
const canEdit = (l: AccessLevel | undefined) => l === 'owner';

/** The household's enabled rules, in order, whose authors are still current non-viewers. */
export async function activeRules(tx: Executor): Promise<EngineRule[]> {
  const rows = await tx
    .select({
      id: rules.id,
      conditions: rules.conditions,
      actions: rules.actions,
      authorMemberId: rules.authorMemberId,
    })
    .from(rules)
    .innerJoin(householdMembers, eq(householdMembers.id, rules.authorMemberId))
    .where(
      and(
        eq(rules.enabled, true),
        isNull(householdMembers.leftAt),
        sql`${householdMembers.role} <> 'viewer'`,
      ),
    )
    .orderBy(asc(rules.position), asc(rules.createdAt));
  return rows as EngineRule[];
}

/**
 * Works out (and with `apply`, makes) the changes `ruleList` would make to `rows`. `caller` is the
 * access of whoever runs it: actions also need them to be allowed (null: an import, where the
 * importer owns the account anyway).
 */
export async function runRules(
  tx: Executor,
  ctx: HouseholdContext,
  rows: Row[],
  ruleList: EngineRule[],
  caller: Map<string, AccessLevel> | null,
  apply: boolean,
): Promise<RuleChange[]> {
  const candidates = rows.filter((r) => !r.deletedAt && !r.hasSplits && !r.parentId);
  if (candidates.length === 0 || ruleList.length === 0) return [];

  // The authors' access, from the accounts' owners and visibility (fiscus_account_access()).
  const accountIds = [...new Set(candidates.map((r) => r.accountId))];
  const acctRows = await tx
    .select({ id: accounts.id, visibility: accounts.visibility })
    .from(accounts)
    .where(inArray(accounts.id, accountIds));
  const owners = await tx
    .select({ accountId: accountOwners.accountId, memberId: accountOwners.memberId })
    .from(accountOwners)
    .where(inArray(accountOwners.accountId, accountIds));
  const authorLevel = (memberId: string, accountId: string): AccessLevel | undefined => {
    if (owners.some((o) => o.accountId === accountId && o.memberId === memberId)) return 'owner';
    const v = acctRows.find((a) => a.id === accountId)?.visibility;
    return v === 'full' ? 'full' : v === 'view_only' ? 'view_only' : undefined;
  };
  const allowed = (rule: EngineRule, accountId: string, kind: 'categorize' | 'edit') => {
    const check = kind === 'categorize' ? canCategorize : canEdit;
    return (
      check(authorLevel(rule.authorMemberId, accountId)) &&
      (caller === null || check(caller.get(accountId)))
    );
  };

  // What actions may refer to: live categories, tags, and current members.
  const liveCategories = new Set(
    (
      await tx.select({ id: categories.id }).from(categories).where(isNull(categories.archivedAt))
    ).map((c) => c.id),
  );
  const [uncategorized] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.systemKey, 'uncategorized'));
  const liveTags = new Set((await tx.select({ id: tags.id }).from(tags)).map((t) => t.id));
  const liveMembers = new Set(
    (
      await tx
        .select({ id: householdMembers.id })
        .from(householdMembers)
        .where(
          and(eq(householdMembers.householdId, ctx.householdId), isNull(householdMembers.leftAt)),
        )
    ).map((m) => m.id),
  );
  const existingTags = new Map<string, string[]>();
  for (const t of await tx
    .select()
    .from(transactionTags)
    .where(
      inArray(
        transactionTags.transactionId,
        candidates.map((r) => r.id),
      ),
    )) {
    existingTags.set(t.transactionId, [...(existingTags.get(t.transactionId) ?? []), t.tagId]);
  }
  const existingAttribution = new Map<string, string[]>();
  for (const a of await tx
    .select({
      transactionId: transactionAttributions.transactionId,
      memberId: transactionAttributions.memberId,
    })
    .from(transactionAttributions)
    .where(
      inArray(
        transactionAttributions.transactionId,
        candidates.map((r) => r.id),
      ),
    )) {
    existingAttribution.set(a.transactionId, [
      ...(existingAttribution.get(a.transactionId) ?? []),
      a.memberId,
    ]);
  }

  const plans: Plan[] = [];
  for (const row of candidates) {
    const personSet = new Set(Object.keys(row.fieldVersions));
    const plan: Plan = { row, set: {}, addTags: new Set(), attribution: null };
    for (const rule of ruleList) {
      if (!ruleMatches(rule.conditions, row, uncategorized?.id ?? null)) continue;
      const a = rule.actions;
      const categorize = allowed(rule, row.accountId, 'categorize');
      const edit = allowed(rule, row.accountId, 'edit');
      if (a.rename && categorize && !personSet.has('displayName')) plan.set.displayName = a.rename;
      if (
        a.categoryId &&
        categorize &&
        liveCategories.has(a.categoryId) &&
        // An "Uncategorized" from a file isn't a decision: rules may fill it in.
        (!personSet.has('categoryId') || row.categoryId === uncategorized?.id)
      ) {
        plan.set.categoryId = a.categoryId;
      }
      if (a.addTagIds && categorize && !personSet.has('tagIds')) {
        for (const t of a.addTagIds) if (liveTags.has(t)) plan.addTags.add(t);
      }
      if (a.markReviewed && categorize && !personSet.has('reviewStatus')) {
        plan.set.reviewStatus = 'reviewed';
      }
      if (a.exclude && edit && !personSet.has('excluded')) plan.set.excluded = true;
      if (
        a.attribution &&
        edit &&
        !personSet.has('attribution') &&
        a.attribution.every((x) => liveMembers.has(x.memberId))
      ) {
        plan.attribution = a.attribution;
      }
    }
    plans.push(plan);
  }

  // Keep only real changes.
  const out: { plan: Plan; change: RuleChange }[] = [];
  for (const plan of plans) {
    const { row } = plan;
    const changes: RuleChange['changes'] = {};
    if (plan.set.displayName !== undefined && plan.set.displayName !== row.displayName) {
      changes.displayName = [row.displayName, plan.set.displayName];
    } else delete plan.set.displayName;
    if (plan.set.categoryId !== undefined && plan.set.categoryId !== row.categoryId) {
      changes.categoryId = [row.categoryId, plan.set.categoryId!];
    } else delete plan.set.categoryId;
    if (plan.set.reviewStatus !== undefined && row.reviewStatus !== 'reviewed') {
      changes.reviewStatus = [row.reviewStatus, 'reviewed'];
    } else delete plan.set.reviewStatus;
    if (plan.set.excluded !== undefined && !row.excluded) {
      changes.excluded = [false, true];
    } else delete plan.set.excluded;
    const had = existingTags.get(row.id) ?? [];
    const added = [...plan.addTags].filter((t) => !had.includes(t));
    plan.addTags = new Set(added);
    if (added.length) changes.tagIds = [had, added];
    const before = existingAttribution.get(row.id) ?? [];
    const after = plan.attribution?.map((x) => x.memberId) ?? null;
    if (after && [...before].sort().join() !== [...after].sort().join()) {
      changes.attribution = [before, after];
    } else plan.attribution = null;
    if (Object.keys(changes).length === 0) continue;
    out.push({
      plan,
      change: {
        transactionId: row.id,
        date: row.effectiveDate,
        amountMinor: row.amountMinor,
        currency: row.currency,
        displayName: row.displayName,
        changes,
      },
    });
  }

  if (apply)
    await write(
      tx,
      ctx,
      out.map((o) => o.plan),
    );
  return out.map((o) => o.change);
}

/** Applies plans in as few statements as it can: rows with the same changes go together. */
async function write(tx: Executor, ctx: HouseholdContext, plans: Plan[]) {
  const groups = Map.groupBy(
    plans.filter((p) => Object.keys(p.set).length),
    (p) => JSON.stringify(p.set),
  );
  for (const list of groups.values()) {
    await tx
      .update(transactions)
      .set({ ...list[0]!.set, version: sql`${transactions.version} + 1` })
      .where(
        inArray(
          transactions.id,
          list.map((p) => p.row.id),
        ),
      );
  }
  const tagRows = plans.flatMap((p) =>
    [...p.addTags].map((tagId) => ({
      transactionId: p.row.id,
      tagId,
      householdId: ctx.householdId,
    })),
  );
  for (let i = 0; i < tagRows.length; i += 1000) {
    await tx
      .insert(transactionTags)
      .values(tagRows.slice(i, i + 1000))
      .onConflictDoNothing();
  }
  const attributed = plans.filter((p) => p.attribution);
  if (attributed.length) {
    await tx.delete(transactionAttributions).where(
      inArray(
        transactionAttributions.transactionId,
        attributed.map((p) => p.row.id),
      ),
    );
    const rows = attributed.flatMap((p) => {
      const list = p.attribution!;
      const equal = list[0]?.shareBps === undefined;
      const base = Math.floor(10000 / list.length);
      return list.map((a, i) => ({
        transactionId: p.row.id,
        memberId: a.memberId,
        householdId: ctx.householdId,
        shareBps: equal ? (i === 0 ? 10000 - base * (list.length - 1) : base) : a.shareBps!,
      }));
    });
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(transactionAttributions).values(rows.slice(i, i + 1000));
    }
  }
}
