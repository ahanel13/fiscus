// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account, CategoryGroup, MonarchAccount } from '@fiscus/shared';
import { parseCsv } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import {
  continuationGap,
  chooseAccount,
  chooseMany,
  withType,
  classifyFile,
  combinedInto,
  combineTargets,
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
  firstBalanceDate: null,
  lastBalanceDate: null,
  lastBalanceMinor: null,
  suggestedType: 'depository',
  typeFromName: true,
  suggestedMode: 'transactions',
  closeOn: null,
  closedAtZero: false,
  duplicateOf: null,
  continuedBy: null,
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
        found('Ally Checking'),
        found('Old Savings', { closeOn: '2024-02-01', closedAtZero: true }),
        found('Truck', { closeOn: '2024-09-09', closedAtZero: false, suggestedType: 'vehicle' }),
        found('Partner card'),
        found('SAVINGS', { transactions: 0, duplicateOf: 'SAVINGS (...5555)' }),
        found('Old truck', { closeOn: '2024-09-09', closedAtZero: true, continuedBy: 'Truck' }),
      ],
      [account('a1', 'ally checking'), account('a2', 'Partner card', { yourAccess: 'full' })],
    );
    expect(choices.map((c) => [c.key, c.mode, c.accountId, c.close, c.closeOn])).toEqual([
      ['Ally Checking', 'existing', 'a1', false, null],
      ['Old Savings', 'new', null, true, '2024-02-01'],
      ['Truck', 'new', null, false, '2024-09-09'],
      // Only accounts you own can take imports.
      ['Partner card', 'new', null, false, null],
      // A second copy of another account is left out.
      ['SAVINGS', 'skip', null, false, null],
      // One another account continues is combined with it, not closed.
      ['Old truck', 'combine', null, false, '2024-09-09'],
    ]);
  });

  it('lists what needs a look, and applies changes to several accounts at once', () => {
    const choices = suggestAccounts(
      [
        found('Checking'),
        found('Vacation', { typeFromName: false, closeOn: '2025-06-11', closedAtZero: true }),
        found('ALLY', { typeFromName: false, suggestedType: 'loan' }),
        found('Truck', { closeOn: '2024-09-09', closedAtZero: false }),
        found('SAVINGS', { transactions: 0, duplicateOf: 'SAVINGS (...5555)' }),
      ],
      [],
    );
    expect(choices.map((c) => [c.key, c.check])).toEqual([
      ['Checking', []],
      // Unnamed, but checking or savings is the likely answer: ready as it is.
      ['Vacation', []],
      ['ALLY', ['type_unsure']],
      ['Truck', ['closed_with_money']],
      ['SAVINGS', ['duplicate']],
    ]);
    const next = chooseMany(choices, ['Checking', 'Truck'], (c) => withType(c, 'vehicle'));
    expect(next.map((c) => [c.key, c.type, c.balanceMode])).toEqual([
      ['Checking', 'vehicle', 'transactions'], // it has transactions: they still count
      ['Vacation', 'depository', 'transactions'],
      ['ALLY', 'loan', 'transactions'],
      ['Truck', 'vehicle', 'transactions'],
      ['SAVINGS', 'depository', 'transactions'],
    ]);
  });

  it('un-combines accounts whose target stops standing on its own', () => {
    const choices = suggestAccounts(
      [found('Truck'), found('Old truck', { closeOn: '2024-09-09', continuedBy: 'Truck' })],
      [],
    );
    expect(choices[1]).toMatchObject({ mode: 'combine', sameAs: 'Truck' });
    const next = chooseAccount(choices, 'Truck', { mode: 'skip' });
    expect(next[1]).toMatchObject({ mode: 'new', sameAs: null });
    expect(
      previewRequest(
        { format: 'monarch', filename: 'x', accounts: choices, categories: [], members: [] },
        { transactions: [], balances: [], problems: [], monarchAccounts: [], owners: [] },
      ).accounts[1],
    ).toEqual({ key: 'Old truck', sameAs: 'Truck' });
  });

  it('offers to combine only with accounts whose history doesn’t overlap, similar names first', () => {
    const choices = suggestAccounts(
      [
        found('2021 Truck', {
          firstDate: null,
          lastDate: null,
          firstBalanceDate: '2024-09-09',
          lastBalanceDate: '2026-10-06',
        }),
        found('Truck', {
          firstDate: null,
          lastDate: null,
          firstBalanceDate: '2023-12-04',
          lastBalanceDate: '2024-09-08',
          closeOn: '2024-09-09',
          continuedBy: '2021 Truck',
        }),
        found('Auto loan', { firstDate: '2023-12-04', lastDate: '2024-05-19' }),
        found('Checking', { firstDate: '2022-01-01', lastDate: '2026-10-01' }),
      ],
      [],
    );
    expect(continuationGap(choices, choices[1]!)).toBe(1);
    // Truck is combined into 2021 Truck already, Checking overlaps, Auto loan doesn't.
    expect(combineTargets(choices, '2021 Truck').map((c) => c.key)).toEqual(['Auto loan']);
    expect(combinedInto(choices, '2021 Truck').map((c) => c.key)).toEqual(['Truck']);
    expect(combineTargets(choices, 'Truck').map((c) => c.key)).toEqual(['2021 Truck']); // the loan overlaps it
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
