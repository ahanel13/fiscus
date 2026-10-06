// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './csv.js';
import {
  applyMapping,
  chunkRowsByDate,
  guessAccountType,
  inferCategoryKind,
  suggestMapping,
} from './mapping.js';
import { isMonarchBalances, isMonarchTransactions, readMonarch } from './monarch.js';
import { detectDateFormat, detectDecimalSeparator, parseAmount, parseDate } from './values.js';

describe('parseCsv', () => {
  it('reads quotes, embedded line breaks, CRLF, a BOM, and blank lines', () => {
    const t = parseCsv(
      '﻿Date,Notes,Amount\r\n2026-01-02,"two\nlines, and ""quotes""",-1.00\r\n\r\n2026-01-03,,2\n',
    );
    expect(t.headers).toEqual(['Date', 'Notes', 'Amount']);
    expect(t.rows).toEqual([
      ['2026-01-02', 'two\nlines, and "quotes"', '-1.00'],
      ['2026-01-03', '', '2'],
    ]);
    // The second record starts on line 4: the first one spans lines 2–3.
    expect(t.lines).toEqual([2, 5]);
  });

  it('detects semicolons and tabs, and pads short rows', () => {
    expect(parseCsv('a;b;c\n1;2').rows).toEqual([['1', '2', '']]);
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t');
  });

  it('reports an unclosed quote with its line', () => {
    expect(() => parseCsv('a,b\n1,"open')).toThrow(CsvError);
  });
});

describe('dates and amounts', () => {
  it('parses real dates only', () => {
    expect(parseDate('10/06/2026', 'mdy')).toBe('2026-10-06');
    expect(parseDate('06/10/2026', 'dmy')).toBe('2026-10-06');
    expect(parseDate('2026-10-06T12:00:00', 'ymd')).toBe('2026-10-06');
    expect(parseDate('Oct 6, 2026', 'text')).toBe('2026-10-06');
    expect(parseDate('6 October 2026', 'text')).toBe('2026-10-06');
    expect(parseDate('31/02/2026', 'dmy')).toBeNull();
    expect(parseDate('13/01/2026', 'mdy')).toBeNull();
  });

  it('asks month-first or day-first only when both fit', () => {
    expect(detectDateFormat(['01/02/2026', '03/04/2026'])).toEqual({
      formats: ['mdy', 'dmy'],
      ambiguous: true,
    });
    expect(detectDateFormat(['01/02/2026', '03/14/2026'])).toEqual({
      formats: ['mdy'],
      ambiguous: false,
    });
  });

  it('parses amounts to minor units without floats', () => {
    expect(parseAmount('$1,234.56', '.', 2)).toBe(123456);
    expect(parseAmount('(12.50)', '.', 2)).toBe(-1250);
    expect(parseAmount('12.50-', '.', 2)).toBe(-1250);
    expect(parseAmount('1.234,56 €', ',', 2)).toBe(123456);
    expect(parseAmount('0.1', '.', 2)).toBe(10);
    expect(parseAmount('19.99', '.', 2)).toBe(1999); // 19.99 * 100 is 1998.9999… as a float
    expect(parseAmount('1500', '.', 0)).toBe(1500);
    expect(parseAmount('1.005', '.', 2)).toBeNull();
    expect(parseAmount('abc', '.', 2)).toBeNull();
    expect(parseAmount('-0.00', '.', 2)).toBe(0);
  });

  it('detects the decimal separator', () => {
    expect(detectDecimalSeparator(['1,234.56', '-12.00'])).toBe('.');
    expect(detectDecimalSeparator(['1.234,56', '-12,00'])).toBe(',');
  });
});

describe('CSV mapping', () => {
  const file = parseCsv(
    'Posting Date,Description,Debit,Credit\n10/01/2026,COFFEE,4.50,\n10/02/2026,PAYROLL,,"2,000.00"\n10/32/2026,BAD,1,\n',
  );

  it('suggests a mapping from headers and data', () => {
    expect(suggestMapping(file)).toMatchObject({
      date: 'Posting Date',
      dateFormat: 'mdy',
      description: 'Description',
      amount: { kind: 'split', debit: 'Debit', credit: 'Credit' },
      decimal: '.',
    });
  });

  it('reads rows and reports the ones it can’t, by line', () => {
    const { transactions, problems } = applyMapping(
      file,
      {
        date: 'Posting Date',
        dateFormat: 'mdy',
        description: 'Description',
        amount: { kind: 'split', debit: 'Debit', credit: 'Credit' },
        decimal: '.',
      },
      { exponent: 2, account: 'main' },
    );
    expect(transactions.map((t) => [t.line, t.date, t.amountMinor, t.account])).toEqual([
      [2, '2026-10-01', -450, 'main'],
      [3, '2026-10-02', 200000, 'main'],
    ]);
    expect(problems).toEqual([{ line: 4, message: expect.stringContaining('10/32/2026') }]);
  });

  it('flips the sign for banks that show spending as positive', () => {
    const t = parseCsv('Date,Amount,Memo\n2026-10-01,4.50,COFFEE');
    const { transactions } = applyMapping(
      t,
      {
        date: 'Date',
        dateFormat: 'ymd',
        description: 'Memo',
        amount: { kind: 'signed', column: 'Amount', negate: true },
        decimal: '.',
      },
      { exponent: 2, account: 'main' },
    );
    expect(transactions[0]!.amountMinor).toBe(-450);
  });

  it('guesses account types and category kinds', () => {
    expect(guessAccountType('Tacoma Auto Loan')).toBe('loan');
    expect(guessAccountType('Toyota Tacoma TRD Pro')).toBe('vehicle');
    expect(guessAccountType('Auto Roth IRA')).toBe('investment');
    expect(guessAccountType('Blue Cash Preferred® ')).toBe('credit');
    expect(guessAccountType('SoFi Checking')).toBe('depository');
    expect(guessAccountType('Wedding', [-100, -200])).toBe('credit');
    expect(inferCategoryKind('Credit Card Payment', [-5])).toBe('transfer');
    expect(inferCategoryKind('Paychecks', [100, 200])).toBe('income');
    expect(inferCategoryKind('Groceries', [-100, 20])).toBe('flexible');
  });
});

describe('Monarch export', () => {
  // Made-up rows in the format of a real export (October 2026).
  const transactions = parseCsv(
    [
      'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id',
      '2026-10-05,Harmons,Groceries,Blue Cash Preferred® ,HARMONS,,-97.55,,Shared,,1001',
      '2026-10-05,Harmons,Groceries,Blue Cash Preferred® ,HARMONS,,-97.55,,Shared,,1002',
      '2026-10-04,Payroll,Paychecks,SoFi Checking,,"line one\nline two",2500.00,"Work, Taxes",Bea,Needs Review,1003',
    ].join('\n'),
  );
  const balances = parseCsv(
    [
      'Date,Balance,Account',
      '2026-10-04,100.00,SoFi Checking',
      '2026-10-05,2600.00,SoFi Checking',
      '2024-01-30,5.00,Old Savings',
      '2024-01-31,0.40,Old Savings',
    ].join('\n'),
  );

  it('recognizes both files', () => {
    expect(isMonarchTransactions(transactions.headers)).toBe(true);
    expect(isMonarchBalances(balances.headers)).toBe(true);
    expect(isMonarchBalances(transactions.headers)).toBe(false);
  });

  it('maps every column', () => {
    const m = readMonarch({ transactions, balances }, 2);
    expect(m.problems).toEqual([]);
    expect(m.transactions[2]).toEqual({
      line: 4,
      account: 'SoFi Checking',
      date: '2026-10-04',
      amountMinor: 250000,
      description: 'Payroll', // no original statement: the merchant
      name: 'Payroll',
      category: 'Paychecks',
      tags: ['Work', 'Taxes'],
      note: 'line one\nline two',
      externalId: '1003',
      reviewed: false,
      owner: 'Bea',
    });
    // Identical rows stay apart through Monarch's id; blank Reviewed means reviewed.
    expect(m.transactions.slice(0, 2).map((t) => [t.account, t.externalId, t.reviewed])).toEqual([
      ['Blue Cash Preferred®', '1001', true],
      ['Blue Cash Preferred®', '1002', true],
    ]);
    expect(m.owners).toEqual(['Bea']);
  });

  it('summarizes accounts from both files and infers closed ones', () => {
    const m = readMonarch({ transactions, balances }, 2);
    expect(
      m.accounts.map((a) => [a.key, a.suggestedType, a.suggestedMode, a.closeOn, a.closedAtZero]),
    ).toEqual([
      ['Blue Cash Preferred®', 'credit', 'transactions', null, false],
      ['Old Savings', 'depository', 'value', '2024-02-01', true],
      ['SoFi Checking', 'depository', 'transactions', null, false],
    ]);
  });
});

describe('chunkRowsByDate', () => {
  it('fills parts up to the size, sorted by date, without splitting a day', () => {
    const rows = ['2026-01-02', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-02'].map(
      (date, line) => ({ date, line }),
    );
    expect(chunkRowsByDate(rows, 2).map((p) => p.map((r) => r.date))).toEqual([
      ['2026-01-01'],
      ['2026-01-02', '2026-01-02', '2026-01-02'], // a day larger than a part stays whole
      ['2026-01-03'],
    ]);
  });
});
