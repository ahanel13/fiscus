// SPDX-License-Identifier: AGPL-3.0-or-later
import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import {
  Text,
  UNSTABLE_Toast as AriaToast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as ToastRegion,
} from 'react-aria-components';
import { Button } from './button.js';

// React Aria's toast API is marked UNSTABLE_ (its props may change in a minor release). Everything
// else uses `toast()` and `<Toaster>` from here, so an upgrade touches only this file.

export type ToastTone = 'success' | 'info' | 'error';

export interface ToastContentData {
  title: string;
  description?: string;
  tone: ToastTone;
}

export const toastQueue = new ToastQueue<ToastContentData>({ maxVisibleToasts: 3 });

/**
 * Brief confirmation of something that just happened ("Split saved."). Errors stay until
 * dismissed; everything else disappears after 5 seconds. Don't toast what the screen already shows.
 */
export function toast(
  title: string,
  { description, tone = 'success' }: { description?: string; tone?: ToastTone } = {},
) {
  return toastQueue.add(
    { title, tone, ...(description ? { description } : {}) },
    tone === 'error' ? {} : { timeout: 5000 },
  );
}

const ICONS = { success: CircleCheck, info: Info, error: CircleAlert };

/** Rendered once at the root of the app. */
export function Toaster() {
  return (
    <ToastRegion
      queue={toastQueue}
      className="fixed bottom-20 left-1/2 z-[60] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 outline-none md:bottom-6 md:left-auto md:right-6 md:translate-x-0"
    >
      {({ toast: t }) => {
        const Icon = ICONS[t.content.tone];
        return (
          <AriaToast
            toast={t}
            className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3 text-fg shadow-lg outline-none focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Icon
              aria-hidden
              className={clsx(
                'mt-0.5 size-5 shrink-0',
                t.content.tone === 'success' && 'text-positive',
                t.content.tone === 'error' && 'text-danger',
                t.content.tone === 'info' && 'text-muted',
              )}
            />
            <ToastContent className="flex-1">
              <Text slot="title" className="block text-sm font-medium">
                {t.content.title}
              </Text>
              {t.content.description ? (
                <Text slot="description" className="block text-sm text-muted">
                  {t.content.description}
                </Text>
              ) : null}
            </ToastContent>
            <Button
              slot="close"
              variant="ghost"
              size="sm"
              aria-label="Dismiss"
              className="-my-1 -mr-1 px-1.5"
            >
              <X aria-hidden className="size-4" />
            </Button>
          </AriaToast>
        );
      }}
    </ToastRegion>
  );
}
