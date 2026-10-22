// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TransactionHistoryEntry } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import { type HistoryNames, historyLine } from './transaction-history.js';

const names: HistoryNames = {
  you: 'm-you',
  category: (id) => ({ c1: 'Groceries', c2: 'Coffee' })[id],
  tag: (id) => ({ t1: 'Gifts', t2: 'Travel' })[id],
  member: (id) => ({ 'm-bea': 'Bea' })[id],
  account: (id) => ({ a1: 'Savings' })[id],
  currency: 'USD',
  date: (iso) => iso,
};

const ada = { kind: 'member', memberId: 'm-ada', label: 'Ada' } as const;
const entry = (e: Partial<TransactionHistoryEntry>): TransactionHistoryEntry => ({
  id: 'x',
  occurredAt: '2026-10-01T12:00:00Z',
  action: 'transaction.updated',
  actor: ada,
  changes: [],
  detail: {},
  ...e,
});

describe('historyLine', () => {
  it('says who changed what, in plain words', () => {
    expect(
      historyLine(entry({ changes: [{ field: 'categoryId', from: 'c1', to: 'c2' }] }), names),
    ).toBe('Ada changed the category from Groceries to Coffee');
    expect(
      historyLine(
        entry({
          actor: { kind: 'member', memberId: 'm-you', label: 'Me' },
          changes: [
            { field: 'amountMinor', from: -1200, to: -1500 },
            { field: 'reviewStatus', from: 'needs_review', to: 'reviewed' },
          ],
        }),
        names,
      ),
    ).toBe('You changed the amount from -$12.00 to -$15.00 and marked it reviewed');
  });

  it('names rules, imports, and the bank', () => {
    expect(
      historyLine(
        entry({
          action: 'transaction.rules_applied',
          actor: { kind: 'rule', rules: [{ id: 'r', name: 'Coffee' }], label: 'Rule: Coffee' },
          changes: [{ field: 'categoryId', from: null, to: 'c2' }],
        }),
        names,
      ),
    ).toBe('Rule Coffee set the category to Coffee');
    expect(
      historyLine(
        entry({
          action: 'import.rows_added',
          actor: { kind: 'import', label: 'Import' },
          detail: { format: 'monarch' },
        }),
        names,
      ),
    ).toBe('Imported from Monarch');
    expect(
      historyLine(
        entry({
          action: 'transaction.rules_applied',
          actor: { kind: 'rule', rules: [{ id: 'r', name: null }], label: 'A rule' },
          changes: [{ field: 'addTagIds', to: ['t1', 't2'] }],
        }),
        names,
      ),
    ).toBe('A rule added the tags Gifts and Travel');
    const bank = { kind: 'bank', label: 'Bank' } as const;
    expect(historyLine(entry({ action: 'sync.transactions_added', actor: bank }), names)).toBe(
      'Came in from the bank',
    );
    expect(historyLine(entry({ action: 'sync.transactions_matched', actor: bank }), names)).toBe(
      'Matched to the bank’s copy of it, keeping everything here',
    );
    expect(
      historyLine(
        entry({
          action: 'transaction.provider_updated',
          actor: bank,
          changes: [
            { field: 'amountMinor', from: -5200, to: -6100 },
            { field: 'pending', from: true, to: false },
          ],
        }),
        names,
      ),
    ).toBe('The bank changed the amount from -$52.00 to -$61.00 and posted it');
    expect(
      historyLine(
        entry({ action: 'transaction.provider_removed', actor: bank, detail: { kept: true } }),
        names,
      ),
    ).toBe('The bank no longer lists it, so it stays here without syncing');
    expect(
      historyLine(
        entry({ action: 'transaction.transfer_unlinked', detail: { cause: 'bank_changed' } }),
        names,
      ),
    ).toBe('The transfer was unlinked when the bank changed an amount');
  });

  it('describes bulk edits, splits, moves, transfers, attribution, and notes', () => {
    const line = (e: Partial<TransactionHistoryEntry>) => historyLine(entry(e), names);
    expect(
      line({
        action: 'transaction.bulk_updated',
        changes: [{ field: 'excluded', to: true }],
        detail: { bulk: true },
      }),
    ).toBe('Ada left it out of reports and budgets, with other transactions');
    expect(line({ action: 'transaction.split', detail: { parts: 3 } })).toBe(
      'Ada split it into 3 parts',
    );
    expect(line({ action: 'transaction.moved_in', detail: { accountId: 'a1' } })).toBe(
      'Ada moved it to Savings',
    );
    expect(line({ action: 'transaction.transfer_unlinked', detail: { cause: 'deleted' } })).toBe(
      'The transfer was unlinked when its other side was deleted',
    );
    expect(
      line({
        action: 'transaction.attribution_changed',
        changes: [{ field: 'attribution', to: [{ memberId: 'm-bea', shareBps: 10000 }] }],
      }),
    ).toBe('Ada said it’s for Bea');
    expect(
      line({
        action: 'transaction.mine_note_set',
        actor: { kind: 'member', memberId: 'm-you', label: 'Me' },
      }),
    ).toBe('You changed your own note');
    expect(line({ action: 'transaction.bulk_updated', changes: [{ field: 'displayName' }] })).toBe(
      'Ada cleaned up the name',
    );
  });
});
