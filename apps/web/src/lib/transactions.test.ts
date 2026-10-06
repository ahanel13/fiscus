// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { byDay, forLabel, paidByLabel } from './transactions.js';

const members = [
  { id: 'a', displayName: 'Ada', isYou: true },
  { id: 'b', displayName: 'Bea', isYou: false },
];

describe('transaction labels', () => {
  it('says who it is for from the viewer’s side', () => {
    expect(forLabel({ attribution: [{ memberId: 'a', shareBps: 10000 }] }, members)).toBe('Mine');
    expect(forLabel({ attribution: [{ memberId: 'b', shareBps: 10000 }] }, members)).toBe('Bea’s');
    expect(
      forLabel(
        {
          attribution: [
            { memberId: 'a', shareBps: 5000 },
            { memberId: 'b', shareBps: 5000 },
          ],
        },
        members,
      ),
    ).toBe('Ours');
  });

  it('names payers, never an account', () => {
    expect(paidByLabel({ paidBy: ['a'] }, members)).toBe('Paid by Ada');
    expect(paidByLabel({ paidBy: ['a', 'b'] }, members)).toBe('Paid by Ada & Bea');
  });

  it('groups by day in order', () => {
    expect(
      byDay([{ date: '2026-06-02' }, { date: '2026-06-02' }, { date: '2026-06-01' }]).map(
        ([d, t]) => [d, t.length],
      ),
    ).toEqual([
      ['2026-06-02', 2],
      ['2026-06-01', 1],
    ]);
  });
});
