// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { monthDates, ordinal, startDayHint } from './budget-months.js';

describe('budget months', () => {
  it('names days as ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '31st',
    ]);
  });

  it('shows a month’s days only when they aren’t the calendar month’s', () => {
    expect(monthDates('2026-11', 1)).toBeNull();
    expect(monthDates('2026-11', 15)).toMatch(/Nov 15 – Dec 14/);
    expect(monthDates('2026-02', 31)).toMatch(/Feb 28 – Mar 30/);
  });

  it('explains a start day with the month running today', () => {
    expect(startDayHint(1, '2026-11-17')).toMatch(/calendar months/);
    expect(startDayHint(15, '2026-11-10')).toMatch(/^October’s budget runs Oct 15 – Nov 14\./);
    expect(startDayHint(31, '2026-03-01')).toMatch(
      /^February’s budget runs Feb 28 – Mar 30\..*last day of months without the 31st/,
    );
  });
});
