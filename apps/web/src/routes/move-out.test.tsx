// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MemberMove, MoveOutPreview } from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { MoveInCard, MoveOutPlan } from './move-out.js';

// Moving out (#253, HH-20, D37): the preview and starting it. Who may, and what moves, is tested
// in the api and the worker.

const navigate = vi.fn();
vi.mock(import('@tanstack/react-router'), async (original) => ({
  ...(await original()),
  createLink: ((Link: ComponentType<Record<string, unknown>>) =>
    ({ to, params: _params, ...rest }: Record<string, unknown>) => (
      <Link {...rest} href={to} />
    )) as never,
  useNavigate: (() => navigate) as never,
}));

const HH = '00000000-0000-7000-8000-0000000000aa';
const NEW = '00000000-0000-7000-8000-0000000000bb';

const preview = (over: Partial<MoveOutPreview> = {}): MoveOutPreview => ({
  blockers: [],
  moving: null,
  moves: {
    accounts: [
      { id: 'a1', name: 'Sam’s checking', transactionCount: 214, connection: 'moves' },
      { id: 'a2', name: 'Sam’s savings', transactionCount: 1, connection: 'relink' },
    ],
    connections: [{ id: 'c1', institutionName: 'Chase', outcome: 'moves', accountCount: 1 }],
    budget: true,
    goals: [{ id: 'g1', name: 'Trip', wasHousehold: false }],
    rules: [{ id: 'r1', name: 'Coffee' }],
    forOthers: 2,
  },
  stays: {
    jointAccounts: [
      {
        id: 'j1',
        name: 'Joint checking',
        relink: true,
        owners: [{ memberId: 'ada', displayName: 'Ada', shareBps: 10000 }],
      },
    ],
    attributedElsewhere: 3,
    goalsLeft: [],
    rulesLeft: [],
    claimsEnding: 1,
  },
  copied: {
    categories: [{ id: 'c', name: 'Groceries', groupName: 'Food' }],
    tags: [{ id: 't', name: 'Trips' }],
  },
  settleUp: [{ memberId: 'ada', displayName: 'Ada', amountMinor: -4210, currency: 'USD' }],
  household: { name: 'Our Home', baseCurrency: 'USD', timezone: 'America/Denver' },
  ...over,
});

let requests: { method: string; path: string; body: unknown }[];
let move: MemberMove | null;

beforeEach(() => {
  resetCsrf();
  requests = [];
  navigate.mockReset();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    const method = init.method ?? 'GET';
    if (path.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    if (method !== 'GET') {
      requests.push({ method, path, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ data: { householdId: NEW, moveId: 'm' } }), {
        status: 201,
      });
    }
    if (path.endsWith('/move-in')) {
      return move
        ? new Response(JSON.stringify({ data: move }))
        : new Response(JSON.stringify({ code: 'not_found', title: 'Not found' }), { status: 404 });
    }
    return new Response(JSON.stringify({ data: {} }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (node: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('MoveOutPlan', () => {
  it('shows what goes, what stays and what’s copied, then starts it', async () => {
    const user = userEvent.setup();
    wrap(<MoveOutPlan householdId={HH} p={preview()} />);
    const goes = screen.getByRole('heading', { name: 'Goes with you' }).closest('section, div')!;
    expect(goes).toHaveTextContent('Sam’s checking');
    expect(goes).toHaveTextContent('214 transactions');
    expect(screen.getByText('Re-link the bank there')).toBeInTheDocument();
    expect(screen.getByText(/Your Chase connection moves with you/)).toBeInTheDocument();
    expect(screen.getByText(/your share goes to Ada \(100%\)/)).toBeInTheDocument();
    expect(screen.getByText('They re-link the bank')).toBeInTheDocument();
    expect(screen.getByText(/3 purchases on other people’s accounts/)).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText(/You owe Ada \$42\.10/)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Sam’s place');
    await user.click(screen.getByRole('button', { name: 'Move out' }));
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent(/moves to Sam’s place, and you leave this household/);
    await user.click(within(confirm).getByRole('button', { name: 'Move out' }));
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/h/$householdId/settings/members',
        params: { householdId: NEW },
      }),
    );
    expect(requests).toEqual([
      {
        method: 'POST',
        path: `/api/v1/households/${HH}/move-out`,
        body: { name: 'Sam’s place' },
      },
    ]);
  });

  it('says why someone can’t move out yet, and offers nothing to start', () => {
    wrap(<MoveOutPlan householdId={HH} p={preview({ blockers: ['last_owner'] })} />);
    expect(screen.getByText(/You’re the only owner/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move out' })).toBeNull();
  });
});

describe('MoveInCard', () => {
  const base: MemberMove = {
    id: 'm',
    status: 'moving',
    step: 3,
    steps: 5,
    errorCode: null,
    createdAt: '2026-11-23T10:00:00Z',
    finishedAt: null,
    finalBalances: [{ memberId: 'ada', displayName: 'Ada', amountMinor: 1500, currency: 'USD' }],
  };

  it('shows how the move is going, and the settle-up it recorded', async () => {
    move = base;
    wrap(<MoveInCard householdId={NEW} />);
    expect(await screen.findByText('Moving your things in')).toBeInTheDocument();
    expect(screen.getByText(/Step 3 of 5/)).toBeInTheDocument();
    expect(screen.getByText(/Ada owed you \$15\.00/)).toBeInTheDocument();
  });

  it('says when it’s done, and nothing in a household nobody moved into', async () => {
    move = { ...base, status: 'done', step: 5, finishedAt: '2026-11-23T10:01:00Z' };
    const { unmount } = wrap(<MoveInCard householdId={NEW} />);
    expect(await screen.findByText('You’ve moved in')).toBeInTheDocument();
    unmount();
    move = null;
    const { container } = wrap(<MoveInCard householdId={HH} />);
    await vi.waitFor(() => expect(requests).toEqual([]));
    expect(container).toBeEmptyDOMElement();
  });
});
