// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  everydaySpending,
  firstDip,
  forecast,
  type ForecastCard,
  type ForecastEvent,
  type ForecastInput,
  spreadEvenly,
} from './forecast.js';

const TODAY = '2026-11-12';
const ev = (
  date: string,
  name: string,
  amountMinor: number,
  kind: ForecastEvent['kind'] = amountMinor > 0 ? 'income' : 'bill',
  extra: Partial<ForecastEvent> = {},
): ForecastEvent => ({
  accountId: 'checking',
  date,
  name,
  amountMinor,
  kind,
  reason: '',
  ...extra,
});

/** The Riveras' Everyday checking, to Alex's paycheck on Dec 4 (planning walkthrough §1). */
const riveras = (): ForecastInput => ({
  today: TODAY,
  days: 22, // to Dec 4
  accounts: [
    { id: 'checking', kind: 'cash', balanceMinor: 168640 },
    { id: 'card', kind: 'card', balanceMinor: -241000 },
  ],
  events: [
    ev('2026-11-12', 'Cascade Water', -6420),
    ev('2026-11-13', 'County Schools payroll', 198000),
    ev('2026-11-20', 'Brightline Labs payroll', 241236),
    ev('2026-11-24', 'Lakeside Power', -13100),
    ev('2026-11-30', 'County Schools payroll', 198000),
    ev('2026-12-01', 'Mortgage', -214000),
    ev('2026-12-02', 'Atlas Mutual', -128400),
    ev('2026-12-03', 'Little Oaks Daycare', -145000),
    ev('2026-12-04', 'Brightline Labs payroll', 241236),
  ],
  cards: [
    {
      accountId: 'card',
      payFromAccountId: 'checking',
      payStyle: { kind: 'full' },
      statement: {
        dueDate: '2026-11-23',
        balanceMinor: 180722,
        minimumMinor: 4000,
        paidSoFarMinor: 0,
      },
      later: [],
      minimumOf: () => 4000,
    },
  ],
  spending: [{ accountId: 'checking', from: TODAY, to: '2026-12-04', totalMinor: 23 * 3800 }],
});

describe('the cash-flow forecast (#166)', () => {
  it('reaches the walkthrough’s low point: $346.34 on Dec 3, before Alex’s paycheck', () => {
    const f = forecast(riveras()).get('checking')!;
    expect(f.todayMinor).toBe(168640);
    expect(f.daily).toHaveLength(23);
    expect(f.lowest).toEqual({ date: '2026-12-03', balanceMinor: 34634 });
    expect(f.daily.find((d) => d.date === '2026-12-04')!.balanceMinor).toBe(34634 + 241236 - 3800);
    // The statement is paid in full from checking on its due date, and the card gets it.
    const st = f.lines.find((l) => l.kind === 'statement')!;
    expect(st).toMatchObject({ date: '2026-11-23', amountMinor: -180722 });
    expect(st.balanceAfterMinor).toBe(378934); // as in the walkthrough's list
    const card = forecast(riveras()).get('card')!;
    expect(card.endMinor).toBe(-241000 + 180722);
  });

  it('warns once for the dip, blaming what went out since the last paycheck (P7)', () => {
    const f = forecast(riveras()).get('checking')!;
    const dip = firstDip(f, 50000, 30)!;
    expect(dip.from).toBe('2026-12-03');
    expect(dip.lowest).toEqual({ date: '2026-12-03', balanceMinor: 34634 });
    expect(dip.causes.map((c) => c.name)).toEqual([
      'Mortgage',
      'Little Oaks Daycare',
      'Atlas Mutual',
    ]);
    // Too far ahead for someone looking 14 days out, or a lower warning.
    expect(firstDip(f, 50000, 14)).toBeNull();
    expect(firstDip(f, 30000, 90)).toBeNull();
  });

  it('counts money out before money in on the same day', () => {
    const f = forecast({
      today: TODAY,
      days: 1,
      accounts: [{ id: 'checking', kind: 'cash', balanceMinor: 1000 }],
      events: [ev(TODAY, 'Pay', 5000), ev(TODAY, 'Rent', -4000)],
      cards: [],
      spending: [],
    }).get('checking')!;
    expect(f.lines.map((l) => [l.name, l.balanceAfterMinor])).toEqual([
      ['Rent', -3000],
      ['Pay', 2000],
    ]);
    expect(f.lowest.balanceMinor).toBe(1000); // days end at 2000; nothing below today's
    expect(f.inMinor).toBe(5000);
    expect(f.outMinor).toBe(4000);
  });

  it('moves a transfer between two accounts in the forecast, and leaves out the rest', () => {
    const out = forecast({
      today: TODAY,
      days: 30,
      accounts: [
        { id: 'checking', kind: 'cash', balanceMinor: 500000 },
        { id: 'savings', kind: 'cash', balanceMinor: 0 },
      ],
      events: [
        ev('2026-12-05', 'To Harbor Savings', -130000, 'transfer', { toAccountId: 'savings' }),
        ev('2026-11-01', 'Before today', -1),
        ev('2027-01-05', 'After the end', -1),
        { ...ev('2026-11-20', 'Someone else’s', -1), accountId: 'private' },
      ],
      cards: [],
      spending: [],
    });
    expect(out.get('checking')!.endMinor).toBe(370000);
    expect(out.get('savings')!.endMinor).toBe(130000);
    expect(out.get('savings')!.lines[0]).toMatchObject({ kind: 'transfer', amountMinor: 130000 });
    expect(out.get('checking')!.lines).toHaveLength(1);
    expect(out.has('private')).toBe(false);
  });

  describe('cards (P3)', () => {
    const card = (payStyle: ForecastCard['payStyle']): ForecastInput => ({
      today: TODAY,
      days: 60,
      accounts: [
        { id: 'checking', kind: 'cash', balanceMinor: 1_000_000 },
        { id: 'card', kind: 'card', balanceMinor: -150000 },
      ],
      events: [
        {
          accountId: 'card',
          date: '2026-11-14',
          name: 'Streamly',
          amountMinor: -1549,
          kind: 'subscription',
          reason: '',
        },
      ],
      cards: [
        {
          accountId: 'card',
          payFromAccountId: 'checking',
          payStyle,
          statement: {
            dueDate: '2026-11-21',
            balanceMinor: 120000,
            minimumMinor: 4000,
            paidSoFarMinor: 20000,
          },
          later: [{ closeDate: '2026-11-26', dueDate: '2026-12-21' }],
          minimumOf: (owed) => Math.max(2500, Math.round(owed * 0.02)),
        },
      ],
      spending: [{ accountId: 'card', from: TODAY, to: '2026-11-26', totalMinor: 15 * 1000 }],
    });

    it('pays the rest of the statement in full, then the next one at what the card owes', () => {
      const f = forecast(card({ kind: 'full' }));
      const paid = f.get('checking')!.lines.map((l) => [l.date, l.amountMinor]);
      // 1 200.00 less the 200.00 already paid; then what it owes when the next one closes:
      // 1 500.00 + 15.49 + 150.00 of spending − 1 000.00 paid = 665.49.
      expect(paid).toEqual([
        ['2026-11-21', -100000],
        ['2026-12-21', -66549],
      ]);
      expect(f.get('card')!.endMinor).toBe(0);
      expect(f.get('card')!.spendingMinor).toBe(15000);
    });

    it('pays only the minimum, when that’s what the last ones were', () => {
      const f = forecast(card({ kind: 'minimum' }));
      const paid = f.get('checking')!.lines.map((l) => [l.date, l.amountMinor]);
      // 40.00 less the 200.00 paid is nothing; the next: 2% of 1 665.49.
      expect(paid).toEqual([['2026-12-21', -3331]]);
    });

    it('pays the usual amount, at least the minimum and at most what’s owed', () => {
      const f = forecast(card({ kind: 'fixed', amountMinor: 50000 }));
      expect(f.get('checking')!.lines.map((l) => l.amountMinor)).toEqual([-50000, -50000]);
    });

    it('only moves the card when its payments come from elsewhere', () => {
      const input = card({ kind: 'full' });
      const f = forecast({ ...input, cards: [{ ...input.cards[0]!, payFromAccountId: null }] });
      expect(f.get('checking')!.lines).toEqual([]);
      expect(f.get('card')!.lines.filter((l) => l.kind === 'statement')).toHaveLength(2);
    });
  });
});

describe('spreading everyday spending (P2)', () => {
  it('spreads an amount over days to the cent, odd cents first', () => {
    expect(spreadEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(spreadEvenly(-5, 2)).toEqual([-3, -2]);
    expect(spreadEvenly(100, 0)).toEqual([]);
    for (const [t, n] of [
      [123457, 19],
      [1, 30],
      [99999, 7],
    ] as const)
      expect(spreadEvenly(t, n).reduce((a, b) => a + b, 0)).toBe(t);
  });

  it('spreads what’s left of each budget, less its bills, from the accounts it’s paid from', () => {
    const spending = everydaySpending('2026-11-21', 45, [
      {
        // Groceries: $300 left in November, $700 in December and January; 3/4 on the card.
        leftThisMonthMinor: 30000,
        laterMonthsMinor: new Map([
          ['2026-12', 70000],
          ['2027-01', 70000],
        ]),
        billsMinor: new Map(),
        accounts: new Map([
          ['card', 7500],
          ['checking', 2500],
        ]),
      },
      {
        // Utilities: $200 a month, of which Lakeside Power's ~$131 is forecast on its own.
        leftThisMonthMinor: 20000,
        laterMonthsMinor: new Map([['2026-12', 20000]]),
        billsMinor: new Map([
          ['2026-11', 13100],
          ['2026-12', 14800],
        ]),
        accounts: new Map([['checking', 10000]]),
      },
    ]);
    const of = (account: string, month: string) =>
      spending
        .filter((s) => s.accountId === account && s.from.startsWith(month))
        .reduce((a, s) => a + s.totalMinor, 0);
    expect(of('card', '2026-11')).toBe(22500);
    expect(of('checking', '2026-11')).toBe(7500 + 6900);
    expect(of('checking', '2026-12')).toBe(17500 + 5200);
    expect(of('card', '2027-01')).toBe(52500);
    // November from today, then whole months.
    expect(spending.find((s) => s.accountId === 'card' && s.from === '2026-11-21')!.to).toBe(
      '2026-11-30',
    );
    expect(spending.some((s) => s.from === '2026-12-01' && s.to === '2026-12-31')).toBe(true);
  });

  it('spends it in the forecast, day by day', () => {
    const f = forecast({
      today: '2026-11-21',
      days: 9,
      accounts: [{ id: 'checking', kind: 'cash', balanceMinor: 10000 }],
      events: [],
      cards: [],
      spending: [{ accountId: 'checking', from: '2026-11-21', to: '2026-11-30', totalMinor: 1001 }],
    }).get('checking')!;
    expect(f.daily.map((d) => d.balanceMinor)).toEqual([
      9899, 9799, 9699, 9599, 9499, 9399, 9299, 9199, 9099, 8999,
    ]);
    expect(f.spendingMinor).toBe(1001);
    expect(f.lines).toEqual([]);
  });
});
