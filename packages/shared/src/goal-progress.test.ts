// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { goalHistory, goalProgress, paceOf, savingsPace, steadyAt } from './goal-progress.js';

const fixed = (accountId: string, amountMinor: number) => ({
  accountId,
  amountMinor,
  percentBps: null,
  valueMinor: amountMinor,
});
const percent = (accountId: string, percentBps: number, valueMinor: number) => ({
  accountId,
  amountMinor: null,
  percentBps,
  valueMinor,
});

describe('paceOf (G18)', () => {
  const moved = new Map([
    ['2026-08', 30_000],
    ['2026-09', 40_000],
    ['2026-10', 20_000],
    ['2026-11', 90_000],
  ]);

  it('is what moved over the last three full months, not this one', () => {
    expect(
      paceOf({ thisMonth: '2026-11', firstMonth: '2026-06', planMinor: 50_000, moved }),
    ).toEqual({ paceMinor: 30_000, basis: 'moved' });
  });

  it('is its plan while it’s newer than three months', () => {
    expect(
      paceOf({ thisMonth: '2026-11', firstMonth: '2026-09', planMinor: 50_000, moved }),
    ).toEqual({ paceMinor: 50_000, basis: 'plan' });
    expect(paceOf({ thisMonth: '2026-11', firstMonth: '2026-11', planMinor: null, moved })).toEqual(
      { paceMinor: 0, basis: 'plan' },
    );
  });

  it('doesn’t keep a plan nobody follows: nothing moved is no pace', () => {
    expect(
      paceOf({ thisMonth: '2026-11', firstMonth: '2026-01', planMinor: 50_000, moved: new Map() }),
    ).toEqual({ paceMinor: 0, basis: 'moved' });
  });

  it('crosses years', () => {
    const m = new Map([
      ['2026-11', 10_000],
      ['2026-12', 20_000],
    ]);
    expect(paceOf({ thisMonth: '2027-01', firstMonth: '2026-10', planMinor: 0, moved: m })).toEqual(
      { paceMinor: 10_000, basis: 'moved' },
    );
  });
});

describe('goalHistory (G11, G12, G17)', () => {
  it('counts earmarking money already there as progress, not saving (G11)', () => {
    const [m] = goalHistory({
      before: [],
      ends: [{ month: '2026-09', claims: [fixed('harbor', 320_000)] }],
      moved: new Map(),
    });
    expect(m).toEqual({
      month: '2026-09',
      savedMinor: 320_000,
      movedMinor: 0,
      marketMinor: 0,
      claimsMinor: 320_000,
    });
  });

  it('shows a percentage claim’s fall as the market’s, apart from what moved in (G12)', () => {
    const months = goalHistory({
      before: [percent('brokerage', 4000, 1_000_000)],
      ends: [
        { month: '2026-10', claims: [percent('brokerage', 4000, 960_000)] },
        { month: '2026-11', claims: [percent('brokerage', 4000, 1_010_000)] },
      ],
      moved: new Map([['2026-11', new Map([['brokerage', 20_000]])]]),
    });
    expect(months.map((m) => [m.movedMinor, m.marketMinor, m.claimsMinor])).toEqual([
      [0, -40_000, 0],
      [20_000, 30_000, 0],
    ]);
  });

  it('counts a claim raised, lowered or taken off as a change of claims', () => {
    const months = goalHistory({
      before: [fixed('harbor', 100_000), percent('brokerage', 1000, 50_000)],
      ends: [
        {
          month: '2026-10',
          claims: [fixed('harbor', 150_000), percent('brokerage', 1000, 50_000)],
        },
        { month: '2026-11', claims: [fixed('harbor', 150_000)] },
      ],
      moved: new Map([['2026-10', new Map([['harbor', 50_000]])]]),
    });
    expect(months.map((m) => [m.savedMinor, m.movedMinor, m.claimsMinor, m.marketMinor])).toEqual([
      [200_000, 50_000, 50_000, 0],
      [150_000, 0, -50_000, 0],
    ]);
  });

  it('only totals the first month when what came before isn’t known', () => {
    const [m] = goalHistory({
      before: null,
      ends: [{ month: '2026-11', claims: [fixed('harbor', 100_000)] }],
      moved: new Map(),
    });
    expect(m).toMatchObject({ savedMinor: 100_000, claimsMinor: 0, marketMinor: 0 });
  });
});

describe('savingsPace (walkthrough §4)', () => {
  const base = {
    progressMinor: 300_000,
    targetMinor: 600_000,
    targetDate: '2027-05-01',
    planMinor: 50_000,
    shortMinor: 0,
    thisMonth: '2026-11',
  };

  it('uses the pace given before its plan', () => {
    expect(savingsPace({ ...base, paceMinor: 25_000 })).toEqual({
      status: 'at_risk',
      projectedMonth: '2027-10',
      monthsLate: 5,
    });
    expect(savingsPace({ ...base, paceMinor: 0, planMinor: 999_999 }).status).toBe('at_risk');
  });

  it('is ahead a month’s plan or more past the steady line, else on track', () => {
    const steady = {
      fromMonth: '2026-05',
      fromMinor: 0,
      toMonth: '2027-05',
      toMinor: 600_000,
    };
    // Steady by the end of October (five months of twelve) is $2,500: $2,800 is on track.
    expect(
      savingsPace({ ...base, progressMinor: 280_000, steady: { ...steady, at: 24_321 } }).status,
    ).toBe('on_track');
    // $3,000 is one $500 plan past it.
    expect(savingsPace({ ...base, steady: { ...steady, at: 24_321 } })).toMatchObject({
      status: 'ahead',
      monthsLate: 0,
    });
    // Without a plan, a steady month's amount ($500) is the measure.
    expect(
      savingsPace({
        ...base,
        planMinor: null,
        paceMinor: 60_000,
        progressMinor: 290_000,
        steady: { ...steady, at: 24_321 },
      }).status,
    ).toBe('on_track');
  });

  it('is never ahead when late, short or done', () => {
    const steady = { fromMonth: '2026-05', fromMinor: 0, toMonth: '2027-05', toMinor: 600_000 };
    const s = { ...steady, at: 24_321 };
    expect(savingsPace({ ...base, progressMinor: 500_000, shortMinor: 1, steady: s }).status).toBe(
      'short',
    );
    expect(
      savingsPace({ ...base, progressMinor: 500_000, paceMinor: 1_000, steady: s }).status,
    ).toBe('at_risk');
    expect(savingsPace({ ...base, progressMinor: 600_000, steady: s }).status).toBe('done');
  });
});

describe('steadyAt', () => {
  const s = { fromMonth: '2026-01', fromMinor: 100_000, toMonth: '2026-11', toMinor: 600_000 };
  it('runs straight from where it began to the target by its month', () => {
    expect(steadyAt(s, 2026 * 12)).toBe(100_000);
    expect(steadyAt(s, 2026 * 12 + 5)).toBe(350_000);
    expect(steadyAt(s, 2026 * 12 + 10)).toBe(600_000);
    expect(steadyAt(s, 2030 * 12)).toBe(600_000);
  });
});

describe('goalProgress (#135, #137)', () => {
  const g = {
    goalId: 'trip',
    thisMonth: '2026-11',
    monthFraction: 0.5,
    firstMonth: '2026-05',
    targetMinor: 600_000,
    targetDate: '2027-05-01',
    planMinor: 50_000,
    shortMinor: 0,
    progressMinor: 300_000,
    months: [],
    start: { month: '2026-05', minor: 0 },
  };
  const movedEach = (amount: number) =>
    new Map(['2026-08', '2026-09', '2026-10'].map((m) => [m, amount]));

  it('projects at its pace, this month counting, to the target', () => {
    const p = goalProgress({ ...g, moved: movedEach(100_000) });
    expect(p.pace).toMatchObject({ basis: 'moved', paceMinor: 100_000, projectedMonth: '2027-01' });
    expect(p.projection).toEqual([
      { month: '2026-11', savedMinor: 400_000 },
      { month: '2026-12', savedMinor: 500_000 },
      { month: '2027-01', savedMinor: 600_000 },
    ]);
    expect(p.steady).toEqual({
      fromMonth: '2026-05',
      fromMinor: 0,
      toMonth: '2027-05',
      toMinor: 600_000,
    });
    expect(p.fixes).toEqual({ planMinor: null, month: null });
  });

  it('offers what to change when it’s at risk: the plan that makes the date, or the date', () => {
    const p = goalProgress({ ...g, planMinor: 30_000, moved: movedEach(25_000) });
    expect(p.pace).toMatchObject({ status: 'at_risk', projectedMonth: '2027-10', monthsLate: 5 });
    // $3,000 left over Nov–May: seven months.
    expect(p.fixes).toEqual({ planMinor: 42_858, month: '2027-10' });
    expect(p.projection).toHaveLength(12);
  });

  it('doesn’t offer a plan it already has', () => {
    const p = goalProgress({ ...g, planMinor: 60_000, moved: movedEach(25_000) });
    expect(p.fixes.planMinor).toBeNull();
  });

  it('has no projection without a pace, and stops at ten years', () => {
    expect(goalProgress({ ...g, moved: new Map() }).projection).toEqual([]);
    const slow = goalProgress({ ...g, targetMinor: 100_000_000, moved: movedEach(1_000) });
    expect(slow.projection).toHaveLength(120);
  });

  it('has no steady line without a date', () => {
    const p = goalProgress({ ...g, targetDate: null, moved: movedEach(100_000) });
    expect(p.steady).toBeNull();
    expect(p.pace.status).toBeNull();
  });
});
