// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef } from 'react';

/**
 * The rows a click covers: from the anchor (the last row clicked) to this one, inclusive, in the
 * order shown. Just this one without an anchor, or when either isn't shown any more.
 */
export function rangeOf(order: readonly string[], anchor: string | null, id: string): string[] {
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  if (from < 0 || to < 0) return [id];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * Checkbox lists: shift-click ticks (or unticks) every row from the last one clicked, as in a mail
 * client. Spread `capture` on an element around each row's checkbox, and call `toggle` from its
 * onChange with the rows in the order shown.
 */
export function useRangeSelect() {
  const anchor = useRef<string | null>(null);
  const shift = useRef(false);
  const note = (e: { shiftKey: boolean }) => {
    shift.current = e.shiftKey;
  };
  return {
    capture: { onPointerDownCapture: note, onKeyDownCapture: note },
    toggle(order: readonly string[], selected: ReadonlySet<string>, id: string, on: boolean) {
      const next = new Set(selected);
      for (const x of rangeOf(order, shift.current ? anchor.current : null, id)) {
        if (on) next.add(x);
        else next.delete(x);
      }
      anchor.current = id;
      shift.current = false;
      return next;
    },
  };
}
