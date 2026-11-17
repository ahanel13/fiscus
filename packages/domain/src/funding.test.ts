// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { defaultFundingStart, fundingPeriods, fundingProgress } from './funding.js';

describe('fundingPeriods', () => {
  it('follows calendar months for a monthly target', () => {
    expect(fundingPeriods('monthly', '2026-01-01', '2026-03-15')).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-02-28' },
      { from: '2026-03-01', to: '2026-03-31' },
    ]);
    expect(fundingPeriods('monthly', '2026-12-01', '2027-01-02').at(-1)).toEqual({
      from: '2027-01-01',
      to: '2027-01-31',
    });
  });

  it('counts weeks and fortnights from the start', () => {
    expect(fundingPeriods('weekly', '2026-03-04', '2026-03-11')).toEqual([
      { from: '2026-03-04', to: '2026-03-10' },
      { from: '2026-03-11', to: '2026-03-17' },
    ]);
    expect(fundingPeriods('every_two_weeks', '2026-03-04', '2026-03-17')).toEqual([
      { from: '2026-03-04', to: '2026-03-17' },
    ]);
  });

  it('has none before the start', () => {
    expect(fundingPeriods('weekly', '2026-03-04', '2026-03-03')).toEqual([]);
  });
});

describe('fundingProgress', () => {
  const target = { amountMinor: 100_000, cadence: 'monthly' as const, startsOn: '2026-01-01' };

  it('is on track while this period’s amount hasn’t come in yet', () => {
    const p = fundingProgress({
      ...target,
      today: '2026-02-10',
      contributions: [{ date: '2026-01-02', amountMinor: 100_000 }],
    });
    expect(p).toMatchObject({
      status: 'on_track',
      contributedMinor: 100_000,
      differenceMinor: 0,
      leftThisPeriodMinor: 100_000,
    });
    expect(p.current).toMatchObject({ from: '2026-02-01', contributedMinor: 0 });
  });

  it('is behind when a period that’s over came up short, and says by how much', () => {
    const p = fundingProgress({
      ...target,
      today: '2026-02-10',
      contributions: [{ date: '2026-01-20', amountMinor: 60_000 }],
    });
    expect(p).toMatchObject({ status: 'behind', differenceMinor: 40_000 });
    // This period's, and catching up.
    expect(p.leftThisPeriodMinor).toBe(140_000);
  });

  it('lets a later period make up a short one', () => {
    const p = fundingProgress({
      ...target,
      today: '2026-02-10',
      contributions: [
        { date: '2026-01-20', amountMinor: 60_000 },
        { date: '2026-02-01', amountMinor: 140_000 },
      ],
    });
    expect(p.status).toBe('on_track');
    expect(p.leftThisPeriodMinor).toBe(0);
  });

  it('is ahead when more has come in than this period needs', () => {
    const p = fundingProgress({
      ...target,
      today: '2026-01-10',
      contributions: [
        { date: '2026-01-02', amountMinor: 100_000 },
        { date: '2026-01-09', amountMinor: 25_000 },
      ],
    });
    expect(p).toMatchObject({ status: 'ahead', differenceMinor: 25_000, leftThisPeriodMinor: 0 });
  });

  it('ignores money from before the start, and lists recent periods newest first', () => {
    const p = fundingProgress({
      ...target,
      today: '2026-09-15',
      contributions: [
        { date: '2025-12-31', amountMinor: 500_000 },
        ...['01', '02', '03', '04', '05', '06', '07', '08'].map((m) => ({
          date: `2026-${m}-01`,
          amountMinor: 100_000,
        })),
      ],
    });
    expect(p.status).toBe('on_track');
    expect(p.recent.map((r) => r.from)).toEqual([
      '2026-09-01',
      '2026-08-01',
      '2026-07-01',
      '2026-06-01',
      '2026-05-01',
      '2026-04-01',
    ]);
    expect(p.recent[0]).toMatchObject({ targetMinor: 100_000, contributedMinor: 0 });
  });

  it('hasn’t started before its first period', () => {
    const p = fundingProgress({ ...target, today: '2025-12-20', contributions: [] });
    expect(p).toMatchObject({ status: 'not_started', current: null, recent: [] });
  });
});

describe('defaultFundingStart', () => {
  it('starts monthly targets on the 1st, others today', () => {
    expect(defaultFundingStart('monthly', '2026-03-17')).toBe('2026-03-01');
    expect(defaultFundingStart('weekly', '2026-03-17')).toBe('2026-03-17');
  });
});
