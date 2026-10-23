// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { backoffDelayMs, nextSyncDelayMs, scheduleFloor } from './schedule.js';
import { windowStart } from '../sync/sync.js';

const minutes = (ms: number) => ms / 60_000;
const none = () => 0;
const most = () => 1;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

  it('keeps the SimpleFIN Bridge to one sync in 6 hours, and retries from 15 minutes (#91)', () => {
    const bridge = scheduleFloor('simplefin');
    expect(nextSyncDelayMs(4, none, bridge)).toBe(6 * HOUR);
    expect(nextSyncDelayMs(8, none, bridge)).toBe(8 * HOUR);
    expect(backoffDelayMs(0, 4, none, bridge)).toBe(15 * MINUTE);
    expect(backoffDelayMs(2, 4, none, bridge)).toBe(30 * MINUTE);
    // Later failures may wait up to the 6 hours, not the 4-hour interval.
    expect(backoffDelayMs(4, 4, none, bridge)).toBe(6 * HOUR);
    // Plaid has no floor.
    expect(nextSyncDelayMs(4, none, scheduleFloor('plaid'))).toBe(4 * HOUR);
    expect(backoffDelayMs(0, 4, none, scheduleFloor('plaid'))).toBe(1 * MINUTE);
  });
});

describe('windowStart (#91)', () => {
  it('asks from a fortnight before the latest transaction, never before sync_from', () => {
    expect(windowStart({ since: '2026-07-22', lastProviderDate: null })).toBe('2026-07-22');
    expect(windowStart({ since: '2026-07-22', lastProviderDate: '2026-10-20' })).toBe('2026-10-06');
    expect(windowStart({ since: '2026-10-15', lastProviderDate: '2026-10-20' })).toBe('2026-10-15');
    expect(windowStart({ since: null, lastProviderDate: '2026-03-10' })).toBe('2026-02-24');
  });
});
