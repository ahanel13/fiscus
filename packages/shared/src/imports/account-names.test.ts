// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { typeFromName } from './account-names.js';

describe('typeFromName', () => {
  it.each([
    // Words that say what it is
    ['Ally Checking', 'depository'],
    ['CHASE SAVINGS', 'depository'],
    ['12 Month CD (Down Payment)', 'depository'],
    ['Emergency Fund', 'depository'],
    ['CREDIT CARD (...1111)', 'credit'],
    ['BILT Mastercard®', 'credit'],
    ['Truck Auto Loan', 'loan'],
    ['Citi HSA', 'investment'],
    ['Auto Roth IRA', 'investment'],
    ['Acme Corp 401k', 'investment'],
    ['Brokerage Account', 'investment'],
    // Brands and products
    ['Freedom Unlimited', 'credit'],
    ['Quicksilver (...2222)', 'credit'],
    ['SCHEELS Signature (...3333)', 'credit'],
    ["MyLowe's® Rewards Credit Card (...4444)", 'credit'],
    ['Fidelity', 'investment'],
    ['Navient', 'loan'],
    ['Venmo', 'depository'],
    ['Coinbase', 'crypto'],
    ['2019 Ford F-150 XLT', 'vehicle'],
    ['Tesla Model Y', 'vehicle'],
    ['42 Elm St, Anytown UT', 'property'],
    // Traps: the kind of account wins over a brand or a stray word
    ['Navy Federal Credit Union Checking', 'depository'],
    ['Home Depot Credit Card', 'credit'],
    ['Amex High Yield Savings', 'depository'],
    ['Discover Savings', 'depository'],
    ['Home Equity Loan', 'loan'],
    ['Vanguard 500 Index Fund', 'investment'],
    ['Car Fund', 'depository'],
    ['Fidelity Cash Management', 'depository'],
  ])('%s → %s', (name, type) => {
    expect(typeFromName(name)).toBe(type);
  });

  it('says nothing when the name doesn’t', () => {
    for (const name of ['Vacation', 'Garden', 'Travel', 'Chase', 'Wells Fargo']) {
      expect(typeFromName(name)).toBeNull();
    }
  });
});
