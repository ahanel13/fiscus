// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  detectRecurring,
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
  showWho,
  statementPaid,
  whoLooksAfter,
  paymentsPerYear,
  seriesChanges,
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

describe('a weekday in the month', () => {
  const firstFriday = {
    unit: 'month' as const,
    every: 1,
    weekday: { nth: 1 as const, day: 5 },
    anchor: '2026-11-06',
    weekend: 'as_is' as const,
  };

  it('comes on the first Friday, or the last Monday, of each month', () => {
    expect(occurrences(firstFriday, '2026-11-01', '2027-02-28')).toEqual([
      '2026-11-06',
      '2026-12-04',
      '2027-01-01',
      '2027-02-05',
    ]);
    const lastMonday = { ...firstFriday, weekday: { nth: -1 as const, day: 1 } };
    expect(occurrences(lastMonday, '2026-11-01', '2027-01-31')).toEqual([
      '2026-11-30',
      '2026-12-28',
      '2027-01-25',
    ]);
    // The third Wednesday, every 3 months from November.
    const quarterly = { ...firstFriday, every: 3, weekday: { nth: 3 as const, day: 3 } };
    expect(nextOccurrences(quarterly, '2026-11-01', 2)).toEqual(['2026-11-18', '2027-02-17']);
  });

  it('says it in words, and takes days or a weekday, not both', () => {
    expect(describeSchedule(firstFriday)).toBe('Every month, on the first Friday');
    expect(describeSchedule({ ...firstFriday, every: 12 })).toBe(
      'Every year, the first Friday of November',
    );
    expect(recurringScheduleSchema.safeParse(firstFriday).success).toBe(true);
    expect(recurringScheduleSchema.safeParse({ ...firstFriday, days: [1] }).success).toBe(false);
    const { weekday: _, ...neither } = firstFriday;
    expect(recurringScheduleSchema.safeParse(neither).success).toBe(false);
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

  it('a late payment still pays its date, until the next one is due', () => {
    const paid = payOccurrences(['2026-09-09', '2026-11-09'], [pay('late', '2026-09-16')], 3);
    expect(paid.map((p) => [p.due, p.transactionId])).toEqual([['2026-09-09', 'late']]);
  });

  it('but not one that belongs to the next date', () => {
    // Monthly on the 24th: Nov 22 is early for Nov 24, not late for Oct 24.
    const paid = payOccurrences(['2026-10-24', '2026-11-24'], [pay('nov', '2026-11-22')], 3);
    expect(paid.map((p) => [p.due, p.transactionId])).toEqual([['2026-11-24', 'nov']]);
  });

  it('takes a payment someone linked first, wherever it is', () => {
    const paid = payOccurrences(
      ['2026-11-06', '2026-11-20'],
      [pay('a', '2026-11-06'), pay('b', '2026-11-20')],
      3,
      new Map([['2026-11-20', pay('a', '2026-11-06')]]),
    );
    expect(paid.map((p) => [p.due, p.transactionId])).toEqual([['2026-11-20', 'a']]);
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
    expect(estimateNext(paid, 4)).toBe(252_500);
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

describe('detectRecurring', () => {
  const group = (
    dates: string[],
    amounts: (i: number) => number,
    direction: 'in' | 'out' = 'out',
  ) => ({
    accountId: 'acct',
    direction,
    key: 'lakeside power',
    name: 'Lakeside Power',
    transfer: false,
    payments: dates.map((date, i) => ({
      id: `p${i}`,
      date,
      amountMinor: (direction === 'out' ? -1 : 1) * amounts(i),
      displayName: 'Lakeside Power',
      originalDescription: 'LAKESIDE PWR',
    })),
  });
  const monthly = [
    '2026-05-24',
    '2026-06-24',
    '2026-07-24',
    '2026-08-24',
    '2026-09-24',
    '2026-10-24',
  ];

  it('finds a monthly bill that varies, with room for its amounts', () => {
    const found = detectRecurring(
      group(monthly, (i) => 9_600 + i * 900),
      '2026-11-12',
    )!;
    expect(found.kind).toBe('bill');
    expect(found.draft.schedule).toMatchObject({ unit: 'month', every: 1, days: [24] });
    expect(found.draft.match.amount!.min).toBeLessThanOrEqual(9_600);
    expect(found.draft.match.amount!.max).toBeGreaterThanOrEqual(14_100);
    expect(found.next).toBe('2026-11-24');
  });

  it('leaves out one that stopped', () => {
    expect(
      detectRecurring(
        group(monthly, () => 9_600),
        '2027-03-01',
      ),
    ).toBeNull();
    // Its Nov 24 payment never came: a week and a half later, it's ended.
    expect(
      detectRecurring(
        group(monthly, () => 9_600),
        '2026-12-05',
      ),
    ).toBeNull();
  });

  it('leaves out a yearly one that missed its year', () => {
    const yearly = ['2023-03-03', '2024-03-04', '2025-03-03'];
    const g = { ...group(yearly, () => 9_900), key: 'atlas', name: 'Atlas' };
    expect(detectRecurring(g, '2026-11-12')).toBeNull();
    expect(detectRecurring(g, '2025-11-12')).not.toBeNull();
  });

  it('leaves out spending that’s frequent but not steady', () => {
    const groceries = [
      '2026-10-02',
      '2026-10-05',
      '2026-10-13',
      '2026-10-15',
      '2026-10-24',
      '2026-10-31',
      '2026-11-03',
      '2026-11-11',
    ];
    expect(
      detectRecurring(
        group(groceries, (i) => 4_000 + i * 1_300),
        '2026-11-12',
      ),
    ).toBeNull();
  });

  it('needs three', () => {
    expect(
      detectRecurring(
        group(monthly.slice(-2), () => 9_600),
        '2026-11-12',
      ),
    ).toBeNull();
  });

  it('finds a paycheck twice a month', () => {
    const dates = [
      '2026-08-14',
      '2026-09-01',
      '2026-09-15',
      '2026-10-01',
      '2026-10-15',
      '2026-10-30',
    ];
    const found = detectRecurring(
      group(dates, (i) => (i % 2 ? 260_000 : 245_000), 'in'),
      '2026-11-12',
    )!;
    expect(found.kind).toBe('income');
    expect(found.draft.schedule).toMatchObject({ unit: 'month', days: [1, 15], weekend: 'before' });
  });
});

describe('whoLooksAfter (D13)', () => {
  const [alex, sam, jo] = ['alex', 'sam', 'jo'];
  const base = {
    kind: 'bill' as const,
    responsibleMemberId: null,
    createdByMemberId: alex,
    seenBy: [alex, sam],
    accountOwners: [sam],
    householdOwners: [alex],
  };

  it('is the account’s only owner, whoever confirmed it', () => {
    expect(whoLooksAfter(base)).toBe(sam);
  });

  it('is whoever confirmed it, for a joint account', () => {
    expect(whoLooksAfter({ ...base, accountOwners: [sam, alex] })).toBe(alex);
    expect(whoLooksAfter({ ...base, accountOwners: [sam, alex], createdByMemberId: sam })).toBe(
      sam,
    );
  });

  it('is whoever was chosen, while they still see the account', () => {
    expect(whoLooksAfter({ ...base, responsibleMemberId: alex })).toBe(alex);
    // Jo can't see it (any more): back to the default.
    expect(whoLooksAfter({ ...base, responsibleMemberId: jo })).toBe(sam);
  });

  it('falls back to an owner of the account, then of the household', () => {
    // Made by someone who's gone, on a joint account.
    expect(whoLooksAfter({ ...base, createdByMemberId: jo, accountOwners: [sam, alex] })).toBe(sam);
    // No owner left who sees it.
    expect(whoLooksAfter({ ...base, createdByMemberId: jo, accountOwners: [] })).toBe(alex);
    expect(
      whoLooksAfter({ ...base, createdByMemberId: jo, accountOwners: [], seenBy: [] }),
    ).toBeNull();
  });

  it('is nobody for income, which has "for" instead', () => {
    expect(whoLooksAfter({ ...base, kind: 'income', responsibleMemberId: alex })).toBeNull();
  });
});

describe('showWho (D22)', () => {
  it('shows a person only when more than one member sees it', () => {
    expect(showWho([])).toBe(false);
    expect(showWho(['alex'])).toBe(false);
    expect(showWho(['alex', 'sam'])).toBe(true);
  });
});

describe('statementPaid (D9)', () => {
  it('is paid at the balance, minimum paid at the minimum, partly paid below it', () => {
    expect(statementPaid(50_000, 3_500, 50_000)).toBe('paid');
    expect(statementPaid(50_000, 3_500, 60_000)).toBe('paid');
    expect(statementPaid(50_000, 3_500, 3_500)).toBe('minimum');
    expect(statementPaid(50_000, 3_500, 1_000)).toBe('part');
    expect(statementPaid(50_000, 3_500, 0)).toBeNull();
    // No minimum reported: anything short of the balance is part of it.
    expect(statementPaid(50_000, null, 10_000)).toBe('part');
  });
});

describe('seriesChanges (D14)', () => {
  const months = [
    '2026-05-10',
    '2026-06-10',
    '2026-07-10',
    '2026-08-10',
    '2026-09-10',
    '2026-10-10',
  ];
  const pays = (amounts: number[]) =>
    amounts.map((a, i) => ({
      due: months[i]!,
      transactionId: `t${i}`,
      date: months[i]!,
      amountMinor: -a,
    }));
  const base = {
    kind: 'subscription' as const,
    dates: months,
    skipped: new Set<string>(),
    since: '2026-05-10',
    createdOn: '2026-05-01',
    endedOn: null,
    today: '2026-10-20',
  };

  it('sees a price that went up and stayed up', () => {
    const c = seriesChanges({
      ...base,
      payments: pays([1_549, 1_549, 1_549, 1_549, 2_049, 2_049]),
    });
    expect(c.priceUp).toEqual({ changeMinor: 500, since: '2026-09-10' });
  });

  it('doesn’t count one odd payment, a rise that went back, or a small move', () => {
    expect(
      seriesChanges({ ...base, payments: pays([1_549, 1_549, 1_549, 1_549, 1_549, 2_049]) })
        .priceUp,
    ).toBeNull();
    expect(
      seriesChanges({ ...base, payments: pays([1_549, 1_549, 1_549, 1_549, 2_049, 1_549]) })
        .priceUp,
    ).toBeNull();
    expect(
      seriesChanges({ ...base, payments: pays([1_549, 1_549, 1_549, 1_549, 1_599, 1_599]) })
        .priceUp,
    ).toBeNull();
  });

  it('needs five payments, isn’t news after 120 days, and isn’t for income', () => {
    expect(
      seriesChanges({
        ...base,
        payments: pays([1_549, 1_549, 2_049, 2_049]),
        dates: months.slice(0, 4),
      }).priceUp,
    ).toBeNull();
    expect(
      seriesChanges({
        ...base,
        payments: pays([1_549, 1_549, 1_549, 1_549, 2_049, 2_049]),
        today: '2027-02-01',
      }).priceUp,
    ).toBeNull();
    expect(
      seriesChanges({
        ...base,
        kind: 'income',
        payments: pays([1_549, 1_549, 1_549, 1_549, 2_049, 2_049]),
      }).priceUp,
    ).toBeNull();
  });

  it('calls a subscription new while its first payment is recent', () => {
    const recent = { ...base, dates: months.slice(-1), since: '2026-10-10' };
    expect(seriesChanges({ ...recent, payments: pays([0, 0, 0, 0, 0, 999]).slice(-1) }).isNew).toBe(
      true,
    );
    expect(seriesChanges({ ...base, payments: pays([999, 999, 999]) }).isNew).toBe(false);
    // Confirmed with nothing paid yet.
    expect(seriesChanges({ ...base, payments: [], createdOn: '2026-10-01' }).isNew).toBe(true);
    expect(
      seriesChanges({ ...recent, kind: 'bill', payments: pays([0, 0, 0, 0, 0, 999]).slice(-1) })
        .isNew,
    ).toBe(false);
  });

  it('looks ended after two late dates in a row, not one, and not once ended', () => {
    const four = pays([999, 999, 999, 999]);
    expect(seriesChanges({ ...base, payments: four }).looksEnded).toBe(true);
    expect(seriesChanges({ ...base, payments: pays([999, 999, 999, 999, 999]) }).looksEnded).toBe(
      false,
    );
    expect(seriesChanges({ ...base, payments: four, endedOn: '2026-08-31' }).looksEnded).toBe(
      false,
    );
    // A skipped one, or one paid another way, isn't late.
    expect(
      seriesChanges({ ...base, payments: four, skipped: new Set(['2026-10-10']) }).looksEnded,
    ).toBe(false);
    expect(
      seriesChanges({ ...base, payments: four, markedPaid: new Set(['2026-09-10']) }).looksEnded,
    ).toBe(false);
  });
});

describe('paymentsPerYear', () => {
  it('counts weeks, months, twice a month and days', () => {
    expect(
      paymentsPerYear({ unit: 'week', every: 2, anchor: '2026-01-02', weekend: 'as_is' }),
    ).toBe(26);
    expect(
      paymentsPerYear({
        unit: 'month',
        every: 1,
        days: [1, 15],
        anchor: '2026-01-01',
        weekend: 'as_is',
      }),
    ).toBe(24);
    expect(
      paymentsPerYear({
        unit: 'month',
        every: 12,
        days: [3],
        anchor: '2026-01-03',
        weekend: 'as_is',
      }),
    ).toBe(1);
  });
});
