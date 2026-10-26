// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HouseholdPlaidKeys } from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { PlaidKeysCard } from './PlaidKeysCard.js';

// A household's own Plaid keys in Household settings → Connections (#83). The api side, and who
// may use it, is tested in the api (plaid-keys.test.ts, HH-08).

const HH = '00000000-0000-7000-8000-0000000000aa';
const chase: HouseholdPlaidKeys['connections'][number] = {
  id: '00000000-0000-7000-8000-000000000001',
  institutionName: 'Chase',
  owner: { memberId: 'm1', name: 'Sam' },
  accountCount: 3,
  keys: 'server',
};
const SAVED = {
  clientIdEnding: '7731',
  env: 'production' as const,
  addedAt: '2026-10-20T15:00:00Z',
};

let state: HouseholdPlaidKeys;
let requests: { method: string; body: unknown }[];
/** What the next write answers, when not a success. */
let refuse: { status: number; body: Record<string, string> } | null;

beforeEach(() => {
  resetCsrf();
  requests = [];
  refuse = null;
  state = { allowed: true, serverKeys: true, keys: null, connections: [chase] };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    if (path.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      requests.push({ method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (refuse) {
        return new Response(JSON.stringify(refuse.body), {
          status: refuse.status,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      if (method === 'PUT') state = { ...state, keys: SAVED };
      if (method === 'DELETE') {
        state = { ...state, keys: null };
        return new Response(null, { status: 204 });
      }
    }
    return new Response(JSON.stringify({ data: state }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PlaidKeysCard householdId={HH} />
    </QueryClientProvider>,
  );

describe('PlaidKeysCard', () => {
  it('adds keys, saying first which banks keep theirs, and forgets the secret', async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Add your keys' }));
    const dialog = screen.getByRole('dialog', { name: 'Add your Plaid keys' });
    // The switch preview (D15): the bank connected before stays on the server's keys.
    const staying = within(dialog).getByRole('list', { name: 'Banks that keep their keys' });
    expect(staying.textContent).toContain('Chase · Sam · 3 accounts');
    expect(staying.textContent).toContain('The server’s keys');

    const secret = within(dialog).getByLabelText(/Secret/);
    expect(secret.getAttribute('type')).toBe('password');
    await user.type(within(dialog).getByLabelText(/Client ID/), ' household-client-7731 ');
    await user.type(secret, 'their-secret');
    await user.click(within(dialog).getByRole('button', { name: 'Save keys' }));

    expect(requests).toEqual([
      {
        method: 'PUT',
        body: { clientId: 'household-client-7731', secret: 'their-secret', env: 'production' },
      },
    ]);
    expect(await screen.findByText('ending 7731')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Opened again, the form is empty: the secret isn't kept anywhere on the page.
    await user.click(screen.getByRole('button', { name: 'Replace keys' }));
    expect((screen.getByLabelText(/Secret/) as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('their-secret');
  });

  it('shows why Plaid refused the keys, and keeps the dialog open', async () => {
    const user = userEvent.setup();
    refuse = {
      status: 422,
      body: {
        code: 'plaid_keys_rejected',
        title: 'Plaid didn’t accept these keys',
        detail: 'Check the client id.',
      },
    };
    show();
    await user.click(await screen.findByRole('button', { name: 'Add your keys' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Client ID/), 'nope');
    await user.type(within(dialog).getByLabelText(/Secret/), 'nope');
    await user.click(within(dialog).getByRole('button', { name: 'Save keys' }));
    expect(
      (await within(dialog).findByText(/Plaid didn’t accept these keys/)).textContent,
    ).toContain('Check the client id.');
  });

  it('lists the banks not on your keys yet, and removes keys once asked', async () => {
    const user = userEvent.setup();
    state = { ...state, keys: SAVED };
    show();
    const list = await screen.findByRole('list', { name: 'Banks not on your keys' });
    expect(list.textContent).toContain('Chase');
    expect(screen.getByText('This bank isn’t on your keys yet.', { exact: false })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove keys' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove keys' }),
    );
    expect(requests).toEqual([{ method: 'DELETE', body: undefined }]);
    expect(await screen.findByRole('button', { name: 'Add your keys' })).toBeTruthy();
  });

  it('says when the admin has turned household keys off, and offers only removing', async () => {
    state = { ...state, allowed: false, keys: SAVED };
    show();
    expect(
      (await screen.findByText(/turned off households’ own Plaid keys/)).textContent,
    ).toContain('Banks connected with them keep syncing, and you can still remove them.');
    expect(screen.queryByRole('button', { name: 'Replace keys' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove keys' })).toBeTruthy();
  });
});
