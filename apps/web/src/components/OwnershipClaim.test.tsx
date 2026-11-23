// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OwnershipClaimState } from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { OwnershipClaimCard } from './OwnershipClaim.js';

// An ownership claim on Household settings → Members (#267, D35). Who may take each step is
// tested in the api (ownership-claims.test.ts, HH-17).

const HH = '00000000-0000-7000-8000-0000000000aa';
const CLAIM = {
  id: '00000000-0000-7000-8000-0000000000c1',
  claimantMemberId: 'sam',
  status: 'open' as const,
  createdAt: '2026-11-01T12:00:00Z',
  endsAt: '2026-12-01T12:00:00Z',
};

let you: { memberId: string; role: string };
let state: OwnershipClaimState;
let requests: { method: string; path: string }[];

beforeEach(() => {
  resetCsrf();
  requests = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    const method = init.method ?? 'GET';
    if (path.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    if (method !== 'GET') {
      requests.push({ method, path });
      if (path.endsWith('/ownership-claims')) {
        state = { claim: { ...CLAIM, claimantMemberId: you.memberId }, canClaim: false };
        return new Response(JSON.stringify({ data: state.claim }), { status: 201 });
      }
      state = { claim: null, canClaim: false };
      return new Response(null, { status: 204 });
    }
    if (path.endsWith(`/households/${HH}`)) {
      return new Response(JSON.stringify({ data: { you, timezone: 'UTC' } }));
    }
    if (path.endsWith('/members')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'ada', displayName: 'Ada', role: 'owner' },
            { id: 'sam', displayName: 'Sam', role: 'member' },
          ],
        }),
      );
    }
    return new Response(JSON.stringify({ data: state }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OwnershipClaimCard householdId={HH} />
    </QueryClientProvider>,
  );

describe('OwnershipClaimCard', () => {
  it('offers a member the claim once the owners are away, and says what happens', async () => {
    you = { memberId: 'sam', role: 'member' };
    state = { claim: null, canClaim: true };
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Claim ownership' }));
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent(
      /Every owner is told now, a week before the 30 days are up, and the day before/,
    );
    await user.click(within(confirm).getByRole('button', { name: 'Claim ownership' }));
    expect(requests).toEqual([
      { method: 'POST', path: `/api/v1/households/${HH}/ownership-claims` },
    ]);
    expect(await screen.findByRole('heading', { name: 'You’ve claimed ownership' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Withdraw claim' })).toBeVisible();
  });

  it('lets an owner reject it in one click', async () => {
    you = { memberId: 'ada', role: 'owner' };
    state = { claim: CLAIM, canClaim: false };
    const user = userEvent.setup();
    show();
    expect(await screen.findByRole('heading', { name: 'Sam has claimed ownership' })).toBeVisible();
    expect(screen.getByText(/becomes an owner alongside you/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reject claim' }));
    expect(requests).toEqual([
      { method: 'POST', path: `/api/v1/households/${HH}/ownership-claims/${CLAIM.id}/reject` },
    ]);
  });

  it('shows everyone else the claim, with nothing to press', async () => {
    you = { memberId: 'vic', role: 'viewer' };
    state = { claim: CLAIM, canClaim: false };
    show();
    expect(await screen.findByRole('heading', { name: 'Sam has claimed ownership' })).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows nothing when there’s no claim and you can’t make one', async () => {
    you = { memberId: 'sam', role: 'member' };
    state = { claim: null, canClaim: false };
    const { container } = show();
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
