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

/** Next due after a sync that worked. */
export function nextSyncDelayMs(intervalHours: number, random: () => number = Math.random): number {
  return jittered(intervalHours * HOUR, random);
}

/** Next due after a failure, given how many came before it in a row. */
export function backoffDelayMs(
  failuresBefore: number,
  intervalHours: number,
  random: () => number = Math.random,
): number {
  const step = BACKOFF_MS[Math.min(Math.max(failuresBefore, 0), BACKOFF_MS.length - 1)]!;
  return jittered(Math.min(step, intervalHours * HOUR), random);
}
