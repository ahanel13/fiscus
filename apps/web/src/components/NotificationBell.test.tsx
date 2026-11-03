// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NotificationList } from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { NotificationBell, unreadLabel } from './NotificationBell.js';

// The bell (#130). That it lists only your own is tested in the api (notifications.test.ts).

const HH = '00000000-0000-7000-8000-0000000000aa';
const NOW = new Date().toISOString();

let list: NotificationList;
let posts: string[];

beforeEach(() => {
  resetCsrf();
  posts = [];
  list = {
    unread: 1,
    notifications: [
      {
        id: 'n1',
        kind: 'connection_needs_you',
        title: 'Sign in to Harbor Credit Union again',
        body: 'Fiscus can’t sync Harbor Credit Union until you sign in to it again.',
        link: `/h/${HH}/accounts`,
        createdAt: NOW,
        readAt: null,
      },
      {
        id: 'n2',
        kind: 'connection_needs_you',
        title: 'Older news',
        body: 'Already seen.',
        link: null,
        createdAt: NOW,
        readAt: NOW,
      },
    ],
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    if (path.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    if ((init.method ?? 'GET') === 'POST') {
      posts.push(path);
      list = {
        unread: 0,
        notifications: list.notifications.map((n) => ({ ...n, readAt: n.readAt ?? NOW })),
      };
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ data: list }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (onNavigate = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationBell householdId={HH} onNavigate={onNavigate} />
    </QueryClientProvider>,
  );
  return onNavigate;
};

describe('the bell', () => {
  it('counts what’s unread', async () => {
    show();
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy();
    expect(unreadLabel(5)).toBe('5');
    expect(unreadLabel(150)).toBe('99+');
  });

  it('lists recent notifications, and opening one marks it read and goes to it', async () => {
    const onNavigate = show();
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    const items = within(within(dialog).getByRole('list', { name: 'Notifications' })).getAllByRole(
      'listitem',
    );
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Sign in to Harbor Credit Union again (unread)'),
      expect.stringContaining('Older news'),
    ]);
    await userEvent.click(within(items[0]!).getByRole('button'));
    await waitFor(() => expect(posts).toEqual([`/api/v1/households/${HH}/notifications/n1/read`]));
    expect(onNavigate).toHaveBeenCalledWith(`/h/${HH}/accounts`);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy());
  });

  it('marks all read', async () => {
    show();
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(posts).toEqual([`/api/v1/households/${HH}/notifications/read-all`]));
    expect(await screen.findByText('All caught up.')).toBeTruthy();
  });

  it('says when there’s nothing yet, and links to the settings', async () => {
    list = { unread: 0, notifications: [] };
    const onNavigate = show();
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(
      await screen.findByText('Nothing yet. Fiscus tells you here when something needs you.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Notification settings' }));
    expect(onNavigate).toHaveBeenCalledWith(`/h/${HH}/settings/notifications`);
  });
});
