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
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { accessLevels } from './access.js';
import type { HouseholdActivity } from './activity.js';
import { recomputeBalances } from './balances.js';
import { householdRanges } from './ranges.js';
import { linkTransfers, transferCategories } from './transfers.js';

// The rules engine (docs/design/imports.md §3, permissions RULE-05). Given transactions and
// rules, it works out what each rule may change and, when asked, changes it:
// - rules run in order: the household's, then the rules of each of the account's owners (#58),
//   owners by share, largest first, then by member id; every matching rule applies; a later one
//   wins for the same field;
// - a field a person set (or a file they imported supplied) is never changed: field_versions
//   records those (transactions.service.ts, markPersonSet);
// - each action reaches only where the rule's author could act by hand, re-checked every run,
//   and only where the person running it could too (applying to existing transactions).

export interface EngineRule {
  id: string;
  /** Whose rule it is (null: the household's); it runs only on accounts they own. */
  memberId: string | null;
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
  /** The last matching rule's "transfer to" (transfers.md §3). */
  transfer: NonNullable<RuleActions['transferTo']> | null;
}

/** What a "transfer to" does for one transaction. */
interface TransferPlan {
  accountId: string;
  withinDays: number;
  outcome: 'link' | 'record' | 'wait';
  /** The other side found there (link). */
  partner?: { id: string; accountId: string };
}

/** What may be done to a transaction in an account at a level (permissions §4.3–4.4). */
const canCategorize = (l: AccessLevel | undefined) => l === 'owner' || l === 'full';
const canEdit = (l: AccessLevel | undefined) => l === 'owner';

/**
 * The enabled rules that may run, in order, whose authors are still current non-viewers: the
 * household's and the ones the caller can see (their own; every member's in system context). With
 * `accountIds`, also the other owners' rules for those of these accounts the caller owns, so an
 * import into a joint account runs every owner's rules (fiscus_owner_rules()).
 */
export async function activeRules(tx: Executor, accountIds: string[] = []): Promise<EngineRule[]> {
  const found = await tx
    .select({
      id: rules.id,
      memberId: rules.memberId,
      position: rules.position,
      createdAt: rules.createdAt,
      conditions: rules.conditions,
      actions: rules.actions,
      authorMemberId: rules.authorMemberId,
    })
    .from(rules)
    .where(eq(rules.enabled, true));
  if (accountIds.length) {
    const { rows } = await tx.execute<{
      id: string;
      member_id: string;
      position: number;
      created_at: string;
      conditions: RuleConditions;
      actions: RuleActions;
      author_member_id: string;
    }>(sql`SELECT * FROM fiscus_owner_rules(${`{${accountIds.join(',')}}`}::uuid[])`);
    const seen = new Set(found.map((r) => r.id));
    for (const r of rows.filter((r) => !seen.has(r.id))) {
      found.push({
        id: r.id,
        memberId: r.member_id,
        position: r.position,
        createdAt: new Date(r.created_at),
        conditions: r.conditions,
        actions: r.actions,
        authorMemberId: r.author_member_id,
      });
    }
  }
  const authors = new Set(
    (
      await tx
        .select({ id: householdMembers.id })
        .from(householdMembers)
        .where(and(isNull(householdMembers.leftAt), sql`${householdMembers.role} <> 'viewer'`))
    ).map((m) => m.id),
  );
  return found
    .filter((r) => authors.has(r.authorMemberId))
    .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => ({
      id: r.id,
      memberId: r.memberId,
      conditions: r.conditions as RuleConditions,
      actions: r.actions as RuleActions,
      authorMemberId: r.authorMemberId,
    }));
}

/**
 * Works out (and with `activity`, makes) the changes `ruleList` would make to `rows`. `caller` is
 * the access of whoever runs it: actions also need them to be allowed (null: an import, where the
 * importer owns the account anyway). Only an import (on arrival) records the other side of a
 * transfer; applying to existing transactions links and waits but never creates.
 */
export async function runRules(
  tx: Executor,
  householdId: string,
  rows: Row[],
  ruleList: EngineRule[],
  caller: Map<string, AccessLevel> | null,
  activity: HouseholdActivity | null,
): Promise<RuleChange[]> {
  const candidates = rows.filter((r) => !r.deletedAt && !r.hasSplits && !r.parentId);
  if (candidates.length === 0 || ruleList.length === 0) return [];

  // The authors' access, from the accounts' owners and visibility (fiscus_account_access()).
  const targets = ruleList.flatMap((r) =>
    r.actions.transferTo ? [r.actions.transferTo.accountId] : [],
  );
  const accountIds = [...new Set([...candidates.map((r) => r.accountId), ...targets])];
  const acctRows = await tx
    .select({ id: accounts.id, visibility: accounts.visibility })
    .from(accounts)
    .where(inArray(accounts.id, accountIds));
  const owners = await tx
    .select({ accountId: accountOwners.accountId, memberId: accountOwners.memberId })
    .from(accountOwners)
    .where(inArray(accountOwners.accountId, accountIds))
    .orderBy(desc(accountOwners.shareBps), asc(accountOwners.memberId));
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

  // The order rules run in on an account: the household's, then each owner's, largest share
  // first, then by member id. A member's rules run only on accounts they own.
  const household = ruleList.filter((r) => r.memberId === null);
  const byMember = Map.groupBy(
    ruleList.filter((r) => r.memberId !== null),
    (r) => r.memberId!,
  );
  const ordered = new Map<string, EngineRule[]>();
  const rulesFor = (accountId: string) => {
    let list = ordered.get(accountId);
    if (!list) {
      list = [
        ...household,
        ...owners
          .filter((o) => o.accountId === accountId)
          .flatMap((o) => byMember.get(o.memberId) ?? []),
      ];
      ordered.set(accountId, list);
    }
    return list;
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
        .where(and(eq(householdMembers.householdId, householdId), isNull(householdMembers.leftAt)))
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
    const plan: Plan = { row, set: {}, addTags: new Set(), attribution: null, transfer: null };
    for (const rule of rulesFor(row.accountId)) {
      if (!ruleMatches(rule.conditions, row, uncategorized?.id ?? null)) continue;
      const a = rule.actions;
      const categorize = allowed(rule, row.accountId, 'categorize');
      const edit = allowed(rule, row.accountId, 'edit');
      if (a.rename && categorize && !personSet.has('displayName')) plan.set.displayName = a.rename;
      if (
        a.categoryId &&
        categorize &&
        liveCategories.has(a.categoryId) &&
        // A linked transfer keeps its Transfer category; unlink it to recategorize (#40).
        !row.transferGroupId &&
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
      // A transfer needs ownership of both sides, as linking by hand does (TXN-08).
      if (
        a.transferTo &&
        edit &&
        allowed(rule, a.transferTo.accountId, 'edit') &&
        !row.transferGroupId &&
        !row.transferExternal &&
        !row.pending
      ) {
        plan.transfer = a.transferTo;
      }
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

  const transfers = await resolveTransfers(
    tx,
    householdId,
    plans.filter((p) => p.transfer),
    caller ?? (await accessLevels(tx)),
    caller === null,
  );

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
    const transfer = transfers.get(row.id);
    if (transfer) {
      changes.transfer = [null, { accountId: transfer.accountId, outcome: transfer.outcome }];
    }
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

  if (activity) {
    await write(
      tx,
      householdId,
      out.map((o) => o.plan),
    );
    await writeTransfers(
      tx,
      activity,
      householdId,
      transfers,
      candidates,
      uncategorized?.id ?? null,
    );
  }
  return out.map((o) => o.change);
}

/**
 * Decides what each "transfer to" does: link to the other side already in that account (the
 * nearest within the rule's days; a tie is left for a person), record it there (on arrival, into a
 * manual account that follows its transactions), or wait for it to arrive. The person running it
 * must own both accounts too, since linking writes both sides. A transaction whose window has
 * passed with nothing there gets nothing: the transfer review asks about it instead.
 */
async function resolveTransfers(
  tx: Executor,
  householdId: string,
  plans: Plan[],
  me: Map<string, AccessLevel>,
  onArrival: boolean,
): Promise<Map<string, TransferPlan>> {
  const out = new Map<string, TransferPlan>();
  if (plans.length === 0) return out;
  const targetIds = [...new Set(plans.map((p) => p.transfer!.accountId))];
  const targets = new Map(
    (
      await tx
        .select({
          id: accounts.id,
          currency: accounts.currency,
          connectionId: accounts.connectionId,
          balanceMode: accounts.balanceMode,
          closedAt: accounts.closedAt,
        })
        .from(accounts)
        .where(inArray(accounts.id, targetIds))
    ).map((a) => [a.id, a]),
  );
  const { today } = await householdRanges(tx, householdId);
  const taken = new Set<string>();
  for (const { row, transfer: t } of plans) {
    const target = targets.get(t!.accountId);
    if (
      !target ||
      target.id === row.accountId ||
      target.currency !== row.currency ||
      me.get(row.accountId) !== 'owner' ||
      me.get(target.id) !== 'owner'
    ) {
      continue;
    }
    const plan = { accountId: target.id, withinDays: t!.withinDays };
    const distance = sql<number>`abs(${transactions.effectiveDate} - ${row.effectiveDate}::date)`;
    const found = (
      await tx
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          distance,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, target.id),
            eq(transactions.amountMinor, -row.amountMinor),
            eq(transactions.currency, row.currency),
            isNull(transactions.transferGroupId),
            eq(transactions.transferExternal, false),
            isNull(transactions.deletedAt),
            isNull(transactions.parentId),
            eq(transactions.hasSplits, false),
            eq(transactions.pending, false),
            sql`${distance} <= ${t!.withinDays}`,
          ),
        )
        .orderBy(distance, asc(transactions.id))
        .limit(5)
    ).filter((f) => !taken.has(f.id));
    const [nearest, next] = found;
    if (nearest && next?.distance !== nearest.distance) {
      taken.add(nearest.id);
      out.set(row.id, { ...plan, outcome: 'link', partner: nearest });
      continue;
    }
    const windowOpen =
      new Date(Date.parse(row.effectiveDate) + t!.withinDays * 86_400_000)
        .toISOString()
        .slice(0, 10) >= today;
    if (
      !nearest &&
      t!.recordIfMissing &&
      onArrival &&
      target.connectionId === null &&
      target.balanceMode === 'transactions' &&
      !target.closedAt
    ) {
      out.set(row.id, { ...plan, outcome: 'record' });
    } else if (windowOpen && row.transferExpectedAccountId !== target.id) {
      out.set(row.id, { ...plan, outcome: 'wait' });
    }
  }
  return out;
}

/** Carries out resolveTransfers' decisions. */
async function writeTransfers(
  tx: Executor,
  activity: HouseholdActivity,
  householdId: string,
  plans: Map<string, TransferPlan>,
  rows: Row[],
  uncategorized: string | null,
) {
  if (plans.size === 0) return;
  const cats = await transferCategories(tx);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pairs: [{ id: string; accountId: string }, { id: string; accountId: string }][] = [];
  const recorded = new Set<string>();
  for (const [rowId, plan] of plans) {
    const row = byId.get(rowId)!;
    if (plan.outcome === 'link') pairs.push([row, plan.partner!]);
    if (plan.outcome === 'record') {
      const id = uuidv7();
      await tx.insert(transactions).values({
        id,
        householdId,
        accountId: plan.accountId,
        amountMinor: -row.amountMinor,
        currency: row.currency,
        authorizedDate: row.effectiveDate,
        postedDate: row.effectiveDate,
        originalDescription: row.originalDescription,
        displayName: row.displayName,
        categoryId: cats.transfer,
        reviewStatus: 'reviewed',
        source: 'manual',
        // Undoing the import that brought the first side removes this one too.
        importBatchId: row.importBatchId,
      });
      recorded.add(plan.accountId);
      pairs.push([row, { id, accountId: plan.accountId }]);
      await activity.record({
        action: 'transaction.created',
        targetType: 'transaction',
        targetId: id,
        accountId: plan.accountId,
        metadata: { by: 'rule', otherSideOf: row.id },
      });
    }
    if (plan.outcome === 'wait') {
      // It's a transfer whether or not the other side has come: out of spending meanwhile.
      const intoTransfer =
        row.categoryId === null ||
        row.categoryId === uncategorized ||
        !Object.hasOwn(row.fieldVersions, 'categoryId');
      await tx
        .update(transactions)
        .set({
          transferExpectedAccountId: plan.accountId,
          transferExpectedDays: plan.withinDays,
          ...(intoTransfer && !cats.transferKind.has(row.categoryId ?? '')
            ? { categoryId: cats.transfer }
            : {}),
          version: sql`${transactions.version} + 1`,
        })
        .where(eq(transactions.id, row.id));
    }
  }
  // Rows written above may have changed since `rows` was read (write()); link from fresh ones.
  if (pairs.length) await linkTransfers(tx, activity, pairs, cats, true);
  for (const accountId of recorded) await recomputeBalances(tx, accountId);
}

/** Applies plans in as few statements as it can: rows with the same changes go together. */
async function write(tx: Executor, householdId: string, plans: Plan[]) {
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
      householdId,
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
        householdId,
        shareBps: equal ? (i === 0 ? 10000 - base * (list.length - 1) : base) : a.shareBps!,
      }));
    });
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(transactionAttributions).values(rows.slice(i, i + 1000));
    }
  }
}
