// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { matchAccounts, type MatchCandidate } from './account-match.js';

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
});
