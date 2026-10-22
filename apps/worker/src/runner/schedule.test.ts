// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { backoffDelayMs, nextSyncDelayMs } from './schedule.js';

const minutes = (ms: number) => ms / 60_000;
const none = () => 0;
const most = () => 1;

describe('when a connection is next due', () => {
  it('waits the interval after a sync, plus up to a tenth of it', () => {
    expect(minutes(nextSyncDelayMs(4, none))).toBe(240);
    expect(minutes(nextSyncDelayMs(4, most))).toBe(264);
    expect(minutes(nextSyncDelayMs(12, none))).toBe(720);
  });

  it('backs off 1 min, 5 min, 30 min, … after failures, never past the interval', () => {
    const ladder = (hours: number) =>
      Array.from({ length: 8 }, (_, n) => minutes(backoffDelayMs(n, hours, none)));
    expect(ladder(4)).toEqual([1, 5, 30, 120, 240, 240, 240, 240]);
    expect(ladder(24)).toEqual([1, 5, 30, 120, 360, 720, 720, 720]);
    expect(ladder(1)).toEqual([1, 5, 30, 60, 60, 60, 60, 60]);
  });

  it('spreads retries out too', () => {
    expect(minutes(backoffDelayMs(1, 4, most))).toBe(5.5);
    expect(minutes(backoffDelayMs(9, 4, most))).toBe(264);
  });
});
