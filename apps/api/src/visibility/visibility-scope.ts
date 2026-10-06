// SPDX-License-Identifier: AGPL-3.0-or-later
import { accountOwners, type Executor, householdMembers, transactions } from '@fiscus/db';
import type { AccessLevel, Lens } from '@fiscus/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { type SQL, sql } from 'drizzle-orm';
import { Problem } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';

// Which accounts a request covers and how much of each counts (ADR 0006 §5, design §4). Every
// money query goes through here; nothing filters accounts by hand. Visibility itself is enforced
// by row-level security: this only narrows what the database already allows.

export interface ScopedAccount {
  level: AccessLevel;
  /** How much of the account counts toward totals under the lens, in basis points. */
  weightBps: number;
}

/** Every account the caller can see, with their level (fiscus_account_access()). */
export async function accessLevels(tx: Executor): Promise<Map<string, AccessLevel>> {
  const { rows } = await tx.execute<{ account_id: string; level: AccessLevel }>(
    sql`SELECT account_id, level FROM fiscus_account_access()`,
  );
  return new Map(rows.map((r) => [r.account_id, r.level]));
}

const invalidLens = () =>
  new Problem(422, 'invalid_lens', 'Unknown lens', 'Use all, me, shared, or member:<member id>.');

/**
 * Money views (balances, net worth, account lists) follow ownership:
 * - `all`: every visible account, in full;
 * - `me` / `member:<id>`: accounts that member owns, alone or jointly, weighted by their share;
 * - `shared`: joint accounts (two or more owners), in full.
 */
export async function moneyScope(
  tx: Executor,
  ctx: HouseholdContext,
  lens: Lens,
): Promise<Map<string, ScopedAccount>> {
  const levels = await accessLevels(tx);
  if (lens === 'all') {
    return new Map([...levels].map(([id, level]) => [id, { level, weightBps: 10000 }]));
  }

  let member: string | undefined;
  if (lens === 'me') member = ctx.memberId;
  else if (lens.startsWith('member:')) {
    member = lens.slice('member:'.length);
    const [active] = await tx
      .select({ id: householdMembers.id })
      .from(householdMembers)
      .where(
        and(
          eq(householdMembers.id, member),
          eq(householdMembers.householdId, ctx.householdId),
          isNull(householdMembers.leftAt),
        ),
      );
    if (!active) throw invalidLens();
  }

  const owners = new Map<string, Map<string, number>>();
  for (const o of await tx
    .select({
      accountId: accountOwners.accountId,
      memberId: accountOwners.memberId,
      shareBps: accountOwners.shareBps,
    })
    .from(accountOwners)) {
    const shares = owners.get(o.accountId) ?? new Map<string, number>();
    shares.set(o.memberId, o.shareBps);
    owners.set(o.accountId, shares);
  }

  const scoped = new Map<string, ScopedAccount>();
  for (const [id, level] of levels) {
    const shares = owners.get(id);
    if (!shares) continue;
    if (member) {
      const share = shares.get(member);
      if (share) scoped.set(id, { level, weightBps: share });
    } else if (shares.size >= 2) {
      scoped.set(id, { level, weightBps: 10000 }); // shared
    }
  }
  return scoped;
}

/**
 * Spending views (transactions, cash flow, budgets) follow attribution (ADR 0006 §5): explicit
 * attribution, else the paying account's owners. `me` / `member:<id>` = attributed to that member
 * alone; `shared` = attributed to two or more; `all` = everything visible.
 */
export async function spendingLensFilter(
  tx: Executor,
  ctx: HouseholdContext,
  lens: Lens,
): Promise<SQL | undefined> {
  if (lens === 'all') return undefined;
  const members = sql`coalesce(
    (SELECT array_agg(ta.member_id) FROM transaction_attributions ta WHERE ta.transaction_id = ${transactions.id}),
    (SELECT array_agg(o.member_id) FROM account_owners o WHERE o.account_id = ${transactions.accountId}))`;
  if (lens === 'shared') return sql`coalesce(array_length(${members}, 1), 0) >= 2`;
  const member = lens === 'me' ? ctx.memberId : lens.slice('member:'.length);
  if (lens !== 'me') {
    const [active] = await tx
      .select({ id: householdMembers.id })
      .from(householdMembers)
      .where(and(eq(householdMembers.id, member), isNull(householdMembers.leftAt)));
    if (!active) throw invalidLens();
  }
  return sql`${members} = ARRAY[${member}::uuid]`;
}
