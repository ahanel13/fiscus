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

type Suggestion = TransferReview['suggested'][number];

/** Suggested pairs from one account to another (#332), with the ones a single click can link. */
export interface SuggestionGroup {
  key: string;
  from: string;
  /** Null when the suggestions in it point to more than one account. */
  to: string | null;
  items: Suggestion[];
  /**
   * The pairs "Link N" links: clear ones (one match either way, or identical transfers in step)
   * and ones a hint points to (the names, or the closest date both ways). Each money-out leg gets
   * its own other side.
   */
  ready: { out: string; into: string }[];
}

const accountName = (t: Transaction) => t.account?.name ?? 'another account';

/** What points to one candidate: the names, or the closest date both ways. */
export interface Hint {
  id: string;
  /** "names Holiday", or "closest date". */
  label: string;
}

const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** The one item of `items` strictly closest to `date`, or null on a tie. */
function closest<T>(items: T[], date: (t: T) => string, to: string): T | null {
  let best: T | null = null;
  let gap = Infinity;
  let tie = false;
  for (const item of items) {
    const g = dayGap(date(item), to);
    if (g < gap) [best, gap, tie] = [item, g, false];
    else if (g === gap) tie = true;
  }
  return tie ? null : best;
}

/**
 * The candidate each suggestion's hints point to (#332): first the names (likelyOtherSide), then
 * the closest date, when it's closest both ways. A recurring transfer ($10 to investing every few
 * days) has several same-amount candidates within the window, but each deposit's own transfer is
 * the one nearest to it, and it nearest to that one. A person still confirms it.
 */
export function hints(list: Suggestion[]): Map<string, Hint> {
  const out = new Map<string, Hint>();
  // Each candidate's possible transfers out, across the review.
  const outsOf = new Map<string, Transaction[]>();
  for (const s of list) {
    for (const c of s.candidates) outsOf.set(c.id, [...(outsOf.get(c.id) ?? []), s.transaction]);
  }
  for (const s of list) {
    const named = likelyOtherSide(s.transaction, s.candidates);
    if (named) {
      out.set(s.transaction.id, { id: named.id, label: `names ${named.named}` });
      continue;
    }
    if (s.candidates.length < 2) continue;
    const near = closest(s.candidates, (c) => c.date, s.transaction.date);
    if (!near) continue;
    const back = closest(outsOf.get(near.id) ?? [], (o) => o.date, near.date);
    if (back?.id === s.transaction.id)
      out.set(s.transaction.id, { id: near.id, label: 'closest date' });
  }
  return out;
}

/**
 * The review's suggestions by account pair, the biggest group first, so a large import reads as
 * "SoFi Checking → House: 12" rather than 173 cards.
 */
export function groupSuggestions(list: Suggestion[]): SuggestionGroup[] {
  const groups = new Map<string, SuggestionGroup & { used: Set<string> }>();
  const hinted = hints(list);
  for (const s of list) {
    const out = s.transaction;
    const likely = hinted.get(out.id) ?? null;
    const intoAccounts = new Set(s.candidates.map((c) => c.account?.id ?? ''));
    const pointed = likely
      ? s.candidates.find((c) => c.id === likely.id)!
      : s.unique || intoAccounts.size === 1
        ? s.candidates[0]!
        : null;
    const to = pointed ? accountName(pointed) : null;
    const key = `${out.account?.id ?? ''}→${pointed?.account?.id ?? '*'}`;
    const group = groups.get(key) ?? {
      key,
      from: accountName(out),
      to,
      items: [],
      ready: [],
      used: new Set<string>(),
    };
    group.items.push(s);
    if (s.unique || likely) {
      // Identical transfers in step share candidates: give each its own.
      const into = likely
        ? s.candidates.find((c) => c.id === likely.id)
        : s.candidates.find((c) => !group.used.has(c.id));
      if (into && !group.used.has(into.id)) {
        group.used.add(into.id);
        group.ready.push({ out: out.id, into: into.id });
      }
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ used: _used, ...g }) => g)
    .sort((a, b) => b.items.length - a.items.length);
}

/** Transfers with no other side, by account, the biggest first. */
export function groupUnmatched(
  list: Transaction[],
): { key: string; account: string; items: Transaction[] }[] {
  return [...Map.groupBy(list, (t) => t.account?.id ?? '').entries()]
    .map(([key, items]) => ({ key, account: accountName(items[0]!), items }))
    .sort((a, b) => b.items.length - a.items.length);
}
