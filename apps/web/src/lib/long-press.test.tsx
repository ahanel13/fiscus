// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS, useLongPress } from './long-press.js';

function Row({ onLong, onOpen }: { onLong: (id: string) => void; onOpen: () => void }) {
  const press = useLongPress(onLong);
  return (
    <button type="button" {...press.handlers('a')} onClick={() => !press.fired() && onOpen()}>
      Row
    </button>
  );
}

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const onLong = vi.fn();
    const onOpen = vi.fn();
    render(<Row onLong={onLong} onOpen={onOpen} />);
    return { onLong, onOpen, row: screen.getByRole('button', { name: 'Row' }) };
  };

  it('fires after a held press, and the click that ends it does not open the row', () => {
    const { onLong, onOpen, row } = setup();
    fireEvent.pointerDown(row, { button: 0, clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerUp(row);
    fireEvent.click(row);
    expect(onLong).toHaveBeenCalledWith('a');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('is a plain tap when let go sooner', () => {
    const { onLong, onOpen, row } = setup();
    fireEvent.pointerDown(row, { button: 0, clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    fireEvent.pointerUp(row);
    fireEvent.click(row);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLong).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('is not a press when the finger moves (scrolling)', () => {
    const { onLong, row } = setup();
    fireEvent.pointerDown(row, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(row, { clientX: 5, clientY: 40 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLong).not.toHaveBeenCalled();
  });
});
