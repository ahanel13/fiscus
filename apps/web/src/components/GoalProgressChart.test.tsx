// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GoalProgress } from '@fiscus/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GoalProgressChart } from './GoalProgressChart.js';

// A savings goal's chart (goals walkthrough §3, #135).

const progress: GoalProgress = {
  goalId: 'trip',
  thisMonth: '2026-11',
  monthFraction: 0.5,
  months: [
    { month: '2026-09', savedMinor: 500_000, movedMinor: 0, marketMinor: 0, claimsMinor: 500_000 },
    {
      month: '2026-10',
      savedMinor: 480_000,
      movedMinor: 150_000,
      marketMinor: -20_000,
      claimsMinor: 0,
    },
    { month: '2026-11', savedMinor: 480_000, movedMinor: 0, marketMinor: 0, claimsMinor: 0 },
  ],
  pace: {
    status: 'on_track',
    projectedMonth: '2027-03',
    monthsLate: 0,
    paceMinor: 150_000,
    basis: 'moved',
  },
  projection: [
    { month: '2026-11', savedMinor: 630_000 },
    { month: '2026-12', savedMinor: 780_000 },
    { month: '2027-01', savedMinor: 930_000 },
    { month: '2027-02', savedMinor: 1_080_000 },
    { month: '2027-03', savedMinor: 1_200_000 },
  ],
  steady: { fromMonth: '2026-09', fromMinor: 500_000, toMonth: '2027-06', toMinor: 1_200_000 },
  fixes: { planMinor: null, month: null },
};

describe('GoalProgressChart', () => {
  it('names its lines, and says where the pace leads', () => {
    render(
      <GoalProgressChart
        progress={progress}
        progressMinor={480_000}
        targetMinor={1_200_000}
        currency="USD"
      />,
    );
    for (const name of ['Saved', 'At this pace', 'Steady to the date']) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Target $12,000.00')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Saved over time' })).toHaveAccessibleDescription(
      /\$4,800\.00 saved of \$12,000\.00\. At this pace, it gets there in Mar 2027\./,
    );
  });

  it('shows a month’s saving, what moved in and the market at the crosshair', () => {
    render(
      <GoalProgressChart
        progress={progress}
        progressMinor={480_000}
        targetMinor={1_200_000}
        currency="USD"
      />,
    );
    const plot = screen.getByRole('group', { name: 'Saved over time' });
    fireEvent.focus(plot);
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(screen.getByText('Moved in').nextSibling).toHaveTextContent('$1,500.00');
    expect(screen.getByText('Market').nextSibling).toHaveTextContent(/200\.00/);
    // A steady line's months fall between cents: shown to the cent.
    expect(screen.getAllByText('Steady to the date').at(-1)!.nextSibling).toHaveTextContent(
      '$5,777.78',
    );
    // Ahead of now: the projection.
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(screen.getAllByText('At this pace').at(-1)!.nextSibling).toHaveTextContent('$6,300.00');
  });
});
