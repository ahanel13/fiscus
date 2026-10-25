// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TransactionFieldChange, TransactionHistoryEntry } from '@fiscus/shared';
import { formatMoney } from '@fiscus/shared';
import { andList } from './transfers.js';

// A transaction's history in plain words (TXN-11, #46): "Ada changed the category from Groceries
// to Coffee", "Rule Coffee set the category to Coffee", "Imported from Monarch".

export interface HistoryNames {
  /** The viewer's own member id: their changes read "You …". */
  you: string | undefined;
  category: (id: string) => string | undefined;
  tag: (id: string) => string | undefined;
  member: (id: string) => string | undefined;
  account: (id: string) => string | undefined;
  currency: string;
  /** A calendar date as the viewer reads it. */
  date: (iso: string) => string;
}

const FORMATS: Record<string, string> = {
  monarch: 'Monarch',
  csv: 'a CSV file',
  ofx: 'an OFX file',
  qfx: 'a QFX file',
};

const UNLINK_CAUSES: Record<string, string> = {
  deleted: 'when its other side was deleted',
  reverted: 'when its other side’s import was undone',
  moved: 'when both sides ended up in one account',
  bank_changed: 'when the bank changed an amount',
};

/** Who did it, as the subject of a sentence. */
export function historySubject(entry: TransactionHistoryEntry, names: HistoryNames): string {
  const { actor } = entry;
  switch (actor.kind) {
    case 'member':
      return actor.memberId && actor.memberId === names.you ? 'You' : actor.label;
    case 'rule': {
      const named = actor.rules.flatMap((r) => (r.name ? [r.name] : []));
      if (named.length === 0) return 'A rule';
      return `${named.length > 1 ? 'Rules' : 'Rule'} ${andList(named)}`;
    }
    case 'bank':
      return 'The bank';
    case 'import':
      return 'An import';
    default:
      return 'Fiscus';
  }
}

/** One sentence for one entry. */
export function historyLine(entry: TransactionHistoryEntry, names: HistoryNames): string {
  const who = historySubject(entry, names);
  const yours = who === 'You' ? 'your' : 'their';
  const { detail } = entry;
  switch (entry.action) {
    case 'import.rows_added':
      return detail.format && FORMATS[detail.format]
        ? `Imported from ${FORMATS[detail.format]}`
        : 'Imported';
    case 'import.reverted':
      return `${who} undid its import`;
    case 'sync.transactions_added':
      return 'Came in from the bank';
    case 'sync.transactions_matched':
      return 'Matched to the bank’s copy of it, keeping everything here';
    // A possible duplicate a person decided (#80, D7).
    case 'transaction.matched_to_bank':
      return `${who} matched it to the bank’s copy, keeping everything here`;
    case 'transaction.added_from_bank':
      return `Came in from the bank once ${who === 'You' ? 'you' : who} said it’s not one already here`;
    case 'transaction.provider_removed':
      return detail.kept
        ? 'The bank no longer lists it, so it stays here without syncing'
        : 'The bank removed it';
    case 'transaction.posted': {
      // Pending → posted (#88): the same transaction, now as the bank posted it.
      const phrases = entry.changes.flatMap((c) => phrase(c, names) ?? []);
      return `${who} ${andList(['posted it', ...phrases])}`;
    }
    case 'transaction.created':
      return detail.otherSide
        ? `${who} recorded it as the other side of a transfer`
        : `${who} added it`;
    case 'transaction.deleted':
      return `${who} deleted it`;
    case 'transaction.split':
      return detail.parts ? `${who} split it into ${detail.parts} parts` : `${who} split it`;
    case 'transaction.unsplit':
      return `${who} removed the split`;
    case 'transaction.transfer_linked':
      return `${who} linked it as a transfer`;
    case 'transaction.transfer_unlinked':
      return detail.cause && UNLINK_CAUSES[detail.cause]
        ? `The transfer was unlinked ${UNLINK_CAUSES[detail.cause]}`
        : `${who} unlinked the transfer`;
    case 'transaction.moved_in': {
      const to = detail.accountId && names.account(detail.accountId);
      return to ? `${who} moved it to ${to}` : `${who} moved it to another account`;
    }
    case 'transaction.shared_note_set':
      return `${who} changed the shared note`;
    case 'transaction.shared_note_deleted':
      return `${who} removed the shared note`;
    case 'transaction.mine_note_set':
      return `${who} changed ${yours} own note`;
    case 'transaction.mine_note_deleted':
      return `${who} removed ${yours} own note`;
    default: {
      const phrases = entry.changes.flatMap((c) => phrase(c, names) ?? []);
      const what = phrases.length ? andList(phrases) : 'changed it';
      return detail.bulk ? `${who} ${what}, with other transactions` : `${who} ${what}`;
    }
  }
}

function phrase(c: TransactionFieldChange, n: HistoryNames): string | null {
  const has = (v: unknown) => v !== undefined && v !== null;
  const fromTo = (label: string, show: (v: unknown) => string) =>
    has(c.from) && has(c.to)
      ? `changed the ${label} from ${show(c.from)} to ${show(c.to)}`
      : has(c.to)
        ? `set the ${label} to ${show(c.to)}`
        : `cleared the ${label}`;
  const category = (v: unknown) => n.category(String(v)) ?? 'a category that’s gone';
  const tagList = (v: unknown) =>
    andList(((v as string[] | undefined) ?? []).map((id) => n.tag(id) ?? 'a removed tag'));
  const tagCount = (v: unknown) => ((v as unknown[] | undefined) ?? []).length;
  switch (c.field) {
    case 'categoryId':
      return fromTo('category', category);
    case 'displayName':
      return has(c.from) && has(c.to)
        ? `renamed it from ${String(c.from)} to ${String(c.to)}`
        : has(c.to)
          ? `renamed it to ${String(c.to)}`
          : 'cleaned up the name';
    case 'amountMinor':
      return fromTo('amount', (v) => formatMoney(Number(v), n.currency));
    case 'date':
      return has(c.to)
        ? has(c.from)
          ? `moved it from ${n.date(String(c.from))} to ${n.date(String(c.to))}`
          : `moved it to ${n.date(String(c.to))}`
        : 'set it back to the bank’s date';
    case 'reviewStatus':
      return c.to === 'reviewed' ? 'marked it reviewed' : 'marked it for review';
    case 'pending':
      return c.to ? 'marked it pending' : 'posted it';
    case 'excluded':
      return c.to
        ? 'left it out of reports and budgets'
        : 'brought it back into reports and budgets';
    case 'isBusiness':
      return c.to ? 'marked it as business' : 'marked it as personal';
    case 'transferExternal':
      return c.to
        ? 'marked it as a transfer to an account outside Fiscus'
        : 'unmarked it as a transfer outside Fiscus';
    case 'tagIds':
      return tagCount(c.to) ? `set the tags to ${tagList(c.to)}` : 'removed its tags';
    case 'addTagIds':
      return `added the ${tagCount(c.to) > 1 ? 'tags' : 'tag'} ${tagList(c.to)}`;
    case 'removeTagIds':
      return `removed the ${tagCount(c.to) > 1 ? 'tags' : 'tag'} ${tagList(c.to)}`;
    case 'attribution': {
      const to = (c.to as (string | { memberId: string })[] | undefined) ?? [];
      if (to.length === 0) return 'set who it’s for back to the account’s owners';
      const ids = to.map((a) => (typeof a === 'string' ? a : a.memberId));
      const who = ids.map((id) => (id === n.you ? 'you' : (n.member(id) ?? 'a former member')));
      return `said it’s for ${andList(who)}`;
    }
    case 'transfer':
      return c.to === 'link'
        ? 'linked it as a transfer'
        : c.to === 'record'
          ? 'recorded its other side'
          : 'marked it as a transfer, waiting for its other side';
    default:
      return null;
  }
}
