// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { type WeeklyRecap, weeklyRecapSchema } from './api/recap.js';
import { renderWeeklyRecapEmail, weekLabel } from './recap-email.js';

// The prototype's recap (bills walkthrough §8, 07-weekly-recap.html): Alex's week, Nov 2–8.
const alex: WeeklyRecap = {
  householdName: 'Rivera Home',
  memberName: 'Alex',
  currency: 'USD',
  weekStart: '2026-11-02',
  weekEnd: '2026-11-08',
  today: '2026-11-09',
  sees: 'yours_and_ours',
  spending: { spentMinor: 61_240, usualMinor: 69_340 },
  budgets: { month: '2026-11', leftMinor: 128_810, daysLeft: 22 },
  netWorth: { netWorthMinor: 4_821_200, changeMinor: 120_400 },
  comingUp: [
    {
      due: '2026-11-09',
      name: 'Cascade Water',
      kind: 'bill',
      amountMinor: -6_420,
      about: true,
      lookAfter: 'Sam',
    },
    {
      due: '2026-11-13',
      name: 'County Schools payroll',
      kind: 'income',
      amountMinor: 198_000,
      about: false,
      lookAfter: null,
    },
  ],
  worthALook: [
    { kind: 'over_budget', category: 'Restaurants', overMinor: 4_130 },
    {
      kind: 'biggest_purchase',
      name: 'Costco',
      amountMinor: -41_218,
      account: 'Joint card',
      date: '2026-11-07',
    },
  ],
  toReview: 4,
  history: { seq: 18_342, hash: '7f3a91c2'.padEnd(64, '0') },
  quiet: false,
};

describe('renderWeeklyRecapEmail', () => {
  it('is a valid recap to start from', () => {
    expect(weeklyRecapSchema.parse(alex)).toEqual(alex);
  });

  it('reads like the walkthrough, in full detail', () => {
    const e = renderWeeklyRecapEmail(alex, { url: 'https://fiscus.example/h/1' });
    expect(e.subject).toBe('Your week in Fiscus: $612.40 spent, 1 bill coming up today');
    expect(e.text).toContain('Your week, Nov 2–8');
    expect(e.text).toContain('Rivera Home · what you can see: yours and ours.');
    expect(e.text).toContain('Spent: $612.40 ($81 less than usual)');
    expect(e.text).toContain('Left in November’s budgets: $1,288.10 (22 days to go)');
    expect(e.text).toContain('Net worth: $48,212 (+$1,204 this week)');
    expect(e.text).toContain('Mon 9  Cascade Water · Sam looks after it  about $64.20');
    expect(e.text).toContain('+$1,980.00');
    expect(e.text).toContain('Restaurants is $41.30 over its budget');
    expect(e.text).toContain('Costco, $412.18 on Joint card · your biggest this week');
    expect(e.text).toContain('4 transactions are waiting for review.');
    expect(e.text).toContain('Activity history: entry 18,342 · 7f3a 91c2.');
    expect(e.text).toContain('This email has full detail.');
    expect(e.html).toContain('<h1 style="font-size:20px;margin:0">Your week, Nov 2–8</h1>');
    expect(e.html).toContain('href="https://fiscus.example/h/1"');
  });

  it('says less in summary: amounts, but no names', () => {
    const e = renderWeeklyRecapEmail(alex, { detail: 'summary' });
    expect(e.subject).toBe('Your week in Fiscus: $612.40 spent, 1 bill coming up today');
    expect(e.text).toContain('Spent: $612.40');
    for (const name of ['Costco', 'Cascade Water', 'Restaurants', 'Joint card', 'Sam']) {
      expect(e.text).not.toContain(name);
      expect(e.html).not.toContain(name);
    }
    expect(e.text).toContain('1 category over budget');
  });

  it('says nothing about money in minimal', () => {
    const e = renderWeeklyRecapEmail(alex, { detail: 'minimal' });
    expect(e.subject).toBe('Your week in Fiscus');
    expect(e.text).not.toMatch(/\$/);
    expect(e.html).not.toMatch(/\$/);
    expect(e.text).toContain('Your weekly recap is ready in Fiscus.');
    // The history head isn't about money, and is what a kept email is for.
    expect(e.text).toContain('entry 18,342');
  });

  it('is short on a quiet week, and says so', () => {
    const quiet: WeeklyRecap = {
      ...alex,
      sees: null,
      spending: { spentMinor: 0, usualMinor: null },
      budgets: null,
      netWorth: null,
      comingUp: [],
      worthALook: [],
      toReview: 0,
      quiet: true,
    };
    const e = renderWeeklyRecapEmail(quiet);
    expect(e.subject).toBe('Your week in Fiscus: a quiet one');
    expect(e.text).toContain('Rivera Home.');
    expect(e.text).toContain('A quiet week: nothing spent, and nothing coming up.');
    expect(e.text).not.toContain('Coming up this week');
    expect(e.text).not.toContain('Worth a look');
  });

  it('escapes names in the HTML', () => {
    const e = renderWeeklyRecapEmail({
      ...alex,
      worthALook: [
        {
          kind: 'biggest_purchase',
          name: '<script>alert(1)</script>',
          amountMinor: -100,
          account: null,
          date: '2026-11-07',
        },
      ],
    });
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;');
  });
});

describe('weekLabel', () => {
  it('names the month once, or both across months', () => {
    expect(weekLabel('2026-11-02', '2026-11-08')).toBe('Nov 2–8');
    expect(weekLabel('2026-10-26', '2026-11-01')).toBe('Oct 26–Nov 1');
  });
});
