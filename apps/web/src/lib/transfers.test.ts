// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TransferReview, TransferReviewTransaction } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import {
  groupSuggestions,
  groupUnmatched,
  hints,
  likelyOtherSide,
  namedAccount,
  withoutTransactions,
} from './transfers.js';

const t = (id: string, account: string, displayName: string) =>
  ({
    id,
    account: { id: account, name: account },
    displayName,
  }) as unknown as TransferReviewTransaction;

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

describe('grouping the review (#332)', () => {
  const s = (
    out: TransferReviewTransaction,
    candidates: TransferReviewTransaction[],
    unique = false,
    reason: TransferReview['suggested'][number]['reason'] = 'several',
  ) => ({ transaction: out, candidates, rivals: [], unique, reason });

  it('groups by account pair, biggest first, with the pairs one click can link', () => {
    const groups = groupSuggestions([
      // Clear: one match either way.
      s(t('o1', 'Checking', 'To savings'), [t('i1', 'Savings', 'In')], true, 'one_match'),
      // The names point to one: ready too.
      s(t('o2', 'Checking', 'To Savings'), [t('i2', 'Savings', 'In'), t('x2', 'House', 'In')]),
      // Two possible accounts, no hint: its own group, and nothing to link in one click.
      s(t('o3', 'Checking', 'Move'), [t('i3', 'Savings', 'In'), t('x3', 'House', 'In')]),
      s(t('o4', 'Vault', 'Move'), [t('i4', 'Savings', 'In')], false, 'rivals'),
    ]);
    expect(groups.map((g) => [g.from, g.to, g.items.length, g.ready])).toEqual([
      [
        'Checking',
        'Savings',
        2,
        [
          { out: 'o1', into: 'i1' },
          { out: 'o2', into: 'i2' },
        ],
      ],
      ['Checking', null, 1, []],
      ['Vault', 'Savings', 1, []],
    ]);
  });

  it('gives identical transfers in step their own other sides', () => {
    const intos = [t('i1', 'Savings', 'Round up'), t('i2', 'Savings', 'Round up')];
    const [group] = groupSuggestions([
      s(t('o1', 'Checking', 'Round up'), intos, true, 'identical'),
      s(t('o2', 'Checking', 'Round up'), intos, true, 'identical'),
    ]);
    expect(group!.ready).toEqual([
      { out: 'o1', into: 'i1' },
      { out: 'o2', into: 'i2' },
    ]);
  });

  it('groups transfers with no other side by account', () => {
    expect(
      groupUnmatched([t('a', 'Card', 'x'), t('b', 'Checking', 'y'), t('c', 'Checking', 'z')]).map(
        (g) => [g.account, g.items.map((i) => i.id)],
      ),
    ).toEqual([
      ['Checking', ['b', 'c']],
      ['Card', ['a']],
    ]);
  });
});

describe('closest-date hints (#332)', () => {
  const dated = (id: string, account: string, date: string) =>
    ({ ...t(id, account, 'Transfer'), date }) as TransferReviewTransaction;
  const within = (out: TransferReviewTransaction, ins: TransferReviewTransaction[]) =>
    ins.filter((i) => Math.abs(Date.parse(i.date) - Date.parse(out.date)) <= 10 * 86_400_000);

  it('pairs a recurring transfer with the deposit closest to it both ways', () => {
    // $10 to investing every few days: each out has several same-amount deposits in range.
    const outs = ['2024-02-06', '2024-02-02', '2024-01-30', '2024-01-26'].map((d, i) =>
      dated(`o${i}`, 'SoFi', d),
    );
    const ins = ['2024-02-05', '2024-02-01', '2024-01-29', '2024-01-25', '2024-01-22'].map((d, i) =>
      dated(`i${i}`, 'Invest', d),
    );
    const list = outs.map((o) => ({
      transaction: o,
      candidates: within(o, ins),
      rivals: [],
      unique: false,
      reason: 'several' as const,
    }));
    const found = hints(list);
    expect(outs.map((o) => found.get(o.id))).toEqual([
      { id: 'i0', label: 'closest date' },
      { id: 'i1', label: 'closest date' },
      { id: 'i2', label: 'closest date' },
      { id: 'i3', label: 'closest date' },
    ]);
    // So the whole group links in one go.
    expect(groupSuggestions(list)[0]!.ready).toHaveLength(4);
  });

  it('gives no date hint on a tie, or when the closest deposit is closer to another', () => {
    const out = dated('o', 'SoFi', '2024-03-10');
    const tie = hints([
      {
        transaction: out,
        candidates: [dated('a', 'Invest', '2024-03-09'), dated('b', 'Invest', '2024-03-11')],
        rivals: [],
        unique: false,
        reason: 'several',
      },
    ]);
    expect(tie.size).toBe(0);
    // b is closest to o, but closer still to o2: o gets nothing, o2 gets b.
    const o2 = dated('o2', 'SoFi', '2024-03-12');
    const b = dated('b', 'Invest', '2024-03-12');
    const a = dated('a', 'Invest', '2024-03-05');
    const found = hints([
      { transaction: out, candidates: [a, b], rivals: [], unique: false, reason: 'several' },
      { transaction: o2, candidates: [b], rivals: [], unique: false, reason: 'one_match' },
    ]);
    expect(found.get('o')).toBeUndefined();
  });
});
