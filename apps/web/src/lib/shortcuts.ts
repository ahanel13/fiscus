// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from 'react';

export interface ShortcutHandlers {
  palette: () => void;
  help: () => void;
  /** Called with the second key of a `g <key>` sequence. */
  jump: (key: string) => void;
}

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

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
