// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account, CategoryGroup, MonarchAccount } from '@fiscus/shared';
import { parseCsv } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import {
  classifyFile,
  previewRequest,
  readCsvFile,
  suggestAccounts,
  suggestCategories,
  summarize,
} from './import.js';

const found = (key: string, extra: Partial<MonarchAccount> = {}): MonarchAccount => ({
  key,
  transactions: 3,
  firstDate: '2026-01-01',
  lastDate: '2026-02-01',
  balances: 0,
  lastBalanceDate: null,
  lastBalanceMinor: null,
  suggestedType: 'depository',
  suggestedMode: 'transactions',
  closeOn: null,
  closedAtZero: false,
  duplicateOf: null,
  ...extra,
});
const account = (id: string, name: string, extra: Partial<Account> = {}) =>
  ({ id, name, yourAccess: 'owner', closedAt: null, ...extra }) as Account;

describe('import wizard logic', () => {
  it('recognizes Monarch files and bank files', () => {
    expect(classifyFile(parseCsv('Date,Merchant,Category,Account,Amount\n'))).toBe(
      'monarch-transactions',
    );
    expect(classifyFile(parseCsv('Date,Balance,Account\n'))).toBe('monarch-balances');
    expect(classifyFile(parseCsv('Posting Date,Description,Amount\n'))).toBe('csv');
  });

  it('suggests existing accounts you own by name, and ticks closing only near zero', () => {
    const choices = suggestAccounts(
      [
        found('SoFi Checking'),
        found('Old Savings', { closeOn: '2024-02-01', closedAtZero: true }),
        found('Truck', { closeOn: '2024-09-09', closedAtZero: false, suggestedType: 'vehicle' }),
        found('Partner card'),
        found('SAVINGS', { transactions: 0, duplicateOf: 'SAVINGS (...2124)' }),
      ],
      [account('a1', 'sofi checking'), account('a2', 'Partner card', { yourAccess: 'full' })],
    );
    expect(choices.map((c) => [c.key, c.mode, c.accountId, c.close, c.closeOn])).toEqual([
      ['SoFi Checking', 'existing', 'a1', false, null],
      ['Old Savings', 'new', null, true, '2024-02-01'],
      ['Truck', 'new', null, false, '2024-09-09'],
      // Only accounts you own can take imports.
      ['Partner card', 'new', null, false, null],
      // A second copy of another account is left out.
      ['SAVINGS', 'skip', null, false, null],
    ]);
  });

  it('matches categories by name or system category, most used first', () => {
    const groups = [
      {
        id: 'g',
        name: 'Food',
        kind: 'flexible',
        sortOrder: 1,
        categories: [
          {
            id: 'c1',
            groupId: 'g',
            name: 'Groceries',
            icon: null,
            systemKey: null,
            archived: false,
            sortOrder: 1,
          },
          {
            id: 'c2',
            groupId: 'g',
            name: 'Not sure',
            icon: null,
            systemKey: 'uncategorized',
            archived: false,
            sortOrder: 2,
          },
        ],
      },
    ] as CategoryGroup[];
    const row = (category: string) => ({
      line: 2,
      account: 'x',
      date: '2026-01-01',
      amountMinor: -1,
      description: 'x',
      category,
    });
    const choices = suggestCategories(
      [row('groceries'), row('Uncategorized'), row('Coffee Beans'), row('Coffee Beans')],
      groups,
    );
    expect(choices.map((c) => [c.name, c.count, c.categoryId, c.kind])).toEqual([
      ['Coffee Beans', 2, null, 'flexible'],
      ['groceries', 1, 'c1', 'flexible'],
      ['Uncategorized', 1, 'c2', 'flexible'],
    ]);
    const income = suggestCategories([{ ...row('Dividends'), amountMinor: 500 }], groups);
    expect(income[0]!.kind).toBe('income');
    // A mapping chosen in an earlier import wins over a new category.
    const again = suggestCategories([row('Coffee Beans')], groups, { 'coffee beans': 'c1' });
    expect(again[0]).toMatchObject({ categoryId: 'c1', remembered: true });
  });

  it('builds the preview request from the choices', () => {
    const file = {
      name: 'bank.csv',
      kind: 'csv' as const,
      table: parseCsv('Date,Memo,Amount\n2026-01-02,COFFEE,-4.50\n'),
    };
    const rows = readCsvFile(
      file,
      {
        date: 'Date',
        dateFormat: 'ymd',
        description: 'Memo',
        amount: { kind: 'signed', column: 'Amount', negate: false },
        decimal: '.',
      },
      2,
    );
    expect(rows.monarchAccounts.map((a) => a.key)).toEqual(['This file']);
    const accounts = suggestAccounts(rows.monarchAccounts, [account('a1', 'Checking')]);
    accounts[0] = { ...accounts[0]!, mode: 'existing', accountId: 'a1' };
    const body = previewRequest(
      { format: 'csv', filename: 'bank.csv', accounts, categories: [], members: [] },
      rows,
      [2],
    );
    expect(body).toMatchObject({
      accounts: [{ key: 'This file', accountId: 'a1' }],
      transactions: [{ line: 2, account: 'This file', amountMinor: -450 }],
      includeOverlaps: [2],
    });
  });

  it('summarizes only what’s there', () => {
    expect(summarize({ new: 1204, duplicates: 38, overlaps: 3, skipped: 0, errors: 0 })).toBe(
      '1,204 new transactions, 38 already imported, 3 possible duplicates',
    );
    expect(summarize({ new: 1, duplicates: 0, overlaps: 0, skipped: 0, errors: 0 })).toBe(
      '1 new transaction',
    );
  });
});
