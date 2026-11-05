// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { goalPace } from './goals.js';

const goal = (over: Partial<Parameters<typeof goalPace>[0]> = {}) =>
  goalPace({
    progressMinor: 300_000,
    targetMinor: 600_000,
    targetDate: '2027-05-01',
    planMinor: 50_000,
    shortMinor: 0,
    thisMonth: '2026-11',
    ...over,
  });

describe('goalPace (walkthrough §4)', () => {
  it('is on track when its plan reaches the target by its month, counting this one', () => {
    // $3,000 left at $500 a month: Nov–Apr, done in April, before May.
    expect(goal()).toEqual({ status: 'on_track', projectedMonth: '2027-04', monthsLate: 0 });
    // Exactly in its month is on time.
    expect(goal({ targetDate: '2027-04-15' })).toMatchObject({ status: 'on_track' });
  });

  it('is at risk when its plan gets there late, saying by how much', () => {
    expect(goal({ planMinor: 25_000 })).toEqual({
      status: 'at_risk',
      projectedMonth: '2027-10',
      monthsLate: 5,
    });
  });

  it('is at risk with no plan, and never gets there', () => {
    expect(goal({ planMinor: null })).toEqual({
      status: 'at_risk',
      projectedMonth: null,
      monthsLate: null,
    });
  });

  it('has no status without a date, only where its pace leads', () => {
    expect(goal({ targetDate: null })).toEqual({
      status: null,
      projectedMonth: '2027-04',
      monthsLate: null,
    });
  });

  it('is done at its target, and short before anything else', () => {
    expect(goal({ progressMinor: 600_000 }).status).toBe('done');
    expect(goal({ progressMinor: 700_000, shortMinor: 10_000 }).status).toBe('done');
    expect(goal({ shortMinor: 10_000 }).status).toBe('short');
  });

  it('crosses years', () => {
    expect(goal({ thisMonth: '2026-12', progressMinor: 0, planMinor: 100_000 })).toMatchObject({
      projectedMonth: '2027-05',
      monthsLate: 0,
    });
  });
});
