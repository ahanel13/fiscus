// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { addMonths, monthProgress } from './budget.js';

describe('budget months', () => {
  it('steps across years', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 12)).toBe('2027-10');
  });

  it('says how far through the current month today is, and nothing for other months', () => {
    const today = new Date(2026, 9, 26); // October 26
    expect(monthProgress('2026-10', today)).toBeCloseTo(26 / 31);
    expect(monthProgress('2026-09', today)).toBeNull();
    expect(monthProgress('2026-02', new Date(2026, 1, 28))).toBe(1);
  });
});
