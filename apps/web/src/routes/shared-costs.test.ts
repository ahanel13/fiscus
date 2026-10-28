// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { balanceSentence } from './shared-costs.js';

describe('balanceSentence', () => {
  it('says where you stand from your side', () => {
    expect(balanceSentence('Sam', 14210, '$142.10')).toBe('Sam owes you $142.10');
    expect(balanceSentence('Sam', -500, '$5.00')).toBe('You owe Sam $5.00');
    expect(balanceSentence('Sam', 0, '$0.00')).toBe('You and Sam are square');
  });
});
