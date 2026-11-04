// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WeeklyRecap } from '@fiscus/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WeeklyRecapView } from './WeeklyRecapCard.js';

// The weekly recap card on the dashboard (#128; bills walkthrough §8).

const week: WeeklyRecap = {
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
  ],
  worthALook: [
    {
      kind: 'biggest_purchase',
      name: 'Costco',
      amountMinor: -41_218,
      account: 'Joint card',
      date: '2026-11-07',
    },
  ],
  toReview: 4,
  history: { seq: 18_342, hash: 'a'.repeat(64) },
  quiet: false,
};

describe('WeeklyRecapView', () => {
  it('shows the week’s numbers, what’s coming up, and what’s worth a look', () => {
    render(<WeeklyRecapView recap={week} />);
    expect(screen.getByRole('heading', { name: 'Your week, Nov 2–8' })).toBeInTheDocument();
    expect(screen.getByText('What you can see: yours and ours.')).toBeInTheDocument();
    expect(screen.getByText('$612.40')).toBeInTheDocument();
    expect(screen.getByText(/less than usual/)).toHaveTextContent('$81 less than usual');
    expect(screen.getByText('Left in November’s budgets')).toBeInTheDocument();
    expect(screen.getByText(/Cascade Water/)).toHaveTextContent(
      'Cascade Water · Sam looks after it',
    );
    expect(screen.getByText(/Costco/)).toHaveTextContent('Costco, $412.18 on Joint card');
    expect(screen.getByText(/waiting for review/)).toHaveTextContent(
      '4 transactions are waiting for review.',
    );
  });

  it('is short on a quiet week, and says so', () => {
    render(
      <WeeklyRecapView
        recap={{
          ...week,
          sees: null,
          spending: { spentMinor: 0, usualMinor: null },
          budgets: null,
          netWorth: null,
          comingUp: [],
          worthALook: [],
          toReview: 0,
          quiet: true,
        }}
      />,
    );
    expect(
      screen.getByText('A quiet week: nothing spent, and nothing coming up.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Rivera Home.')).toBeInTheDocument();
    expect(screen.queryByText('Coming up this week')).toBeNull();
    expect(screen.queryByText('Spent')).toBeNull();
  });
});
