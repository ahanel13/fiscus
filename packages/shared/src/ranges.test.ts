// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  autoGranularity,
  budgetMonthOf,
  budgetMonthRange,
  budgetMonthStart,
  averageOf,
  buckets,
  comparisonRange,
  type DateRangeSpec,
  type Preset,
  resolveRange,
  type RangeSettings,
  todayIn,
} from './ranges.js';

const denver: RangeSettings = { timeZone: 'America/Denver', weekStart: 1, fiscalYearStartMonth: 1 };
/** Noon in Denver on a calendar date, far from any midnight. */
const noon = (d: string) => new Date(`${d}T18:00:00Z`);
const preset = (p: Preset): DateRangeSpec => ({ kind: 'preset', preset: p });
const resolve = (
  p: Preset,
  today: string,
  settings: Partial<RangeSettings> = {},
  earliest?: string,
) => resolveRange(preset(p), { ...denver, ...settings }, noon(today), earliest);

describe('today in the household time zone', () => {
  it('follows the household, not the server, around midnight', () => {
    const instant = new Date('2026-10-06T03:30:00Z');
    expect(todayIn('America/Denver', instant)).toBe('2026-10-05');
    expect(todayIn('UTC', instant)).toBe('2026-10-06');
    expect(todayIn('Pacific/Kiritimati', instant)).toBe('2026-10-06'); // UTC+14
    expect(todayIn('Pacific/Pago_Pago', instant)).toBe('2026-10-05'); // UTC−11
  });

  it('is right on both sides of daylight-saving changes', () => {
    // Spring forward in Denver: 2026-03-08 at 2:00 local.
    expect(todayIn('America/Denver', new Date('2026-03-08T06:59:00Z'))).toBe('2026-03-07'); // 23:59 MST
    expect(todayIn('America/Denver', new Date('2026-03-08T07:01:00Z'))).toBe('2026-03-08'); // 00:01 MST
    // Fall back: 2026-11-01 at 2:00 local, so 1:30 happens twice; both are Nov 1.
    expect(todayIn('America/Denver', new Date('2026-11-01T07:30:00Z'))).toBe('2026-11-01'); // 1:30 MDT
    expect(todayIn('America/Denver', new Date('2026-11-01T08:30:00Z'))).toBe('2026-11-01'); // 1:30 MST
    expect(todayIn('America/Denver', new Date('2026-11-01T05:59:00Z'))).toBe('2026-10-31');
  });
});

describe('month arithmetic', () => {
  it('clamps to the end of shorter months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29'); // leap year
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -13)).toBe('2024-12-15');
  });
});

describe('resolveRange', () => {
  it('counts rolling presets back from today, including today', () => {
    expect(resolve('last_7d', '2026-10-06')).toEqual({
      from: '2026-09-30',
      to: '2026-10-06',
      periodEnd: '2026-10-06',
      partial: false,
    });
    expect(resolve('last_30d', '2026-03-01').from).toBe('2026-01-31');
  });

  it('snaps calendar presets to months, and marks the current one partial', () => {
    expect(resolve('this_month', '2026-10-06')).toEqual({
      from: '2026-10-01',
      to: '2026-10-06',
      periodEnd: '2026-10-31',
      partial: true,
    });
    expect(resolve('last_month', '2026-03-31')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
      periodEnd: '2026-02-28',
      partial: false,
    });
    expect(resolve('last_month', '2028-03-15').to).toBe('2028-02-29'); // leap year
    expect(resolve('last_month', '2026-01-10')).toMatchObject({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(resolve('last_3m', '2026-10-06')).toEqual({
      from: '2026-08-01',
      to: '2026-10-06',
      periodEnd: '2026-10-31',
      partial: true,
    });
    expect(resolve('last_12m', '2026-10-06').from).toBe('2025-11-01');
  });

  it('follows the fiscal year for quarters and years', () => {
    expect(resolve('this_quarter', '2026-08-15')).toMatchObject({
      from: '2026-07-01',
      periodEnd: '2026-09-30',
      partial: true,
    });
    expect(resolve('last_quarter', '2026-08-15')).toMatchObject({
      from: '2026-04-01',
      to: '2026-06-30',
    });
    expect(resolve('this_quarter', '2026-08-15', { fiscalYearStartMonth: 2 })).toMatchObject({
      from: '2026-08-01',
      periodEnd: '2026-10-31',
    });
    expect(resolve('last_quarter', '2026-01-10')).toMatchObject({
      from: '2025-10-01',
      to: '2025-12-31',
    });
    const july = { fiscalYearStartMonth: 7 };
    expect(resolve('ytd', '2026-03-10', july)).toEqual({
      from: '2025-07-01',
      to: '2026-03-10',
      periodEnd: '2026-03-10',
      partial: false,
    });
    expect(resolve('this_year', '2026-03-10', july)).toMatchObject({
      from: '2025-07-01',
      periodEnd: '2026-06-30',
      partial: true,
    });
    expect(resolve('last_year', '2026-03-10', july)).toMatchObject({
      from: '2024-07-01',
      to: '2025-06-30',
    });
    expect(resolve('ytd', '2026-07-01', july).from).toBe('2026-07-01'); // first day of the fiscal year
  });

  it('starts "all time" at the first data', () => {
    expect(resolve('all_time', '2026-10-06', {}, '2024-02-29').from).toBe('2024-02-29');
    expect(resolve('all_time', '2026-10-06').from).toBe('2026-10-06');
  });

  it('uses the household’s today, even when the server is past midnight', () => {
    const lateInDenver = new Date('2026-11-01T05:30:00Z'); // Oct 31, 23:30 in Denver
    expect(resolveRange(preset('this_month'), denver, lateInDenver).from).toBe('2026-10-01');
    expect(
      resolveRange(preset('this_month'), { ...denver, timeZone: 'UTC' }, lateInDenver).from,
    ).toBe('2026-11-01');
  });

  it('keeps custom ranges, marking them partial if they reach past today', () => {
    expect(
      resolveRange(
        { kind: 'custom', from: '2026-09-01', to: '2026-12-31' },
        denver,
        noon('2026-10-06'),
      ),
    ).toEqual({
      from: '2026-09-01',
      to: '2026-10-06',
      periodEnd: '2026-12-31',
      partial: true,
    });
  });
});

describe('comparisonRange', () => {
  const now = '2026-10-06';
  it('compares a calendar period so far with the same days of the previous one', () => {
    const spec = preset('this_month');
    const range = resolve('this_month', now);
    expect(comparisonRange(range, spec, 'previous_period')).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-06',
    });
    expect(comparisonRange(range, spec, 'same_period_last_year')).toMatchObject({
      from: '2025-10-01',
      to: '2025-10-06',
    });
    expect(comparisonRange(range, spec, 'none')).toBeNull();
  });

  it('compares rolling and custom ranges with the same number of days just before', () => {
    const range = resolve('last_30d', now);
    expect(comparisonRange(range, preset('last_30d'), 'previous_period')).toMatchObject({
      from: '2026-08-08',
      to: '2026-09-06',
    });
  });

  it('maps Feb 29 to Feb 28 a year earlier', () => {
    const range = { from: '2028-02-01', to: '2028-02-29', periodEnd: '2028-02-29', partial: false };
    expect(comparisonRange(range, preset('last_month'), 'same_period_last_year')).toMatchObject({
      from: '2027-02-01',
      to: '2027-02-28',
    });
  });
});

describe('buckets', () => {
  it('aligns months and marks the cut-off and current ones partial', () => {
    const range = { from: '2026-01-15', to: '2026-04-06', periodEnd: '2026-04-30' };
    expect(buckets(range, 'month', denver, '2026-04-06')).toEqual([
      { start: '2026-01-15', end: '2026-01-31', partial: true },
      { start: '2026-02-01', end: '2026-02-28', partial: false },
      { start: '2026-03-01', end: '2026-03-31', partial: false },
      { start: '2026-04-01', end: '2026-04-06', partial: true },
    ]);
  });

  it('starts weeks on the household’s week start', () => {
    const range = { from: '2026-10-01', to: '2026-10-14', periodEnd: '2026-10-14' };
    const monday = buckets(range, 'week', denver, '2026-10-20').map((b) => b.start);
    expect(monday).toEqual(['2026-10-01', '2026-10-05', '2026-10-12']); // Oct 1 is a Thursday
    const sunday = buckets(range, 'week', { ...denver, weekStart: 0 }, '2026-10-20').map(
      (b) => b.start,
    );
    expect(sunday).toEqual(['2026-10-01', '2026-10-04', '2026-10-11']);
  });

  it('follows fiscal quarters', () => {
    const range = { from: '2025-07-01', to: '2026-06-30', periodEnd: '2026-06-30' };
    const q = buckets(range, 'quarter', { ...denver, fiscalYearStartMonth: 7 }, '2026-10-01');
    expect(q.map((b) => [b.start, b.end])).toEqual([
      ['2025-07-01', '2025-09-30'],
      ['2025-10-01', '2025-12-31'],
      ['2026-01-01', '2026-03-31'],
      ['2026-04-01', '2026-06-30'],
    ]);
    expect(q.every((b) => !b.partial)).toBe(true);
  });
});

describe('granularity and averages', () => {
  it('picks a granularity from the range length', () => {
    expect(autoGranularity('2026-10-01', '2026-10-31')).toBe('day');
    expect(autoGranularity('2026-08-01', '2026-10-31')).toBe('week');
    expect(autoGranularity('2025-11-01', '2026-10-31')).toBe('month');
    expect(autoGranularity('2020-01-01', '2026-10-31')).toBe('quarter');
  });

  it('averages complete periods with data only', () => {
    expect(
      averageOf([
        { value: null, partial: false }, // before the account was linked: not a zero
        { value: 100, partial: false },
        { value: 300, partial: false },
        { value: 50, partial: true }, // this month so far
      ]),
    ).toBe(200);
    expect(averageOf([{ value: 10, partial: true }])).toBeNull();
  });
});

describe('budget months (#71)', () => {
  const dates = (month: string, day: number) => {
    const r = budgetMonthRange(month, day);
    return [r.from, r.to];
  };

  it('are calendar months from day 1, as before', () => {
    expect(dates('2026-11', 1)).toEqual(['2026-11-01', '2026-11-30']);
    expect(dates('2026-02', 1)).toEqual(['2026-02-01', '2026-02-28']);
    expect(budgetMonthOf('2026-11-01', 1)).toBe('2026-11');
    expect(budgetMonthOf('2026-10-31', 1)).toBe('2026-10');
  });

  it('are named for the month they start in', () => {
    expect(dates('2026-11', 15)).toEqual(['2026-11-15', '2026-12-14']);
    expect(dates('2026-12', 15)).toEqual(['2026-12-15', '2027-01-14']); // across the year
    expect(budgetMonthOf('2026-11-14', 15)).toBe('2026-10');
    expect(budgetMonthOf('2026-11-15', 15)).toBe('2026-11');
    expect(budgetMonthOf('2027-01-14', 15)).toBe('2026-12');
    expect(budgetMonthOf('2027-01-15', 15)).toBe('2027-01');
  });

  it('start on the last day of months too short for the start day', () => {
    // 31: February's starts on the 28th, and January's ends the day before.
    expect(dates('2026-01', 31)).toEqual(['2026-01-31', '2026-02-27']);
    expect(dates('2026-02', 31)).toEqual(['2026-02-28', '2026-03-30']);
    expect(dates('2026-03', 31)).toEqual(['2026-03-31', '2026-04-29']);
    expect(dates('2026-04', 31)).toEqual(['2026-04-30', '2026-05-30']);
    // 30 and 29 in February, leap year or not.
    expect(dates('2026-02', 30)).toEqual(['2026-02-28', '2026-03-29']);
    expect(dates('2028-02', 30)).toEqual(['2028-02-29', '2028-03-29']);
    expect(dates('2026-02', 29)).toEqual(['2026-02-28', '2026-03-28']);
    expect(dates('2028-02', 29)).toEqual(['2028-02-29', '2028-03-28']);
    expect(dates('2028-01', 29)).toEqual(['2028-01-29', '2028-02-28']);
    // The day a short month's starts on belongs to it; the day before, to the month before.
    expect(budgetMonthOf('2026-02-28', 31)).toBe('2026-02');
    expect(budgetMonthOf('2026-02-27', 31)).toBe('2026-01');
    expect(budgetMonthOf('2026-03-01', 31)).toBe('2026-02');
    expect(budgetMonthOf('2026-03-30', 31)).toBe('2026-02');
    expect(budgetMonthOf('2026-03-31', 31)).toBe('2026-03');
    expect(budgetMonthOf('2028-02-29', 30)).toBe('2028-02');
    expect(budgetMonthOf('2028-02-28', 30)).toBe('2028-01');
  });

  it('cover every day once, for every start day', () => {
    for (let day = 1; day <= 31; day++) {
      let d = '2027-12-01';
      let month = budgetMonthOf(d, day);
      while (d < '2029-02-01') {
        const r = budgetMonthRange(month, day);
        expect(d >= r.from && d <= r.to).toBe(true);
        const next = addDays(d, 1);
        const m = budgetMonthOf(next, day);
        if (m !== month) {
          expect(r.to).toBe(d); // the month ends where the next starts: no gap, no overlap
          expect(budgetMonthStart(m, day)).toBe(next);
          month = m;
        }
        d = next;
      }
    }
  });

  it('are partial until they end', () => {
    expect(budgetMonthRange('2026-11', 15, '2026-11-20')).toEqual({
      from: '2026-11-15',
      to: '2026-11-20',
      periodEnd: '2026-12-14',
      partial: true,
    });
    expect(budgetMonthRange('2026-11', 15, '2026-12-14').partial).toBe(false);
  });

  it('turn over at midnight in the household time zone, across daylight saving', () => {
    // Denver falls back on 2026-11-01. With a start day of 1, Nov starts at local midnight.
    const at = (instant: string, day: number) =>
      budgetMonthOf(todayIn('America/Denver', new Date(instant)), day);
    expect(at('2026-11-01T05:59:00Z', 1)).toBe('2026-10'); // 23:59 MDT, Oct 31
    expect(at('2026-11-01T06:01:00Z', 1)).toBe('2026-11'); // 00:01 MDT, Nov 1
    // After the change, a start day of 15: Nov 15 starts at 07:00 UTC (MST).
    expect(at('2026-11-15T06:59:00Z', 15)).toBe('2026-10');
    expect(at('2026-11-15T07:01:00Z', 15)).toBe('2026-11');
    // Spring forward (2027-03-14 at 2:00): the 14th starts at 07:00 UTC, still MST.
    expect(at('2027-03-14T06:59:00Z', 14)).toBe('2027-02');
    expect(at('2027-03-14T07:01:00Z', 14)).toBe('2027-03');
  });
});
