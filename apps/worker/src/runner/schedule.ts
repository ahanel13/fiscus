// SPDX-License-Identifier: AGPL-3.0-or-later

// When a connection is next due (#81, walkthrough §5–§6): the interval after a sync, and a backoff
// after a failure. Both get up to JITTER of themselves added at random, so connections linked
// together, or failing together when a provider is down, spread out instead of arriving at once.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Up to this fraction of the delay is added at random. */
export const JITTER = 0.1;

/** After the 1st, 2nd, 3rd, … failure in a row; the last repeats. Never more than the interval. */
export const BACKOFF_MS = [1, 5, 30, 120, 360, 720].map((minutes) => minutes * MINUTE);

const jittered = (ms: number, random: () => number) => Math.round(ms * (1 + JITTER * random()));

/**
 * The least a provider allows between requests, when more than the defaults (#91, D10): the
 * SimpleFIN Bridge refreshes about daily and allows about 24 requests a day, so a connection is
 * never due sooner than 6 hours after a sync, and its retries start at 15 minutes.
 */
export interface ScheduleFloor {
  intervalMs: number;
  backoffMs: number;
}

export const SCHEDULE_FLOORS: Record<string, ScheduleFloor> = {
  simplefin: { intervalMs: 6 * HOUR, backoffMs: 15 * MINUTE },
};

const NO_FLOOR: ScheduleFloor = { intervalMs: 0, backoffMs: 0 };

/** The floor for a provider, or none. */
export const scheduleFloor = (provider: string | undefined): ScheduleFloor =>
  (provider && SCHEDULE_FLOORS[provider]) || NO_FLOOR;

/** Next due after a sync that worked. */
export function nextSyncDelayMs(
  intervalHours: number,
  random: () => number = Math.random,
  floor: ScheduleFloor = NO_FLOOR,
): number {
  return jittered(Math.max(intervalHours * HOUR, floor.intervalMs), random);
}

/** Next due after a failure, given how many came before it in a row. */
export function backoffDelayMs(
  failuresBefore: number,
  intervalHours: number,
  random: () => number = Math.random,
  floor: ScheduleFloor = NO_FLOOR,
): number {
  const step = BACKOFF_MS[Math.min(Math.max(failuresBefore, 0), BACKOFF_MS.length - 1)]!;
  const interval = Math.max(intervalHours * HOUR, floor.intervalMs);
  return jittered(Math.max(Math.min(step, interval), floor.backoffMs), random);
}
