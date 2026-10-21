// SPDX-License-Identifier: AGPL-3.0-or-later
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, resetCsrf } from '../api/client.js';
import { ReauthCancelled, useRecentAuth } from './RecentAuth.js';

type Reply = { status: number; body?: unknown };
let replies: Reply[];
let calls: string[];

beforeEach(() => {
  resetCsrf();
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? 'GET'} ${new URL(url, 'http://x').pathname}`);
    if (url.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

const reauthRequired = {
  status: 403,
  body: { code: 'reauth_required', title: 'Confirm your password to continue' },
};

function Change() {
  const { withRecentAuth, dialog } = useRecentAuth();
  const [result, setResult] = useState('');
  return (
    <>
      <button
        onClick={() =>
          withRecentAuth(() => api<{ data: string }>('PATCH', '/api/v1/admin/settings', {}))
            .then((r) => setResult(r.data))
            .catch((e) => setResult(e instanceof ReauthCancelled ? 'cancelled' : 'failed'))
        }
      >
        Change
      </button>
      <output>{result}</output>
      {dialog}
    </>
  );
}

const renderChange = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Change />
    </QueryClientProvider>,
  );

describe('useRecentAuth', () => {
  it('asks for the password when the server wants it, then makes the change', async () => {
    replies = [
      reauthRequired,
      { status: 401, body: { code: 'invalid_credentials', title: 'Password is incorrect' } },
      { status: 204 },
      { status: 200, body: { data: 'saved' } },
    ];
    renderChange();
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    expect(dialog).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/Password/), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('That password isn’t right')).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText(/Password/));
    await userEvent.type(screen.getByLabelText(/Password/), 'right');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('saved')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((c) => !c.endsWith('/csrf'))).toEqual([
      'PATCH /api/v1/admin/settings',
      'POST /api/v1/auth/reauth',
      'POST /api/v1/auth/reauth',
      'PATCH /api/v1/admin/settings',
    ]);
  });

  it('changes nothing when cancelled', async () => {
    replies = [reauthRequired];
    renderChange();
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('cancelled')).toBeInTheDocument();
    expect(calls.filter((c) => !c.endsWith('/csrf'))).toEqual(['PATCH /api/v1/admin/settings']);
  });
});
