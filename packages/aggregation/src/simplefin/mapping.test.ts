// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  guessAccountType,
  simpleFinCurrency,
  simpleFinDate,
  simpleFinMinor,
  simpleFinProviderAccount,
  simpleFinProviderTransaction,
} from './mapping.js';

describe('SimpleFIN mapping (#91)', () => {
  it('reads amounts by their digits, never through a float', () => {
    expect(simpleFinMinor('-33293.43', 'USD')).toBe(-3_329_343);
    expect(simpleFinMinor('0.1', 'USD')).toBe(10);
    expect(simpleFinMinor('1234', 'USD')).toBe(123_400);
    expect(simpleFinMinor('19.995', 'USD')).toBe(2_000);
    expect(simpleFinMinor('-0.004', 'USD')).toBe(0);
    expect(simpleFinMinor('1500', 'JPY')).toBe(1_500);
    expect(simpleFinMinor('12.345', 'KWD')).toBe(12_345);
    // 0.1 + 0.2 as floats would be 0.30000000000000004.
    expect(simpleFinMinor('1234567.89', 'USD')).toBe(123_456_789);
    expect(simpleFinMinor('1e5', 'USD')).toBeNull();
    expect(simpleFinMinor('12.34', 'https://example.com/points')).toBeNull();
    expect(simpleFinMinor('99999999999999999999.99', 'USD')).toBeNull();
  });

  it('keeps ISO currencies and refuses custom ones', () => {
    expect(simpleFinCurrency('usd')).toBe('USD');
    expect(simpleFinCurrency('https://www.example.com/flight-miles.json')).toBeNull();
  });

  it('dates an instant in the household’s zone, and midnight UTC as a bare date', () => {
    const lateEvening = Date.parse('2026-10-05T03:30:00Z') / 1000; // Oct 4, 23:30 in New York
    expect(simpleFinDate(lateEvening, 'America/New_York')).toBe('2026-10-04');
    expect(simpleFinDate(lateEvening, 'UTC')).toBe('2026-10-05');
    const bare = Date.parse('2026-10-05T00:00:00Z') / 1000;
    expect(simpleFinDate(bare, 'America/Los_Angeles')).toBe('2026-10-05');
    expect(simpleFinDate(bare, 'Asia/Tokyo')).toBe('2026-10-05');
  });

  it('guesses an account’s type from its name, then a negative balance as a card', () => {
    expect(guessAccountType('Everyday Checking', 100)).toEqual({
      type: 'depository',
      subtype: 'checking',
    });
    expect(guessAccountType('High Yield Savings', 100)).toEqual({
      type: 'depository',
      subtype: 'savings',
    });
    expect(guessAccountType('Sapphire Visa', -100)).toEqual({
      type: 'credit',
      subtype: 'credit card',
    });
    expect(guessAccountType('Home Mortgage', -100)).toEqual({ type: 'loan', subtype: 'mortgage' });
    expect(guessAccountType('Roth IRA', 100)).toEqual({ type: 'investment' });
    expect(guessAccountType('Platinum', -100)).toEqual({ type: 'credit' });
    expect(guessAccountType('Platinum', 100)).toEqual({ type: 'depository' });
  });

  it('finds the last 4 in a name, and leaves out accounts in a custom currency', () => {
    const base = { id: 'a1', balance: '10.00', 'balance-date': 1, currency: 'USD' };
    expect(simpleFinProviderAccount({ ...base, name: 'Checking (...4410)' })).toMatchObject({
      mask: '4410',
      type: 'depository',
    });
    expect(
      simpleFinProviderAccount({ ...base, name: 'Miles', currency: 'https://example.com/miles' }),
    ).toBeNull();
  });

  it('treats a transaction posted at 0 as pending, with no posted date', () => {
    const t = simpleFinProviderTransaction(
      { id: 't1', posted: 0, amount: '-4.50', description: ' CORNER COFFEE ' },
      { providerAccountId: 'a1', currency: 'USD' },
      'UTC',
      '2026-10-20',
    );
    expect(t).toEqual({
      providerTransactionId: 't1',
      providerAccountId: 'a1',
      amountMinor: -450,
      currency: 'USD',
      pending: true,
      authorizedDate: '2026-10-20',
      description: 'CORNER COFFEE',
    });
  });
});
