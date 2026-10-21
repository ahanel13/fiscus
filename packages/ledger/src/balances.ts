// SPDX-License-Identifier: AGPL-3.0-or-later
import { accounts, balanceSnapshots, type Executor } from '@fiscus/db';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

/**
 * Rebuilds the computed balances of a manual account that follows its transactions
 * (transactions design §2). Bank-connected accounts never get computed balances. Balances people entered are anchors and always win:
 * - after an anchor: the anchor plus the transactions after it;
 * - before the first anchor: that anchor minus the transactions between the day and it;
 * - with no anchors: the running total of the transactions.
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
  // A bank-connected account's balance is whatever the bank reports: its transaction history is
  // never complete (Plaid returns ~24 months, and no opening balance), so adding transactions up
  // would be wrong. Reported balances carry forward between syncs (transactions design §2).
  if (!account || account.connectionId !== null || account.mode !== 'transactions') return;

  const { rows: days } = await tx.execute<{ day: string; total: string }>(sql`
    SELECT effective_date::text AS day, sum(amount_minor)::text AS total
    FROM transactions
    WHERE account_id = ${accountId} AND deleted_at IS NULL AND has_splits = false
    GROUP BY effective_date ORDER BY effective_date`);
  if (days.length === 0) return;

  const anchors = (
    await tx
      .select({ asOf: balanceSnapshots.asOf, amount: balanceSnapshots.balanceMinor })
      .from(balanceSnapshots)
      .where(
        and(eq(balanceSnapshots.accountId, accountId), ne(balanceSnapshots.source, 'computed')),
      )
      .orderBy(asc(balanceSnapshots.asOf))
  ).map((a) => ({ asOf: a.asOf, amount: BigInt(a.amount) }));
  const anchorDays = new Set(anchors.map((a) => a.asOf));

  const flows = days.map((d) => ({ day: d.day, total: BigInt(d.total) }));
  /** Sum of transactions on days in (after, upTo]. */
  const between = (after: string | null, upTo: string) =>
    flows
      .filter((f) => (after === null || f.day > after) && f.day <= upTo)
      .reduce((sum, f) => sum + f.total, 0n);

  const computed: { asOf: string; balanceMinor: number }[] = [];
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
    computed.push({ asOf: day, balanceMinor: Number(balance) });
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
