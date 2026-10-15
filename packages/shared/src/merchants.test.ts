// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { cleanMerchantName } from './merchants.js';

describe('cleanMerchantName', () => {
  it.each([
    ['SQ *BLUE BOTTLE COFFEE #1234', 'Blue Bottle Coffee'],
    ['TST* SHAKE SHACK 123', 'Shake Shack'],
    ['PAYPAL *NETFLIX.COM', 'Netflix.com'],
    ['POS PURCHASE TRADER JOE S #123 SALT LAKE UT', 'Trader Joe S'],
    ['DEBIT CARD PURCHASE STARBUCKS STORE 05123 SEATTLE WA', 'Starbucks Store'],
    ['9640 AMC ONLINE*9640LEAWOOD', 'AMC Online'],
    ['7-ELEVEN 1234', '7-Eleven'],
    ['THE HOME DEPOT #4410', 'The Home Depot'],
    ['BEAN THERE CAFE', 'Bean There Cafe'],
    ['UBER *TRIP', 'Uber Trip'],
    ['CHEESECAKE FACTORY OF THE WEST', 'Cheesecake Factory of the West'],
    ['INTERNET PAYMENT - THANK YOU', 'Internet Payment Thank You'],
    ['J&C DONUTS', 'J&C Donuts'],
    ['CPK A DFW', 'CPK a DFW'],
    ['USAA INSURANCE PAYMENT', 'USAA Insurance Payment'],
    ['CVS/PHARMACY #04512', 'CVS/Pharmacy'],
    ['Via 313 Pizza', 'Via 313 Pizza'],
    // A short number in the middle is part of a name, in capitals too.
    ['VIA 313 PIZZA #4 DETROIT MI', 'Via 313 Pizza'],
    ['FIVE GUYS 1234 AUSTIN TX', 'Five Guys'],
    ['MCDONALDS F12345 DALLAS TX', 'Mcdonalds'],
    // Already written by a person or a bank that doesn't shout: only the noise goes.
    ['Subway 15048', 'Subway'],
    ['From Checking Balance', 'From Checking Balance'],
    ['Interest', 'Interest'],
    // Nothing better left: the description as it was.
    ['12345', '12345'],
    ['#4410', '#4410'],
    ['   ', ''],
  ])('%s → %s', (raw, clean) => {
    expect(cleanMerchantName(raw)).toBe(clean);
  });
});
