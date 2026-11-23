// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Goal, GoalContributions, HouseholdMember } from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { GoalDetail } from './goal-detail.js';

// Who's put in, up close (#133, GOAL-09): a viewer can't edit a goal, so it's here, where
// everyone who sees the goal looks, not in its edit dialog.

const HH = '00000000-0000-7000-8000-0000000000aa';
const member = (id: string, displayName: string, fields: Partial<HouseholdMember> = {}) => ({
  id,
  displayName,
  color: '#2563eb',
  role: 'member' as const,
  joinedAt: '2026-01-01T00:00:00.000Z',
  historyFrom: null,
  isYou: false,
  ...fields,
});
const members: HouseholdMember[] = [
  member('m1', 'Alex'),
  member('m2', 'Sam'),
  member('m3', 'Robin', { role: 'viewer', isYou: true }),
];
const goal = (fields: Partial<Goal> = {}): Goal => ({
  id: '00000000-0000-7000-8000-000000000001',
  scope: 'household',
  kind: 'save',
  name: 'Trip',
  targetMinor: 300_000,
  targetDate: null,
  planMinor: null,
  position: 0,
  progressMinor: 90_000,
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
  canEdit: false,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...fields,
});
const contributions: GoalContributions = {
  goalId: goal().id,
  thisMonth: '2026-11',
  members: [
    { memberId: 'm1', totalMinor: 60_000, thisMonthMinor: 10_000 },
    { memberId: 'm2', totalMinor: 30_000, thisMonthMinor: 0 },
  ],
  totalMinor: 90_000,
  months: [],
};

let asked: string[];
beforeEach(() => {
  resetCsrf();
  asked = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url, 'http://x').pathname;
    asked.push(path);
    if (path.endsWith('/contributions')) {
      return new Response(JSON.stringify({ data: contributions }));
    }
    // Its progress isn't what's under test: it shows that it couldn't load.
    return new Response(JSON.stringify({ title: 'Not found', status: 404 }), {
      status: 404,
      headers: { 'content-type': 'application/problem+json' },
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (g: Goal, people = members) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <GoalDetail
        householdId={HH}
        goal={g}
        members={people}
        currency="USD"
        onEdit={g.canEdit ? () => {} : undefined}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );

describe('GoalDetail: who’s put in (#133)', () => {
  it('shows a viewer each member’s contributions to an Ours goal, with no way to edit', async () => {
    show(goal());
    const panel = await screen.findByRole('region', { name: /Who’s put in/ });
    const [alex, sam] = await within(panel).findAllByRole('listitem');
    expect(alex).toHaveTextContent('Alex');
    expect(alex).toHaveTextContent('$100.00 this month');
    expect(alex).toHaveTextContent('$600.00');
    expect(within(alex!).getByRole('img')).toHaveAccessibleName('67% of what’s been put in');
    expect(sam).toHaveTextContent('Sam');
    expect(sam).toHaveTextContent('$300.00');
    expect(screen.queryByRole('button', { name: 'Edit goal' })).toBeNull();
  });

  it('leaves it out of a Mine goal', async () => {
    show(goal({ scope: 'mine', canEdit: true }));
    expect(await screen.findByRole('button', { name: 'Edit goal' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Who’s put in/ })).toBeNull();
    expect(asked.some((p) => p.endsWith('/contributions'))).toBe(false);
  });

  it('leaves it out of a household of one', async () => {
    show(goal(), [members[2]!]);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Who’s put in/ })).toBeNull();
    expect(asked.some((p) => p.endsWith('/contributions'))).toBe(false);
  });
});
