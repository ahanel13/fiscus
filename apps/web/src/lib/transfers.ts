// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Transaction, TransferReview } from '@fiscus/shared';

// Words in account names too common to say which account a transfer names.
const COMMON = new Set([
  'account',
  'accounts',
  'and',
  'bank',
  'balance',
  'card',
  'credit',
  'from',
  'the',
  'transfer',
  'vault',
]);

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

/**
 * The word of `account`'s name that `text` mentions, if any: "From Holiday Vault" names an account
 * called Holiday, "From Checking Balance" one called Ally Checking.
 */
export function namedAccount(text: string, account: string | undefined): string | null {
  if (!account) return null;
  const said = new Set(words(text));
  const word = words(account).find((w) => !COMMON.has(w) && !/^\d+$/.test(w) && said.has(w));
  if (!word) return null;
  return account.match(new RegExp(word, 'iu'))?.[0] ?? word;
}

/**
 * The one candidate the names point to, and the account they name, or null. First a candidate
 * whose name says where it came from ("From Holiday Vault"), then one `out`'s name says it went to
 * ("To Roof Vault"), each only when it singles one out. It ranks the review; a person still
 * confirms it, since banks word transfers in many ways.
 */
export function likelyOtherSide(
  out: Transaction,
  candidates: Transaction[],
): { id: string; named: string } | null {
  if (candidates.length < 2) return null;
  for (const hint of [
    (c: Transaction) => namedAccount(c.displayName, out.account?.name),
    (c: Transaction) => namedAccount(out.displayName, c.account?.name),
  ]) {
    const hinted = candidates.flatMap((c) => {
      const named = hint(c);
      return named ? [{ id: c.id, named }] : [];
    });
    if (hinted.length === 1) return hinted[0]!;
  }
  return null;
}

/**
 * The review without transactions just linked or settled, so they leave the list at once; the
 * refetch that follows brings in anything they unblocked.
 */
export function withoutTransactions(review: TransferReview, ids: Set<string>): TransferReview {
  const suggested = review.suggested
    .filter((s) => !ids.has(s.transaction.id))
    .map((s) => ({ ...s, candidates: s.candidates.filter((c) => !ids.has(c.id)) }))
    .filter((s) => s.candidates.length > 0);
  const unmatched = review.unmatched.filter((t) => !ids.has(t.id));
  const goneUnique = review.suggested.filter(
    (s) => s.unique && !suggested.some((x) => x.transaction.id === s.transaction.id),
  ).length;
  return {
    suggested,
    unmatched,
    counts: {
      suggested: review.counts.suggested - (review.suggested.length - suggested.length),
      unmatched: review.counts.unmatched - (review.unmatched.length - unmatched.length),
      unique: Math.max(0, review.counts.unique - goneUnique),
    },
  };
}
