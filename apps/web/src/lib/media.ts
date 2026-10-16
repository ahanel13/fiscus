// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSyncExternalStore } from 'react';

/** Whether a media query matches, following changes (a window resized past a breakpoint). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Tailwind's `xl`: wide enough for the transactions table beside the sidebar. */
export const WIDE = '(min-width: 80rem)';

/** Tailwind's `sm`: past a phone held upright. */
export const SMALL = '(min-width: 40rem)';
