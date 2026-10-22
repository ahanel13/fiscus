// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from 'react';

export interface ShortcutHandlers {
  palette: () => void;
  help: () => void;
  /** Called with the second key of a `g <key>` sequence. */
  jump: (key: string) => void;
}

const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color']);

/** Whether a key press goes into a field being typed in, so shortcuts leave it alone. */
export const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable ||
    ['TEXTAREA', 'SELECT'].includes(el.tagName) ||
    // A checkbox, radio or button isn't typed into: shortcuts still work from one.
    (el instanceof HTMLInputElement && !NOT_TYPED.has(el.type)));

/** Global keyboard shortcuts (IA §8). Ignored while typing in a field. */
export function useShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.palette();
        return;
      }
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') {
        handlers.help();
      } else if (e.key === 'g') {
        pendingG = Date.now();
      } else if (pendingG && Date.now() - pendingG < 1200) {
        pendingG = 0;
        handlers.jump(e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}
