// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { budgetMonthRange } from '@fiscus/shared';
import { addMonths, fiscalYearOf, monthProgress } from './budget.js';

describe('budget months', () => {
  it('steps across years', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 12)).toBe('2027-10');
  });

  it('says how far through the current month today is, and nothing for other months', () => {
    const month = (m: string, startDay = 1) => budgetMonthRange(m, startDay);
    expect(monthProgress(month('2026-10'), '2026-10-26')).toBeCloseTo(26 / 31);
    expect(monthProgress(month('2026-09'), '2026-10-26')).toBeNull();
    expect(monthProgress(month('2026-11'), '2026-10-26')).toBeNull();
    expect(monthProgress(month('2026-02'), '2026-02-28')).toBe(1);
  });

  it('counts progress from the start day (#71)', () => {
    const month = (m: string, startDay: number) => budgetMonthRange(m, startDay);
    // November from the 15th: Nov 15 – Dec 14, 30 days. Nov 29 is day 15.
    expect(monthProgress(month('2026-11', 15), '2026-11-29')).toBeCloseTo(15 / 30);
    expect(monthProgress(month('2026-11', 15), '2026-12-14')).toBe(1);
    expect(monthProgress(month('2026-11', 15), '2026-11-14')).toBeNull();
  });
});

describe('fiscal years', () => {
  it('names a fiscal year by the calendar year it starts in', () => {
    expect(fiscalYearOf('2026-10', 1)).toBe(2026);
    expect(fiscalYearOf('2026-03', 7)).toBe(2025);
    expect(fiscalYearOf('2026-07', 7)).toBe(2026);
  });
});
