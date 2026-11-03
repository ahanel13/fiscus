// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Notification, NotificationList } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { api, type ApiError } from '../api/client.js';
import { notificationsQuery } from '../api/queries.js';
import { relativeTime } from '../lib/relative-time.js';
import { Button, Dialog, toast } from './ui.js';

// The bell (#130, bills walkthrough D16): In Fiscus, always on. Your recent notifications, the
// unread ones counted on it; opening one marks it read and goes to what it's about.

/** "3", or "99+": on the bell. */
export const unreadLabel = (n: number) => (n > 99 ? '99+' : String(n));

/** The list in the bell's panel. */
export function NotificationItems({
  notifications,
  onOpen,
  now: fixedNow,
}: {
  notifications: Notification[];
  onOpen: (n: Notification) => void;
  now?: number;
}) {
  // The list's clock, set when it opens, so "5 minutes ago" is read once; tests pass their own.
  const [clock] = useState(() => Date.now());
  const now = fixedNow ?? clock;
  if (notifications.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted">
        Nothing yet. Fiscus tells you here when something needs you.
      </p>
    );
  }
  return (
    <ul aria-label="Notifications" className="-mx-2 divide-y divide-border">
      {notifications.map((n) => (
        <li key={n.id}>
          <AriaButton
            onPress={() => onOpen(n)}
            className="flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span
              aria-hidden
              className={clsx(
                'mt-1.5 size-2 shrink-0 rounded-full',
                n.readAt ? 'bg-transparent' : 'bg-accent',
              )}
            />
            <span className="min-w-0 flex-1">
              <span className={clsx('block text-sm', !n.readAt && 'font-semibold')}>
                {n.title}
                {n.readAt ? null : <span className="sr-only"> (unread)</span>}
              </span>
              <span className="block text-sm text-muted">{n.body}</span>
              <span className="mt-0.5 block text-xs text-muted">
                {relativeTime(n.createdAt, now)}
              </span>
            </span>
          </AriaButton>
        </li>
      ))}
    </ul>
  );
}

/** The bell, with the unread count, and its panel. */
export function NotificationBell({
  householdId,
  onNavigate,
  className,
  iconClassName = 'size-5',
}: {
  householdId: string;
  /** Goes to an app path. */
  onNavigate: (to: string) => void;
  className?: string;
  iconClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const query = notificationsQuery(householdId);
  const data = useQuery(query).data;
  const unread = data?.unread ?? 0;
  const refresh = () => queryClient.invalidateQueries({ queryKey: query.queryKey });
  const markRead = useMutation({
    mutationFn: (id: string) =>
      api('POST', `/api/v1/households/${householdId}/notifications/${id}/read`),
    onMutate: (id) =>
      queryClient.setQueryData<NotificationList>(query.queryKey, (old) =>
        old
          ? {
              unread: Math.max(0, old.unread - 1),
              notifications: old.notifications.map((n) =>
                n.id === id ? { ...n, readAt: new Date().toISOString() } : n,
              ),
            }
          : old,
      ),
    onSettled: refresh,
  });
  const readAll = useMutation({
    mutationFn: () => api('POST', `/api/v1/households/${householdId}/notifications/read-all`),
    onSuccess: refresh,
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        onPress={() => setOpen(true)}
        className={clsx('relative', className)}
      >
        <Bell aria-hidden className={iconClassName} />
        {unread ? (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-[10px] leading-4 font-semibold text-accent-fg"
          >
            {unreadLabel(unread)}
          </span>
        ) : null}
      </Button>
      <Dialog title="Notifications" variant="drawer" isOpen={open} onOpenChange={setOpen}>
        {(close) => (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-sm text-muted">
                {unread ? `${unread} unread` : 'All caught up.'}
              </p>
              {unread ? (
                <Button
                  variant="ghost"
                  size="sm"
                  isPending={readAll.isPending}
                  onPress={() => readAll.mutate()}
                >
                  Mark all read
                </Button>
              ) : null}
            </div>
            <NotificationItems
              notifications={data?.notifications ?? []}
              onOpen={(n) => {
                if (!n.readAt) markRead.mutate(n.id);
                if (n.link) {
                  close();
                  onNavigate(n.link);
                }
              }}
            />
            <div className="border-t border-border pt-3">
              <Button
                variant="secondary"
                size="sm"
                onPress={() => {
                  close();
                  onNavigate(`/h/${householdId}/settings/notifications`);
                }}
              >
                Notification settings
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
