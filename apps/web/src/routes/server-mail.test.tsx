// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MailStatus } from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { Toaster } from '../components/ui.js';
import { MailSection } from './server-mail.js';

// Server → Email (D16): the mail server, set here or by the environment. That it's admins only,
// and the password never comes back, is tested in the api (notifications.test.ts).

const NONE: MailStatus = {
  configured: false,
  source: null,
  host: null,
  port: null,
  security: null,
  username: null,
  hasPassword: false,
  passwordUnreadable: false,
  from: null,
};
const SAVED: MailStatus = {
  configured: true,
  source: 'settings',
  host: 'smtp.example.test',
  port: 587,
  security: 'starttls',
  username: 'fiscus',
  hasPassword: true,
  passwordUnreadable: false,
  from: 'Fiscus <fiscus@example.test>',
};

let state: MailStatus;
let requests: { method: string; path: string; body: any }[];

beforeEach(() => {
  resetCsrf();
  requests = [];
  state = NONE;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    if (path.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') requests.push({ method, path, body });
    if (method === 'PUT') {
      state = {
        ...SAVED,
        host: body.host,
        port: body.port,
        security: body.security,
        username: body.username || null,
        from: body.from,
        hasPassword: body.password === undefined ? state.hasPassword : !!body.password,
      };
    }
    if (method === 'DELETE') state = NONE;
    if (path.endsWith('/test')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ data: state }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MailSection email="ada@example.test" />
      <Toaster />
    </QueryClientProvider>,
  );

describe('Server → Email', () => {
  it('sets up the mail server', async () => {
    show();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up email' }));
    await userEvent.type(screen.getByLabelText(/Mail server/), 'smtp.example.test');
    await userEvent.type(screen.getByLabelText(/Username/), 'fiscus');
    await userEvent.type(screen.getByLabelText(/^Password/), 'hunter2');
    await userEvent.type(screen.getByLabelText(/^From/), 'Fiscus <fiscus@example.test>');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(requests[0]).toEqual({
        method: 'PUT',
        path: '/api/v1/admin/mail',
        body: {
          host: 'smtp.example.test',
          port: 587,
          security: 'starttls',
          username: 'fiscus',
          password: 'hunter2',
          from: 'Fiscus <fiscus@example.test>',
        },
      }),
    );
    expect(await screen.findByText('smtp.example.test:587 · STARTTLS')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send a test email' })).toBeTruthy();
  });

  it('keeps the saved password when it’s left blank, and removes the settings', async () => {
    state = SAVED;
    show();
    await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
    expect(screen.getByText('Leave blank to keep the saved one.')).toBeTruthy();
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requests[0]?.method).toBe('PUT'));
    expect(requests[0]!.body).not.toHaveProperty('password');
    await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(requests.at(-1)?.method).toBe('DELETE'));
    expect(await screen.findByRole('button', { name: 'Set up email' })).toBeTruthy();
  });

  it('shows the environment’s settings read-only, never a password', async () => {
    state = { ...SAVED, source: 'environment', username: null, hasPassword: true };
    show();
    expect(await screen.findByText('Set by your server’s environment')).toBeTruthy();
    expect(screen.getByText('smtp.example.test:587 · STARTTLS')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.queryByLabelText(/^Password/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send a test email' })).toBeTruthy();
  });
});
