// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  estimateNext,
  guessSchedule,
  LAST_DAY,
  nextOccurrences,
  occurrences,
  payOccurrences,
  type RecurringCandidate,
  type RecurringSchedule,
  recurringMatches,
  recurringScheduleSchema,
} from './recurring.js';

const pay = (id: string, date: string, amountMinor = 241_236): RecurringCandidate => ({
  id,
  date,
  amountMinor,
  displayName: 'Brightline Labs payroll',
  originalDescription: 'BRIGHTLINE LABS PAYROLL PPD',
});

describe('occurrences', () => {
  it('every 2 weeks, from its anchor', () => {
    const s: RecurringSchedule = {
      unit: 'week',
      every: 2,
      anchor: '2026-11-06',
      weekend: 'before',
    };
    expect(occurrences(s, '2026-11-01', '2027-01-31')).toEqual([
      '2026-11-06',
      '2026-11-20',
      '2026-12-04',
      '2026-12-18',
      '2027-01-01',
      '2027-01-15',
      '2027-01-29',
    ]);
    expect(nextOccurrences(s, '2026-11-12', 2)).toEqual(['2026-11-20', '2026-12-04']);
  });

  it('twice a month, moving a weekend day to the Friday before, even into the month before', () => {
    const s: RecurringSchedule = {
      unit: 'month',
      every: 1,
      days: [1, 15],
      anchor: '2026-10-01',
      weekend: 'before',
    };
    // Nov 1 is a Sunday: paid Friday, Oct 30. Nov 15 is a Sunday too: Friday, Nov 13.
    expect(occurrences(s, '2026-10-01', '2026-10-31')).toEqual([
      '2026-10-01',
      '2026-10-15',
      '2026-10-30',
    ]);
    expect(occurrences(s, '2026-11-01', '2026-11-30')).toEqual(['2026-11-13']);
    expect(occurrences(s, '2026-12-01', '2026-12-31')).toEqual(['2026-12-01', '2026-12-15']);
  });

  it('the last day of the month, whatever it is', () => {
    const s: RecurringSchedule = {
      unit: 'month',
      every: 1,
      days: [15, LAST_DAY],
      anchor: '2027-01-15',
      weekend: 'before',
    };
    // Feb 28, 2027 is a Sunday.
    expect(occurrences(s, '2027-02-01', '2027-02-28')).toEqual(['2027-02-15', '2027-02-26']);
    expect(occurrences(s, '2027-04-01', '2027-04-30')).toEqual(['2027-04-15', '2027-04-30']);
  });

  it('every 2 months keeps its phase, and a bill moves to the Monday after', () => {
    const s: RecurringSchedule = {
      unit: 'month',
      every: 2,
      days: [9],
      anchor: '2026-09-09',
      weekend: 'after',
    };
    // Jan 9, 2027 is a Saturday.
    expect(occurrences(s, '2026-10-01', '2027-01-31')).toEqual(['2026-11-09', '2027-01-11']);
  });

  it('a day past the end of a short month is its last day', () => {
    const s: RecurringSchedule = {
      unit: 'month',
      every: 1,
      days: [31],
      anchor: '2027-01-31',
      weekend: 'as_is',
    };
    expect(occurrences(s, '2027-02-01', '2027-03-31')).toEqual(['2027-02-28', '2027-03-31']);
  });

  it('rejects a schedule with the same day twice', () => {
    expect(
      recurringScheduleSchema.safeParse({
        unit: 'month',
        every: 1,
        days: [15, 15],
        anchor: '2026-11-15',
        weekend: 'as_is',
      }).success,
    ).toBe(false);
  });
});

describe('describeSchedule', () => {
  it('says it in words', () => {
    expect(
      describeSchedule({ unit: 'week', every: 2, anchor: '2026-11-06', weekend: 'before' }),
    ).toBe('Every 2 weeks, on Friday');
    expect(
      describeSchedule({
        unit: 'month',
        every: 1,
        days: [LAST_DAY, 15],
        anchor: '2026-11-15',
        weekend: 'before',
      }),
    ).toBe('Twice a month, the 15th and the last day');
    expect(
      describeSchedule({
        unit: 'month',
        every: 1,
        days: [1],
        anchor: '2026-11-01',
        weekend: 'after',
      }),
    ).toBe('Every month, on the 1st');
    expect(
      describeSchedule({
        unit: 'month',
        every: 6,
        days: [3],
        anchor: '2026-09-03',
        weekend: 'after',
      }),
    ).toBe('Every 6 months, on the 3rd');
    expect(
      describeSchedule({
        unit: 'month',
        every: 12,
        days: [22],
        anchor: '2026-03-22',
        weekend: 'after',
      }),
    ).toBe('Every year, March 22nd');
  });
});

describe('recurringMatches', () => {
  it('needs the direction, and the name and amount when it gives them', () => {
    const m = {
      direction: 'in',
      description: { op: 'contains', value: 'brightline' },
      amount: { min: 230_000, max: 270_000 },
    } as const;
    expect(recurringMatches(m, pay('a', '2026-11-06'))).toBe(true);
    expect(recurringMatches(m, pay('b', '2026-11-06', -241_236))).toBe(false);
    expect(recurringMatches(m, pay('c', '2026-11-06', 200_000))).toBe(false);
    expect(recurringMatches({ direction: 'in' }, pay('d', '2026-11-06', 1))).toBe(true);
  });
});

describe('payOccurrences', () => {
  it('takes the closest payment within the window, once', () => {
    const paid = payOccurrences(
      ['2026-11-06', '2026-11-20'],
      [pay('early', '2026-11-05'), pay('stray', '2026-11-12'), pay('on', '2026-11-20')],
      3,
    );
    expect(paid.map((p) => [p.due, p.transactionId])).toEqual([
      ['2026-11-06', 'early'],
      ['2026-11-20', 'on'],
    ]);
  });

  it('leaves a date unpaid when nothing is close enough', () => {
    expect(payOccurrences(['2026-11-09'], [pay('late', '2026-11-16')], 3)).toEqual([]);
  });
});

describe('estimateNext', () => {
  it('averages the last three: a paycheck smaller on the 15th averages out over the month', () => {
    const paid = [
      { due: '2026-10-01', transactionId: 'a', date: '2026-10-01', amountMinor: 260_000 },
      { due: '2026-10-15', transactionId: 'b', date: '2026-10-15', amountMinor: 245_000 },
      { due: '2026-10-30', transactionId: 'c', date: '2026-10-30', amountMinor: 260_000 },
      { due: '2026-11-13', transactionId: 'd', date: '2026-11-13', amountMinor: 245_000 },
    ];
    expect(estimateNext(paid)).toBe(250_000);
    expect(estimateNext([])).toBeNull();
  });
});

describe('guessSchedule', () => {
  it('every 2 weeks, from Fridays', () => {
    const fridays = ['2026-09-25', '2026-10-09', '2026-10-23', '2026-11-06'];
    expect(guessSchedule(fridays, 'in')).toEqual({
      unit: 'week',
      every: 2,
      anchor: '2026-11-06',
      weekend: 'before',
    });
  });

  it('twice a month, the 1st and the 15th, even with some moved off a weekend', () => {
    const dates = [
      '2026-07-01',
      '2026-07-15',
      '2026-07-31', // Aug 1 is a Saturday
      '2026-08-14', // Aug 15 is a Saturday
      '2026-09-01',
      '2026-09-15',
      '2026-10-01',
      '2026-10-15',
    ];
    expect(guessSchedule(dates, 'in')).toMatchObject({ unit: 'month', every: 1, days: [1, 15] });
  });

  it('monthly on a day, and every 2 months', () => {
    expect(
      guessSchedule(['2026-08-24', '2026-09-24', '2026-10-26', '2026-11-24'], 'out'),
    ).toMatchObject({ unit: 'month', every: 1, days: [24], weekend: 'after' });
    expect(guessSchedule(['2026-05-09', '2026-07-09', '2026-09-09'], 'out')).toMatchObject({
      unit: 'month',
      every: 2,
      days: [9],
    });
  });

  it('needs two dates', () => {
    expect(guessSchedule(['2026-11-06'], 'in')).toBeNull();
  });
});
