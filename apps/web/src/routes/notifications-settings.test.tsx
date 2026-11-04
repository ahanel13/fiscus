// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  NOTIFICATION_KINDS,
  type NotificationSettingsView,
  ruleChannels,
  ruleSettings,
} from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { Toaster } from '../components/ui.js';
import { EMAIL_UNAVAILABLE, NotificationsSettings } from './notifications-settings.js';

// Settings → Notifications (bills walkthrough §7, prototypes 06 and 14). The api side, and that
// it's yours only, is tested in the api (notifications.test.ts).

const HH = '00000000-0000-7000-8000-0000000000aa';

const view = (fields: Partial<NotificationSettingsView> = {}): NotificationSettingsView => ({
  emailAvailable: true,
  channels: [
    {
      kind: 'email',
      configured: true,
      detail: 'full',
      server: null,
      hint: 'alex@rivera.test',
      signed: false,
    },
    {
      kind: 'ntfy',
      configured: true,
      detail: 'summary',
      server: 'https://ntfy.sh',
      hint: 'topic rivera-alex-…',
      signed: false,
    },
    { kind: 'gotify', configured: false, detail: 'full', server: null, hint: null, signed: false },
    { kind: 'webhook', configured: false, detail: 'full', server: null, hint: null, signed: false },
  ],
  rules: NOTIFICATION_KINDS.map((kind) => ({
    kind,
    channels: ruleChannels(kind, null, ['email', 'ntfy']),
    settings: ruleSettings(kind, undefined),
    isDefault: true,
  })),
  ...fields,
});

let state: NotificationSettingsView;
let requests: { method: string; path: string; body: unknown }[];
let testStatus: { status: string; code: string | null };

function stubMedia(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  resetCsrf();
  requests = [];
  state = view();
  testStatus = { status: 'sent', code: null };
  stubMedia(true);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    const method = init.method ?? 'GET';
    if (path.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    if (path.endsWith(`/households/${HH}`)) {
      return new Response(JSON.stringify({ data: { baseCurrency: 'USD' } }));
    }
    if (path.includes('/accounts')) {
      return new Response(JSON.stringify({ data: [{ id: 'a1', name: 'Everyday checking' }] }));
    }
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') requests.push({ method, path, body });
    if (path.endsWith('/test')) {
      return new Response(JSON.stringify({ data: { id: 't1' } }), { status: 202 });
    }
    if (path.includes('/tests/')) return new Response(JSON.stringify({ data: testStatus }));
    if (method === 'PUT' && path.includes('/rules/')) {
      const kind = path.split('/').at(-1);
      state = {
        ...state,
        rules: state.rules.map((r) =>
          r.kind === kind
            ? {
                ...r,
                channels: body.channels,
                settings: { ...r.settings, ...(body.settings ?? {}) },
                isDefault: false,
              }
            : r,
        ),
      };
    }
    return new Response(JSON.stringify({ data: state }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationsSettings householdId={HH} />
      <Toaster />
    </QueryClientProvider>,
  );

describe('Settings → Notifications', () => {
  it('shows where they go: In Fiscus always on, email, and what’s set up', async () => {
    show();
    expect(await screen.findByText('Where to send them')).toBeTruthy();
    expect(screen.getByText('Always on')).toBeTruthy();
    expect(screen.getByText('alex@rivera.test · from the server’s mail settings')).toBeTruthy();
    expect(screen.getByText('https://ntfy.sh · topic rivera-alex-…')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Set up' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Send a test to Email' })).toBeTruthy();
  });

  it('says when the server can’t send email', async () => {
    state = view({
      emailAvailable: false,
      channels: view().channels.map((c) => (c.kind === 'email' ? { ...c, configured: false } : c)),
    });
    show();
    expect(await screen.findByText(EMAIL_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send a test to Email' })).toBeNull();
    // Email can't be ticked for any rule.
    expect(screen.getByRole('checkbox', { name: 'A bill is due: Email' })).toBeDisabled();
  });

  it('lists every rule with its timing and a tick per channel (D18)', async () => {
    show();
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Notification', 'In Fiscus', 'Email', 'Phone']);
    expect(within(table).getByText('3 days before · bills you look after')).toBeTruthy();
    expect(within(table).getByText('Over $500 · accounts you see')).toBeTruthy();
    expect(within(table).getByText('Off until you pick an account')).toBeTruthy();
    expect(within(table).getByText('Mondays at 8 am')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'A bill is due: Phone' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Weekly recap: Phone' })).not.toBeChecked();
  });

  it('saves a tick as soon as it changes', async () => {
    show();
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'A big transaction: Email' }),
    );
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: 'PUT',
        path: `/api/v1/households/${HH}/notifications/rules/big_transaction`,
        body: { channels: ['in_app', 'ntfy', 'email'] },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'A big transaction: Email' })).toBeChecked(),
    );
  });

  it('changes when a rule is sent in its dialog', async () => {
    show();
    await userEvent.click(await screen.findByRole('button', { name: /^Weekly recap/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Weekly recap' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Day/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Friday' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(requests.at(-1)).toMatchObject({
        path: `/api/v1/households/${HH}/notifications/rules/weekly_recap`,
        body: { settings: { day: 'friday', hour: 8 } },
      }),
    );
    expect(await screen.findByText('Fridays at 8 am')).toBeTruthy();
  });

  it('sends a test and says how it went', async () => {
    testStatus = { status: 'failed', code: 'http_401' };
    show();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Send a test to Phone, through ntfy' }),
    );
    await waitFor(
      () =>
        expect(
          screen.getByText(/The test didn’t go through. The server refused it \(401\)/),
        ).toBeTruthy(),
      { timeout: 3000 },
    );
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/households/${HH}/notifications/channels/ntfy/test`,
    });
  });

  it('on a phone, lists channels and rules as rows that open their settings (prototype 14)', async () => {
    stubMedia(false);
    show();
    expect(await screen.findByText('alex@rivera.test · full detail')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    const row = screen.getByRole('button', { name: /^A bill is due/ });
    expect(within(row).getByText('3 days before')).toBeTruthy();
    expect(within(row).getAllByText(/: on$/)).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: /^Gotify/ }));
    expect(await screen.findByRole('dialog', { name: 'Gotify' })).toBeTruthy();
    expect(screen.getByLabelText(/Application token/)).toBeTruthy();
  });
});
