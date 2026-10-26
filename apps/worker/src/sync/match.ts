// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, transactions } from '@fiscus/db';
import type { ProviderTransaction } from '@fiscus/domain';
import { and, inArray, isNull, sql } from 'drizzle-orm';

// "Already here" (bank connections walkthrough D7, #80): a synced transaction that is one you
// already have, imported or entered before the account was connected (D5), or one an earlier
// connection to the account brought in, which let go of its id when this one was linked (#83).

/** A provider transaction on its way into one of the connection's tracked accounts. */
export interface Arrival {
  t: ProviderTransaction;
  accountId: string;
}

/** The date the bank reports a transaction on: posted, or authorized while pending. */
export const reportedDate = (t: Pick<ProviderTransaction, 'postedDate' | 'authorizedDate'>) =>
  t.postedDate ?? t.authorizedDate;

const matchKey = (accountId: string, amountMinor: number, currency: string, date: string) =>
  `${accountId}|${amountMinor}|${currency}|${date}`;

/**
 * Splits new arrivals into exact matches and the rest. An exact match is one-to-one both ways:
 * the arrival is the only one of its kind (account, amount, currency and reported date) on its
 * page, and exactly one transaction of that kind is already in the account without a provider
 * id (not deleted, not a split part). That transaction is "already here":
 * it gets the provider's id and keeps everything you did to it (D7). A pending arrival never
 * matches: its bank removes it once it posts, and that mustn't remove yours (#88 carries pending
 * edits over).
 */
export async function matchExisting(
  tx: Executor,
  arrivals: Arrival[],
): Promise<{ attached: { arrival: Arrival; transactionId: string }[]; rest: Arrival[] }> {
  const posted = arrivals.filter((a) => !a.t.pending);
  if (posted.length === 0) return { attached: [], rest: arrivals };
  const kindOf = (a: Arrival) =>
    matchKey(a.accountId, a.t.amountMinor, a.t.currency, reportedDate(a.t));
  const byKind = Map.groupBy(posted, kindOf);
  const reported = sql<string>`coalesce(${transactions.postedDate}, ${transactions.authorizedDate})::text`;
  const existing = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      date: reported,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.accountId, [...new Set(posted.map((a) => a.accountId))]),
        inArray(transactions.amountMinor, [...new Set(posted.map((a) => a.t.amountMinor))]),
        sql`${reported} = ANY(${sql.param([...new Set(posted.map((a) => reportedDate(a.t)))])}::text[])`,
        isNull(transactions.providerTransactionId),
        isNull(transactions.deletedAt),
        isNull(transactions.parentId),
      ),
    );
  const candidates = Map.groupBy(existing, (e) =>
    matchKey(e.accountId, e.amountMinor, e.currency, e.date),
  );
  const attached: { arrival: Arrival; transactionId: string }[] = [];
  const matched = new Set<Arrival>();
  for (const [kind, list] of byKind) {
    const found = candidates.get(kind);
    if (list.length === 1 && found?.length === 1) {
      attached.push({ arrival: list[0]!, transactionId: found[0]!.id });
      matched.add(list[0]!);
    }
  }
  return { attached, rest: arrivals.filter((a) => !matched.has(a)) };
}
