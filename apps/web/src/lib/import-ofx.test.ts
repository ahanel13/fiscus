// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account } from '@fiscus/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  type FileRows,
  fileErrorMessage,
  fileFormat,
  FileTooLargeError,
  type LoadedFile,
  MAX_FILE_BYTES,
  previewRequest,
  readFile,
  readOfxFile,
  rowsToSend,
  startRequest,
  statementLabel,
  suggestOfxAccounts,
  unsupportedNotices,
  type WizardChoices,
} from './import.js';

// The wizard's side of OFX and QFX (#74): the parser itself is tested in @fiscus/shared.

const fixtures = join(import.meta.dirname, '../../../../packages/shared/src/imports/fixtures');
const bytes = (name: string) => readFileSync(join(fixtures, name));
/** A File-like from a fixture, under any name. */
const file = (fixture: string, name = fixture) => {
  const b = bytes(fixture);
  return { name, size: b.length, arrayBuffer: async () => new Uint8Array(b).buffer };
};
const load = async (fixture: string, name?: string) => {
  const f = await readFile(file(fixture, name));
  if (f.kind !== 'ofx') throw new Error('not read as OFX');
  return f;
};

const account = (id: string, name: string, extra: Partial<Account> = {}) =>
  ({
    id,
    name,
    yourAccess: 'owner',
    closedAt: null,
    type: 'depository',
    mask: null,
    currency: 'USD',
    ...extra,
  }) as Account;

const choicesFor = (f: LoadedFile, accounts: WizardChoices['accounts']): WizardChoices => ({
  format: fileFormat('csv', f),
  filename: f.name,
  accounts,
  categories: [],
  members: [],
});

describe('OFX files in the import wizard', () => {
  it('recognizes OFX by its content, whatever the file is called', async () => {
    expect((await readFile(file('bank-sgml-1252.ofx', 'download.txt'))).kind).toBe('ofx');
    expect((await readFile(file('bank.qfx'))).kind).toBe('ofx');
    const csv = Buffer.from('Date,Description,Amount\n2026-01-02,COFFEE,-4.50\n');
    const notOfx = await readFile({
      name: 'statement.ofx',
      size: csv.length,
      arrayBuffer: async () => new Uint8Array(csv).buffer,
    });
    expect(notOfx.kind).toBe('csv');
    // Windows-1252 accents and curly quotes survive.
    const rows = readOfxFile(await load('bank-sgml-1252.ofx'), 'USD');
    expect(rows.transactions[0]!.description).toBe('Café Façade Joe’s “latte”');
  });

  it('refuses a file over 20 MB before reading it, for every source', async () => {
    const csv = new TextEncoder().encode('Date,Amount\n2026-01-02,-1\n');
    const arrayBuffer = vi.fn(async () => csv.buffer as ArrayBuffer);
    const huge = { name: 'Transactions.csv', size: MAX_FILE_BYTES + 1, arrayBuffer };
    const err = await readFile(huge).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileTooLargeError);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fileErrorMessage(err)).toBe(
      'This file is over 20 MB. Export a shorter period, and import each part.',
    );
    // 20 MB exactly is fine.
    await readFile({ ...huge, size: MAX_FILE_BYTES });
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it('says which line a broken file stops on', async () => {
    const err = await readFile(file('malformed-truncated.ofx')).catch((e: unknown) => e);
    expect(fileErrorMessage(err)).toBe(
      'This file can’t be read as OFX (line 39): The file ends early.',
    );
  });

  it('matches by last 4 digits and type, then by name, else offers a new account', async () => {
    const f = await load('multi-account.ofx');
    const rows = readOfxFile(f, 'USD');
    const choices = suggestOfxAccounts(rows.ofxAccounts!, [
      account('a1', 'My checking', { mask: '1234' }),
      // Same last 4 as the savings account, but a card: not the same account.
      account('a2', 'Visa', { mask: '5678', type: 'credit' }),
      // No last 4 of its own, but its name ends with them.
      account('a3', 'Example Bank ••9012', { type: 'credit' }),
      // Someone else's account isn't offered.
      account('a4', 'Shared checking', { mask: '1234', yourAccess: 'full' }),
    ]);
    expect(
      choices.map((c) => [
        c.key,
        c.mode,
        c.accountId,
        c.matched?.by,
        c.name,
        c.type,
        c.lastBalance,
      ]),
    ).toEqual([
      ['checking-1234', 'existing', 'a1', 'mask', 'Example Bank ••1234', 'depository', 143825],
      ['savings-5678', 'new', null, undefined, 'Example Bank ••5678', 'depository', 550123],
      ['card-9012', 'existing', 'a3', 'mask', 'Example Bank ••9012', 'credit', -3840],
    ]);
    expect(choices.map((c) => statementLabel(c.statement!))).toEqual([
      '••1234 · Checking',
      '••5678 · Savings',
      '••9012 · Credit card',
    ]);
    // One of your accounts takes one statement; another currency never matches.
    const again = suggestOfxAccounts(rows.ofxAccounts!, [
      account('e1', 'Euro checking', { mask: '1234', currency: 'EUR' }),
    ]);
    expect(again[0]).toMatchObject({ mode: 'new', accountId: null });

    // The new account gets the last 4 digits and the statement's currency; LEDGERBAL is one
    // entered balance; the batch is recorded as OFX.
    const body = previewRequest(choicesFor(f, choices), rowsToSend(rows, choices));
    expect(body).toMatchObject({
      format: 'ofx',
      accounts: [
        { key: 'checking-1234', accountId: 'a1' },
        {
          key: 'savings-5678',
          create: {
            name: 'Example Bank ••5678',
            type: 'depository',
            mask: '5678',
            currency: 'USD',
          },
        },
        { key: 'card-9012', accountId: 'a3' },
      ],
      balances: [
        { account: 'checking-1234', date: '2026-10-06', balanceMinor: 143825 },
        { account: 'savings-5678', date: '2026-10-06', balanceMinor: 550123 },
        { account: 'card-9012', date: '2026-10-06', balanceMinor: -3840 },
      ],
    });
    expect(body.transactions!.map((t) => [t.account, t.externalId])).toEqual([
      ['checking-1234', 'CHK-0910-1'],
      ['checking-1234', 'CHK-0912-1'],
      ['savings-5678', 'SAV-0910-1'],
      ['savings-5678', 'SAV-0930-1'],
      ['card-9012', 'CC-0915-1'],
    ]);
  });

  it('never sends the full account number', async () => {
    for (const fixture of ['multi-account.ofx', 'bank-sgml-1252.ofx', 'card-reversed.qfx']) {
      const f = await load(fixture);
      const text = bytes(fixture).toString('latin1');
      const numbers = [...text.matchAll(/<ACCTID>\s*([^<\s]+)/g)].map((m) => m[1]!);
      expect(numbers.length).toBeGreaterThan(0);
      const rows = readOfxFile(f, 'USD');
      const choices = suggestOfxAccounts(rows.ofxAccounts!, []);
      const sent = JSON.stringify([
        previewRequest(choicesFor(f, choices), rows),
        startRequest(choicesFor(f, choices), rows),
      ]);
      for (const number of numbers) {
        expect(sent).not.toContain(number);
        expect(sent).toContain(number.slice(-4)); // the last 4 digits are what's kept
      }
    }
  });

  it('offers to reverse the amounts of an account whose spending looks like money in', async () => {
    const f = await load('card-reversed.qfx');
    expect(fileFormat('csv', f)).toBe('qfx');
    const rows = readOfxFile(f, 'USD');
    const choices = suggestOfxAccounts(rows.ofxAccounts!, []);
    expect(choices[0]).toMatchObject({
      check: ['amounts_reversed'],
      reversed: false,
      statement: { amountsLookReversed: true },
    });
    // Off, amounts are sent as written.
    expect(rowsToSend(rows, choices)).toBe(rows);
    const flipped = rowsToSend(rows, [{ ...choices[0]!, reversed: true }]);
    expect(flipped.transactions.map((t) => t.amountMinor)).toEqual([-5420, 30000, -1299]);
    expect(flipped.balances.map((b) => b.balanceMinor)).toEqual([-76719]);
    // Only that account's rows.
    const other: FileRows = {
      ...rows,
      transactions: [...rows.transactions, { ...rows.transactions[0]!, account: 'x', line: 99 }],
    };
    expect(rowsToSend(other, [{ ...choices[0]!, reversed: true }]).transactions.at(-1)).toEqual(
      other.transactions.at(-1),
    );
    // A card that reads the right way round isn't flagged.
    const card = readOfxFile(await load('card.qfx'), 'USD');
    expect(suggestOfxAccounts(card.ofxAccounts!, [])[0]!.check).toEqual([]);
  });

  it('says what it doesn’t import yet, and imports the rest', async () => {
    const f = await load('investment-and-bank.ofx');
    const rows = readOfxFile(f, 'USD');
    expect(unsupportedNotices(rows.unsupported!)).toEqual([
      'Investment statements aren’t supported yet',
      'Loan statements aren’t supported yet',
    ]);
    expect(rows.ofxAccounts!.map((a) => a.key)).toEqual(['moneymrkt-3456']);
    expect(rows.transactions.length).toBeGreaterThan(0);
  });
});
