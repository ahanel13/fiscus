// SPDX-License-Identifier: AGPL-3.0-or-later

// A message for the next page across a full page load, shown once. The connect page leaves with
// a full page load (so Plaid's script doesn't stay loaded), and says how it went on the page it
// lands on. Session storage, for this tab only; without it, the message is simply not shown.

const KEY = 'fiscus.flash';

export interface Flash {
  title: string;
  description?: string;
  tone: 'success' | 'info' | 'error';
}

export function setFlash(flash: Flash): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(flash));
  } catch {
    // Storage blocked: the next page just won't say it.
  }
}

/** The waiting message, if any, removed so it shows once. */
export function takeFlash(): Flash | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const flash = raw ? (JSON.parse(raw) as Partial<Flash>) : null;
    return typeof flash?.title === 'string'
      ? {
          title: flash.title,
          tone: flash.tone === 'error' || flash.tone === 'info' ? flash.tone : 'success',
          ...(typeof flash.description === 'string' ? { description: flash.description } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

/** Leaves this page with a full page load (never the router), with a message for the next. */
export function leaveTo(url: string, flash?: Flash): void {
  if (flash) setFlash(flash);
  window.location.assign(url);
}
