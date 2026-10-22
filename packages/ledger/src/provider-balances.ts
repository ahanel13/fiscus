// SPDX-License-Identifier: AGPL-3.0-or-later
import { accountLiabilities, accounts, balanceSnapshots, type Executor } from '@fiscus/db';
import type { ProviderBalance, ProviderLiability } from '@fiscus/domain';
import { todayIn } from '@fiscus/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { recomputeBalances } from './balances.js';
import { householdRanges } from './ranges.js';

// What a sync reports about a connection's accounts besides transactions (#86): balances, and a
// card's or loan's statement details. The worker calls these for each sync (#80), in the
// household's system context.

export interface ProviderWriteResult {
  /** Accounts written. */
  written: number;
  /**
   * Reported for an account that isn't tracked here (not linked, "Don't track", or another
   * connection's), or in a currency other than the account's: left out.
   */
  skipped: number;
}

/** The connection's tracked accounts, by the provider's account id. */
async function trackedAccounts(tx: Executor, connectionId: string, providerIds: string[]) {
  const rows =
    providerIds.length === 0
      ? []
      : await tx
          .select({
            id: accounts.id,
            householdId: accounts.householdId,
            providerAccountId: accounts.providerAccountId,
            type: accounts.type,
            currency: accounts.currency,
          })
          .from(accounts)
          .where(
            and(
              eq(accounts.connectionId, connectionId),
              inArray(accounts.providerAccountId, [...new Set(providerIds)]),
            ),
          );
  return new Map(rows.map((r) => [r.providerAccountId!, r]));
}

/**
 * The day a reported balance counts for: the provider's balance date, in the household's time
 * zone (ADR 0011), never after today there. A date without a time is taken as it is.
 */
export function providerBalanceDay(asOf: string, timeZone: string, today: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : todayIn(timeZone, new Date(asOf));
  return day > today ? today : day;
}

/**
 * Writes each tracked account's reported balance as `balance_snapshots(source = provider)`, with
 * its available balance and credit limit: one per account per day, so a later sync that day
 * replaces it, as it does a balance entered or computed for that day (from the first reported
 * balance on, the bank's wins). Then rebuilds the account's computed balances, which keep its
 * history from before it was linked (D5).
 */
export async function writeProviderBalances(
  tx: Executor,
  connectionId: string,
  balances: ProviderBalance[],
): Promise<ProviderWriteResult> {
  const tracked = await trackedAccounts(
    tx,
    connectionId,
    balances.map((b) => b.providerAccountId),
  );
  const zones = new Map<string, { timeZone: string; today: string }>();
  const touched = new Set<string>();
  let skipped = 0;
  for (const b of balances) {
    const account = tracked.get(b.providerAccountId);
    if (!account || account.currency !== b.currency) {
      skipped += 1;
      continue;
    }
    let zone = zones.get(account.householdId);
    if (!zone) {
      const ranges = await householdRanges(tx, account.householdId);
      zone = { timeZone: ranges.settings.timeZone, today: ranges.today };
      zones.set(account.householdId, zone);
    }
    const values = {
      balanceMinor: b.currentMinor,
      availableMinor: b.availableMinor ?? null,
      creditLimitMinor: b.creditLimitMinor ?? null,
      source: 'provider' as const,
      importBatchId: null,
    };
    await tx
      .insert(balanceSnapshots)
      .values({
        accountId: account.id,
        householdId: account.householdId,
        asOf: providerBalanceDay(b.asOf, zone.timeZone, zone.today),
        ...values,
      })
      .onConflictDoUpdate({
        target: [balanceSnapshots.accountId, balanceSnapshots.asOf],
        set: { ...values, updatedAt: sql`now()` },
      });
    touched.add(account.id);
  }
  for (const accountId of touched) await recomputeBalances(tx, accountId);
  return { written: touched.size, skipped };
}

/**
 * Writes the statement details of the connection's tracked credit and loan accounts, replacing
 * what the last sync wrote (a detail the provider no longer reports is cleared). Reports for other
 * kinds of account are skipped.
 */
export async function writeProviderLiabilities(
  tx: Executor,
  connectionId: string,
  liabilities: ProviderLiability[],
): Promise<ProviderWriteResult> {
  const tracked = await trackedAccounts(
    tx,
    connectionId,
    liabilities.map((l) => l.providerAccountId),
  );
  const written = new Set<string>();
  let skipped = 0;
  for (const l of liabilities) {
    const account = tracked.get(l.providerAccountId);
    if (
      !account ||
      account.currency !== l.currency ||
      (account.type !== 'credit' && account.type !== 'loan')
    ) {
      skipped += 1;
      continue;
    }
    const values = {
      aprBps: l.aprBps ?? null,
      minimumPaymentMinor: l.minimumPaymentMinor ?? null,
      nextDueDate: l.nextPaymentDueDate ?? null,
      lastStatementBalanceMinor: l.lastStatementBalanceMinor ?? null,
      lastStatementDate: l.lastStatementDate ?? null,
    };
    await tx
      .insert(accountLiabilities)
      .values({ accountId: account.id, householdId: account.householdId, ...values })
      .onConflictDoUpdate({
        target: accountLiabilities.accountId,
        set: { ...values, updatedAt: sql`now()` },
      });
    written.add(account.id);
  }
  return { written: written.size, skipped };
}
