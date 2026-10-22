// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  type MatchCandidate,
  maskInName,
  matchAccounts,
  nameWithoutMask,
} from './account-match.js';

const candidate = (id: string, name: string, extra: Partial<MatchCandidate> = {}) => ({
  id,
  name,
  type: 'depository' as const,
  mask: null,
  currency: 'USD',
  closedAt: null,
  ...extra,
});

describe('matchAccounts (#74, #79)', () => {
  it('matches by last 4 digits and type, then by name, else nothing', () => {
    expect(
      matchAccounts(
        [
          { names: ['Harbor CU Checking'], type: 'depository', mask: '4410', currency: 'USD' },
          { names: ['Harbor CU Savings'], type: 'depository', mask: '8812', currency: 'USD' },
          {
            names: ['Harbor CU Visa', 'Visa Signature'],
            type: 'credit',
            mask: '3301',
            currency: 'USD',
          },
          { names: ['Brokerage'], type: 'investment', mask: null, currency: 'USD' },
        ],
        [
          candidate('a1', 'Everyday', { mask: '4410' }),
          // Same last 4 as the savings account, but a card: not the same account.
          candidate('a2', 'Card', { mask: '8812', type: 'credit' }),
          candidate('a3', ' visa signature ', { type: 'credit' }),
        ],
      ),
    ).toEqual([{ accountId: 'a1', by: 'mask' }, null, { accountId: 'a3', by: 'name' }, null]);
  });

  it('takes each account once, never across currencies, and an open one first', () => {
    const wanted = {
      names: ['Checking'],
      type: 'depository' as const,
      mask: '1234',
      currency: 'USD',
    };
    expect(
      matchAccounts(
        [wanted, wanted],
        [
          candidate('closed', 'Checking', { mask: '1234', closedAt: '2025-01-01T00:00:00Z' }),
          candidate('euro', 'Checking', { mask: '1234', currency: 'EUR' }),
          candidate('open', 'Checking', { mask: '1234' }),
        ],
      ),
    ).toEqual([
      { accountId: 'open', by: 'mask' },
      { accountId: 'closed', by: 'mask' },
    ]);
  });

  it('reads the last 4 an imported name ends with, when the account has none', () => {
    const sofi = [
      candidate('savings', 'SoFi Savings (...4942)'),
      candidate('mortgage', 'SOFI (...8884)', { type: 'loan' }),
      candidate('car', '2021 Toyota Tacoma TRD Pro', { type: 'vehicle' }),
    ];
    expect(
      matchAccounts(
        [
          { names: ['SOFI'], type: 'loan', mask: '8884', currency: 'USD' },
          { names: ['SoFi Savings'], type: 'depository', mask: '4942', currency: 'USD' },
        ],
        sofi,
      ),
    ).toEqual([
      { accountId: 'mortgage', by: 'mask' },
      { accountId: 'savings', by: 'mask' },
    ]);
    // By name, without the last 4: but never to an account whose last 4 differ.
    expect(
      matchAccounts(
        [{ names: ['SoFi Savings'], type: 'depository', mask: null, currency: 'USD' }],
        sofi,
      ),
    ).toEqual([{ accountId: 'savings', by: 'name' }]);
    expect(
      matchAccounts([{ names: ['SOFI'], type: 'depository', mask: '1111', currency: 'USD' }], sofi),
    ).toEqual([null]);
    // A name only matches without its last 4 for the same type: not a bank's generic name.
    expect(
      matchAccounts(
        [{ names: ['SoFi Savings'], type: 'credit', mask: null, currency: 'USD' }],
        sofi,
      ),
    ).toEqual([null]);
  });

  it('finds last 4s at the end of a name, only after a marker or in brackets', () => {
    for (const name of [
      'SOFI (...8884)',
      'Visa (…8884)',
      'Checking ••8884',
      'Savings x8884',
      'Card ending in 8884',
      'Card (8884)',
      'Card [**8884]',
      'Card #8884',
    ]) {
      expect(maskInName(name), name).toBe('8884');
    }
    for (const name of ['Roth IRA 2024', '2021 Toyota Tacoma', '755 W 2180th St', 'Checking']) {
      expect(maskInName(name), name).toBeNull();
    }
    expect(nameWithoutMask('SOFI (...8884)')).toBe('SOFI');
    expect(nameWithoutMask('Checking ••4410')).toBe('Checking');
    expect(nameWithoutMask('(...8884)')).toBe('(...8884)');
  });
});
