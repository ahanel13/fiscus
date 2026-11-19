// SPDX-License-Identifier: AGPL-3.0-or-later

// Joint-account funding targets (ADR 0006 §7.3, #113): what a member agreed to move into a joint
// account each period, against what they've moved. Counted from the target's start, so a short
// period is made up by the next and an extra one carries forward.

export type FundingCadence = 'weekly' | 'every_two_weeks' | 'monthly';

/** `not_started`: its first period hasn't begun. */
export type FundingStatus = 'on_track' | 'behind' | 'ahead' | 'not_started';

export interface FundingPeriod {
  /** First and last day, inclusive. */
  from: string;
  to: string;
}

export interface FundingPeriodProgress extends FundingPeriod {
  targetMinor: number;
  contributedMinor: number;
}

export interface FundingProgress {
  status: FundingStatus;
  /** Moved in since the target started, up to the end of this period. */
  contributedMinor: number;
  /** Due by the end of the last period that's over. */
  dueBeforeMinor: number;
  /** Due by the end of this period. */
  dueByEndMinor: number;
  /** Behind: how much short of what was due by now. Ahead: how much over this period's. Else 0. */
  differenceMinor: number;
  /** Still to move in this period, catching up included. */
  leftThisPeriodMinor: number;
  /** The period today is in; null before the first one. */
  current: FundingPeriodProgress | null;
  /** The latest periods, newest first, this one included. */
  recent: FundingPeriodProgress[];
}

const DAY_MS = 86_400_000;
const time = (d: string) => Date.parse(`${d}T00:00:00Z`);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => day(time(d) + n * DAY_MS);
const nextMonth = (d: string) => {
  const [y, m] = d.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

/** The day after a period that starts on `from`. Monthly ones are calendar months. */
export function nextPeriodStart(cadence: FundingCadence, from: string): string {
  if (cadence === 'monthly') return nextMonth(from);
  return addDays(from, cadence === 'weekly' ? 7 : 14);
}

/** Every period from the target's start to the one `today` is in, oldest first. */
export function fundingPeriods(
  cadence: FundingCadence,
  startsOn: string,
  today: string,
): FundingPeriod[] {
  const out: FundingPeriod[] = [];
  for (let from = startsOn; from <= today; from = nextPeriodStart(cadence, from)) {
    out.push({ from, to: addDays(nextPeriodStart(cadence, from), -1) });
  }
  return out;
}

/**
 * Where a fixed target stands on `today`. Behind: less has come in than was due by the end of
 * the last period that's over. Ahead: more than is due by the end of this one. On track
 * otherwise, so this period's amount can arrive any day in it.
 */
export function fundingProgress(input: {
  amountMinor: number;
  cadence: FundingCadence;
  startsOn: string;
  today: string;
  /** Money in from the member, by the date it counts on. */
  contributions: readonly { date: string; amountMinor: number }[];
  /** How many recent periods to list (default 6). */
  recent?: number;
}): FundingProgress {
  const { amountMinor, cadence, startsOn, today } = input;
  const periods = fundingPeriods(cadence, startsOn, today);
  if (periods.length === 0) {
    return {
      status: 'not_started',
      contributedMinor: 0,
      dueBeforeMinor: 0,
      dueByEndMinor: 0,
      differenceMinor: 0,
      leftThisPeriodMinor: 0,
      current: null,
      recent: [],
    };
  }
  const progress = periods.map((p) => ({
    ...p,
    targetMinor: amountMinor,
    contributedMinor: input.contributions
      .filter((c) => c.date >= p.from && c.date <= p.to)
      .reduce((s, c) => s + c.amountMinor, 0),
  }));
  const contributed = progress.reduce((s, p) => s + p.contributedMinor, 0);
  const dueBefore = amountMinor * (periods.length - 1);
  const dueByEnd = amountMinor * periods.length;
  const status: FundingStatus =
    contributed < dueBefore ? 'behind' : contributed > dueByEnd ? 'ahead' : 'on_track';
  return {
    status,
    contributedMinor: contributed,
    dueBeforeMinor: dueBefore,
    dueByEndMinor: dueByEnd,
    differenceMinor:
      status === 'behind'
        ? dueBefore - contributed
        : status === 'ahead'
          ? contributed - dueByEnd
          : 0,
    leftThisPeriodMinor: Math.max(0, dueByEnd - contributed),
    current: progress.at(-1)!,
    recent: progress.slice(-(input.recent ?? 6)).reverse(),
  };
}

/** Where a new target starts by default: the first day of today's period (for monthly, the 1st). */
export function defaultFundingStart(cadence: FundingCadence, today: string): string {
  return cadence === 'monthly' ? `${today.slice(0, 7)}-01` : today;
}
