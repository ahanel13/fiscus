// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor } from '@fiscus/db';
import {
  type MoveOutCategory,
  type MoveOutGoal,
  type MoveOutInput,
  type MoveOutPlan,
  type MoveOutRole,
  planMoveOut,
} from '@fiscus/domain';
import { sql } from 'drizzle-orm';

// Moving out (#253, ADR 0012 step 3): reading what the plan is worked out from. The api reads it
// in the person's own context for the preview; the worker reads it as fiscus_maintenance when the
// move starts. Every query names the household and keeps to what the person could see anyway
// (their accounts, connections, budget, goals and rules, and the household's goals on them), so
// both read the same and the preview shows what happens.

const ids = (list: readonly string[]) =>
  list.length === 0
    ? sql`ARRAY[]::uuid[]`
    : sql`ARRAY[${sql.join(
        list.map((v) => sql`${v}`),
        sql`, `,
      )}]::uuid[]`;

const rows = async <T extends Record<string, unknown>>(
  tx: Executor,
  query: ReturnType<typeof sql>,
) => (await tx.execute<T>(query)).rows;

/** What `planMoveOut` needs, for `memberId` moving out of `householdId`. */
export async function loadMoveOutInput(
  tx: Executor,
  householdId: string,
  memberId: string,
): Promise<MoveOutInput> {
  const members = await rows<{
    id: string;
    display_name: string;
    role: MoveOutRole;
    user_id: string | null;
  }>(
    tx,
    sql`SELECT id, display_name, role, user_id FROM household_members
        WHERE household_id = ${householdId} AND left_at IS NULL ORDER BY joined_at, id`,
  );

  const accounts = await rows<{
    id: string;
    name: string;
    closed: boolean;
    connection_id: string | null;
    owners: { memberId: string; shareBps: number }[];
    transaction_count: number;
  }>(
    tx,
    sql`SELECT a.id, a.name, a.closed_at IS NOT NULL AS closed, a.connection_id,
          (SELECT json_agg(json_build_object('memberId', o.member_id, 'shareBps', o.share_bps)
                           ORDER BY o.member_id)
             FROM account_owners o WHERE o.account_id = a.id) AS owners,
          (SELECT count(*)::int FROM transactions t
             WHERE t.account_id = a.id AND t.household_id = a.household_id
               AND t.deleted_at IS NULL AND t.parent_id IS NULL) AS transaction_count
        FROM accounts a
        WHERE a.household_id = ${householdId}
          AND EXISTS (SELECT 1 FROM account_owners o
                      WHERE o.account_id = a.id AND o.member_id = ${memberId})
        ORDER BY a.sort_order, a.id`,
  );
  const sole = accounts
    .filter((a) => a.owners.every((o) => o.memberId === memberId))
    .map((a) => a.id);
  const all = accounts.map((a) => a.id);

  const connections = await rows<{
    id: string;
    owner_member_id: string;
    credential_set_id: string | null;
    institution_name: string | null;
    account_ids: string[];
  }>(
    tx,
    sql`SELECT c.id, c.owner_member_id, c.credential_set_id, i.name AS institution_name,
          coalesce((SELECT array_agg(a.id ORDER BY a.id) FROM accounts a
                     WHERE a.connection_id = c.id AND a.household_id = c.household_id),
                   ARRAY[]::uuid[]) AS account_ids
        FROM connections c LEFT JOIN institutions i ON i.id = c.institution_id
        WHERE c.household_id = ${householdId}
          AND (c.owner_member_id = ${memberId}
               OR c.id IN (SELECT a.connection_id FROM accounts a
                           WHERE a.id = ANY (${ids(all)}) AND a.connection_id IS NOT NULL))
        ORDER BY c.created_at, c.id`,
  );

  const [budget] = await rows<{ id: string }>(
    tx,
    sql`SELECT id FROM budgets WHERE household_id = ${householdId} AND member_id = ${memberId}`,
  );

  const goals = await rows<{
    id: string;
    name: string;
    member_id: string | null;
    kind: MoveOutGoal['kind'];
    account_id: string | null;
    claim_account_ids: string[];
  }>(
    tx,
    sql`SELECT g.id, g.name, g.member_id, g.kind, g.account_id,
          coalesce((SELECT array_agg(c.account_id ORDER BY c.account_id) FROM goal_claims c
                     WHERE c.goal_id = g.id AND c.household_id = g.household_id),
                   ARRAY[]::uuid[]) AS claim_account_ids
        FROM goals g
        WHERE g.household_id = ${householdId}
          AND (g.member_id = ${memberId}
               OR (g.member_id IS NULL AND (
                     g.account_id = ANY (${ids(sole)})
                     OR EXISTS (SELECT 1 FROM goal_claims c
                                WHERE c.goal_id = g.id AND c.account_id = ANY (${ids(sole)})))))
        ORDER BY g.position, g.id`,
  );

  const rules = await rows<{
    id: string;
    name: string | null;
    conditions: Record<string, unknown>;
    actions: Record<string, unknown>;
  }>(
    tx,
    sql`SELECT id, name, conditions, actions FROM rules
        WHERE household_id = ${householdId} AND member_id = ${memberId}
        ORDER BY position, id`,
  );

  // Categories their data uses: the moving accounts' transactions, their budget, their rules.
  const ruleCategories = rules.flatMap((r) =>
    [r.conditions.categoryId, r.actions.categoryId].filter(
      (id): id is string => typeof id === 'string',
    ),
  );
  const ruleTags = rules.flatMap((r) =>
    Array.isArray(r.actions.addTagIds) ? (r.actions.addTagIds as string[]) : [],
  );
  const categories = await rows<{
    id: string;
    name: string;
    group_id: string;
    group_name: string;
    group_kind: string;
    system_key: string | null;
  }>(
    tx,
    sql`WITH used AS (
          SELECT category_id AS id FROM transactions
            WHERE household_id = ${householdId} AND account_id = ANY (${ids(sole)})
          UNION SELECT transfer_previous_category_id FROM transactions
            WHERE household_id = ${householdId} AND account_id = ANY (${ids(sole)})
          UNION SELECT category_id FROM budget_amounts
            WHERE household_id = ${householdId} AND budget_id = ${budget?.id ?? null}::uuid
          UNION SELECT category_id FROM budget_categories
            WHERE household_id = ${householdId} AND budget_id = ${budget?.id ?? null}::uuid
          UNION SELECT unnest(ARRAY[from_category_id, to_category_id]) FROM budget_moves
            WHERE household_id = ${householdId} AND budget_id = ${budget?.id ?? null}::uuid
          UNION SELECT k::uuid FROM budget_templates, jsonb_object_keys(amounts) AS k
            WHERE household_id = ${householdId} AND budget_id = ${budget?.id ?? null}::uuid
          UNION SELECT unnest(${ids(ruleCategories)})
        )
        SELECT c.id, c.name, c.group_id, g.name AS group_name, g.kind::text AS group_kind,
               c.system_key
        FROM categories c JOIN category_groups g ON g.id = c.group_id
        WHERE c.household_id = ${householdId} AND c.id IN (SELECT id FROM used)
        ORDER BY g.sort_order, c.sort_order, c.id`,
  );
  const tags = await rows<{ id: string; name: string; color: string }>(
    tx,
    sql`SELECT t.id, t.name, t.color FROM tags t
        WHERE t.household_id = ${householdId}
          AND (t.id IN (SELECT tt.tag_id FROM transaction_tags tt JOIN transactions x
                          ON x.id = tt.transaction_id
                        WHERE x.household_id = ${householdId} AND x.account_id = ANY (${ids(sole)}))
               OR t.id = ANY (${ids(ruleTags)}))
        ORDER BY lower(t.name), t.id`,
  );

  const [counts] = await rows<{ elsewhere: number; for_others: number }>(
    tx,
    sql`SELECT
          (SELECT count(DISTINCT t.id)::int FROM transactions t
             JOIN transaction_attributions ta ON ta.transaction_id = t.id
           WHERE t.household_id = ${householdId} AND ta.member_id = ${memberId}
             AND t.deleted_at IS NULL AND NOT (t.account_id = ANY (${ids(all)}))) AS elsewhere,
          (SELECT count(DISTINCT t.id)::int FROM transactions t
             JOIN transaction_attributions ta ON ta.transaction_id = t.id
           WHERE t.household_id = ${householdId} AND ta.member_id <> ${memberId}
             AND t.deleted_at IS NULL AND t.account_id = ANY (${ids(sole)})) AS for_others`,
  );

  return {
    memberId,
    members: members.map((m) => ({
      id: m.id,
      displayName: m.display_name,
      role: m.role,
      userId: m.user_id,
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      closed: a.closed,
      connectionId: a.connection_id,
      owners: a.owners,
      transactionCount: a.transaction_count,
    })),
    connections: connections.map((c) => ({
      id: c.id,
      ownerMemberId: c.owner_member_id,
      credentialSetId: c.credential_set_id,
      institutionName: c.institution_name,
      accountIds: c.account_ids,
    })),
    budgetId: budget?.id ?? null,
    goals: goals.map((g) => ({
      id: g.id,
      name: g.name,
      memberId: g.member_id,
      kind: g.kind,
      accountId: g.account_id,
      claimAccountIds: g.claim_account_ids,
    })),
    rules,
    categories: categories.map((c): MoveOutCategory => ({
      id: c.id,
      name: c.name,
      groupId: c.group_id,
      groupName: c.group_name,
      groupKind: c.group_kind,
      systemKey: c.system_key,
    })),
    tags,
    attributedElsewhere: counts?.elsewhere ?? 0,
    forOthers: counts?.for_others ?? 0,
  };
}

/** Reads and plans in one go. */
export async function planMemberMoveOut(
  tx: Executor,
  householdId: string,
  memberId: string,
): Promise<{ input: MoveOutInput; plan: MoveOutPlan }> {
  const input = await loadMoveOutInput(tx, householdId, memberId);
  return { input, plan: planMoveOut(input) };
}
