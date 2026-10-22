// SPDX-License-Identifier: AGPL-3.0-or-later
import { accounts, balanceSnapshots, type Executor } from '@fiscus/db';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

interface Anchor {
  asOf: string;
  amount: bigint;
}

interface Flow {
  day: string;
  total: bigint;
}

/**
 * Rebuilds the computed balances of an account that follows its transactions (transactions
 * design §2). Balances people entered, and balances the bank reported, are anchors and always win:
 * - after an anchor: the anchor plus the transactions after it;
 * - before the first anchor: that anchor minus the transactions between the day and it;
 * - with no anchors: the running total of the transactions.
 *
 * A bank-connected account's balance is whatever the bank reports: its transaction history is
 * never complete (Plaid returns ~24 months, and no opening balance), so adding the synced
 * transactions up would be wrong (#86):
 * - **before its first reported balance**, its history is what it had before it was linked
 *   (imported or entered, D5): computed from its own transactions and entered balances only, and
 *   never rewritten from the bank's. Synced transactions there add nothing, so a new connected
 *   account's history starts at its first sync;
 * - **from then on**, reported balances win and carry forward between syncs: nothing is computed;
 * - **once disconnected** (D14), its balance follows its transactions again, from the last
 *   reported one.
 * One computed snapshot per day with transactions; days in between carry forward (ADR 0011).
 * Runs in the caller's transaction, as an owner of the account (they see all its transactions).
 */
export async function recomputeBalances(tx: Executor, accountId: string): Promise<void> {
  const [account] = await tx
    .select({
      householdId: accounts.householdId,
      mode: accounts.balanceMode,
      connectionId: accounts.connectionId,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  await tx
    .delete(balanceSnapshots)
    .where(and(eq(balanceSnapshots.accountId, accountId), eq(balanceSnapshots.source, 'computed')));
  if (!account || account.mode !== 'transactions') return;

  const { rows: days } = await tx.execute<{ day: string; total: string; own: string | null }>(sql`
    SELECT effective_date::text AS day, sum(amount_minor)::text AS total,
           (sum(amount_minor) FILTER (WHERE source <> 'provider'))::text AS own
    FROM transactions
    WHERE account_id = ${accountId} AND deleted_at IS NULL AND has_splits = false
    GROUP BY effective_date ORDER BY effective_date`);
  if (days.length === 0) return;

  const anchors = (
    await tx
      .select({
        asOf: balanceSnapshots.asOf,
        amount: balanceSnapshots.balanceMinor,
        source: balanceSnapshots.source,
      })
      .from(balanceSnapshots)
      .where(
        and(eq(balanceSnapshots.accountId, accountId), ne(balanceSnapshots.source, 'computed')),
      )
      .orderBy(asc(balanceSnapshots.asOf))
  ).map((a) => ({ asOf: a.asOf, amount: BigInt(a.amount), source: a.source }));
  const reported = anchors.filter((a) => a.source === 'provider');
  const firstReported = reported[0]?.asOf;
  const lastReported = reported.at(-1)?.asOf;

  // Before the first reported balance: its own (non-synced) transactions and entered balances.
  const computed = computeDays(
    accountId,
    days
      .filter((d) => d.own !== null && (firstReported === undefined || d.day < firstReported))
      .map((d) => ({ day: d.day, total: BigInt(d.own!) })),
    anchors.filter((a) => firstReported === undefined || a.asOf < firstReported),
  );
  // Disconnected: every transaction after the last reported balance moves it.
  if (account.connectionId === null && lastReported !== undefined) {
    computed.push(
      ...computeDays(
        accountId,
        days
          .filter((d) => d.day > lastReported)
          .map((d) => ({ day: d.day, total: BigInt(d.total) })),
        anchors.filter((a) => a.asOf >= lastReported),
      ),
    );
  }
  if (computed.length) {
    await tx.insert(balanceSnapshots).values(
      computed.map((c) => ({
        accountId,
        householdId: account.householdId,
        asOf: c.asOf,
        balanceMinor: c.balanceMinor,
        source: 'computed' as const,
      })),
    );
  }
}

/** The balance on each day with transactions that isn't an anchor's, from those anchors. */
function computeDays(
  accountId: string,
  flows: Flow[],
  anchors: Anchor[],
): { asOf: string; balanceMinor: number }[] {
  const anchorDays = new Set(anchors.map((a) => a.asOf));
  /** Sum of transactions on days in (after, upTo]. */
  const between = (after: string | null, upTo: string) =>
    flows
      .filter((f) => (after === null || f.day > after) && f.day <= upTo)
      .reduce((sum, f) => sum + f.total, 0n);

  const out: { asOf: string; balanceMinor: number }[] = [];
  for (const { day } of flows) {
    if (anchorDays.has(day)) continue;
    const before = anchors.filter((a) => a.asOf <= day).at(-1);
    const after = anchors.find((a) => a.asOf > day);
    const balance = before
      ? before.amount + between(before.asOf, day)
      : after
        ? after.amount - between(day, after.asOf)
        : between(null, day);
    if (balance > BigInt(Number.MAX_SAFE_INTEGER) || balance < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`Balance of ${accountId} on ${day} is out of range`);
    }
    out.push({ asOf: day, balanceMinor: Number(balance) });
  }
  return out;
}
