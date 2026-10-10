// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Transaction, TransferReview } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import { likelyOtherSide, namedAccount, withoutTransactions } from './transfers.js';

const t = (id: string, account: string, displayName: string) =>
  ({ id, account: { id: account, name: account }, displayName }) as unknown as Transaction;

describe('transfer name hints', () => {
  it('finds the account a transfer’s name mentions, ignoring common words', () => {
    expect(namedAccount('From Holiday Vault', 'Holiday')).toBe('Holiday');
    expect(namedAccount('From Checking Balance', 'Ally Checking')).toBe('Checking');
    expect(namedAccount('From Checking Balance', 'Roof')).toBeNull();
    expect(namedAccount('Transfer from savings account', 'Joint Account')).toBeNull();
    expect(namedAccount('Payment', undefined)).toBeNull();
  });

  it('picks the one candidate the names single out, or none', () => {
    const fromHoliday = t('a', 'Roof', 'From Holiday Vault');
    const fromChecking = t('b', 'Roof', 'From Checking Balance');
    // Both are Roof, so "To Roof Vault" alone can't choose; the deposits' names can.
    expect(
      likelyOtherSide(t('o', 'Holiday', 'To Roof Vault'), [fromHoliday, fromChecking]),
    ).toEqual({ id: 'a', named: 'Holiday' });
    expect(
      likelyOtherSide(t('o', 'Ally Checking', 'To Roof Vault'), [fromHoliday, fromChecking]),
    ).toEqual({ id: 'b', named: 'Checking' });
    // Different accounts: the money out's name says which.
    expect(
      likelyOtherSide(t('o', 'Checking', 'To Brokerage'), [
        t('x', 'Brokerage', 'Deposit'),
        t('y', 'Roth IRA', 'Deposit'),
      ]),
    ).toEqual({ id: 'x', named: 'Brokerage' });
    expect(
      likelyOtherSide(t('o', 'Checking', 'Move money'), [t('x', 'A1', 'In'), t('y', 'B1', 'In')]),
    ).toBeNull();
    expect(likelyOtherSide(t('o', 'Holiday', 'x'), [fromHoliday])).toBeNull();
  });
});

describe('withoutTransactions', () => {
  it('drops linked transactions, empty suggestions, and adjusts the counts', () => {
    const s = (out: string, intos: string[], unique = false) => ({
      transaction: t(out, 'A', out),
      candidates: intos.map((i) => t(i, 'B', i)),
      rivals: [],
      unique,
      reason: 'several' as const,
    });
    const review: TransferReview = {
      suggested: [s('o1', ['i1'], true), s('o2', ['i1', 'i2']), s('o3', ['i3'], true)],
      unmatched: [t('u1', 'A', 'u1')],
      counts: { suggested: 120, unmatched: 1, unique: 2 },
    };
    const next = withoutTransactions(review, new Set(['o1', 'i1', 'u1']));
    expect(next.suggested.map((x) => [x.transaction.id, x.candidates.map((c) => c.id)])).toEqual([
      ['o2', ['i2']],
      ['o3', ['i3']],
    ]);
    expect(next.unmatched).toEqual([]);
    expect(next.counts).toEqual({ suggested: 119, unmatched: 0, unique: 1 });
  });
});
