// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Goal, GoalsOverview } from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { AllocateDialog, allocationOf, goalNames } from './AllocateDialog.js';

// Unclaimed money toward goals, by priority (#136, G25). The arithmetic is tested in the shared
// package (goal-allocation.test.ts), and who may confirm it in the api (GOAL-10).

const HH = '00000000-0000-7000-8000-0000000000aa';
const goal = (g: Partial<Goal> & Pick<Goal, 'id' | 'name'>): Goal => ({
  scope: 'household',
  kind: 'save',
  targetMinor: 500_000,
  targetDate: null,
  planMinor: null,
  position: 0,
  progressMinor: 0,
  shortMinor: 0,
  toMakeDateMinor: null,
  done: false,
  pace: { status: null, projectedMonth: null, monthsLate: null },
  icon: null,
  color: null,
  imageVersion: null,
  archivedAt: null,
  claims: [],
  debt: null,
  canEdit: true,
  version: 1,
  createdAt: '2026-11-01T00:00:00Z',
  ...g,
});
const data: GoalsOverview = {
  goals: [
    goal({ id: 'cushion', name: 'Cushion', targetMinor: 300_000, progressMinor: 100_000 }),
    goal({ id: 'done', name: 'Laptop', targetMinor: 100_000, progressMinor: 100_000, done: true }),
    goal({ id: 'trip', name: 'Japan trip', targetMinor: 600_000 }),
  ],
  archived: [],
  accounts: [
    {
      accountId: 'harbor',
      name: 'Harbor Savings',
      type: 'depository',
      subtype: 'savings',
      balanceMinor: 500_000,
      claimedMinor: 200_000,
      unclaimedMinor: 300_000,
    },
    {
      accountId: 'checking',
      name: 'Everyday checking',
      type: 'depository',
      subtype: 'checking',
      balanceMinor: 400_000,
      claimedMinor: 0,
      unclaimedMinor: 400_000,
    },
  ],
  debts: [],
  shortfalls: [],
  totals: { savedMinor: 200_000, plannedMinor: 0, owedMinor: 0, unclaimedMinor: 700_000 },
  canCreate: true,
};

let posted: unknown[];
beforeEach(() => {
  resetCsrf();
  posted = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    if (path.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    if (init.method === 'POST') posted.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 204 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('allocationOf', () => {
  it('suggests savings goals by priority from savings, never checking, skipping done goals', () => {
    expect(allocationOf(data)).toEqual([
      { goalId: 'cushion', accountId: 'harbor', amountMinor: 200_000 },
      { goalId: 'trip', accountId: 'harbor', amountMinor: 100_000 },
    ]);
    expect(goalNames(data, allocationOf(data))).toBe('Cushion and Japan trip');
  });

  it('suggests nothing to a viewer', () => {
    expect(allocationOf({ ...data, canCreate: false })).toEqual([]);
  });
});

describe('AllocateDialog', () => {
  it('earmarks only what you keep ticked, at the amount you say', async () => {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AllocateDialog
          householdId={HH}
          data={data}
          steps={allocationOf(data)}
          currency="USD"
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Reaches its target/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Earmark $3,000.00' })).toBeInTheDocument();
    // Nothing is sent until you confirm.
    expect(posted).toEqual([]);
    await userEvent.click(screen.getByRole('checkbox', { name: /Japan trip/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Earmark $2,000.00' }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posted).toEqual([
      { add: [{ goalId: 'cushion', accountId: 'harbor', amountMinor: 200_000 }] },
    ]);
  });
});
