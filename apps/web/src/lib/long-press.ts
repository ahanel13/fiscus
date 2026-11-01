// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MouseEvent, type PointerEvent, useRef } from 'react';

/** How long a finger stays down before it's a long press, as on Android and iOS. */
export const LONG_PRESS_MS = 500;

/** How far a finger can drift (scrolling) before it's not a press at all. */
const SLOP_PX = 10;

/**
 * A long press on a row: holding a finger (or the mouse) still for half a second. Spread `handlers`
 * on the element, and check `fired()` in its click handler, so the press doesn't also open it.
 */
export function useLongPress(onLongPress: (id: string) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const done = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    handlers: (id: string) => ({
      onPointerDown: (e: PointerEvent) => {
        if (e.button !== 0) return;
        done.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        cancel();
        timer.current = setTimeout(() => {
          timer.current = null;
          done.current = true;
          navigator.vibrate?.(10);
          onLongPress(id);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e: PointerEvent) => {
        if (
          Math.abs(e.clientX - start.current.x) > SLOP_PX ||
          Math.abs(e.clientY - start.current.y) > SLOP_PX
        )
          cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      // The browser's own long-press menu (copy, share…) would cover the list.
      onContextMenu: (e: MouseEvent) => {
        if (done.current || timer.current) e.preventDefault();
      },
    }),
    /** Whether the press that just ended was a long one; reading it clears it. */
    fired() {
      const was = done.current;
      done.current = false;
      return was;
    },
  };
}
