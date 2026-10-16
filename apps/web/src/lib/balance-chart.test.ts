// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { niceTicks, pointAt, scales, stepPath } from './balance-chart.js';

describe('balance chart', () => {
  it('picks round ticks that cover the values', () => {
    expect(niceTicks(0, 1000)).toEqual([0, 500, 1000]);
    expect(niceTicks(0, 700)).toEqual([0, 200, 400, 600, 800]);
    const t = niceTicks(97_000, 103_500);
    expect(t[0]).toBeLessThanOrEqual(97_000);
    expect(t.at(-1)).toBeGreaterThanOrEqual(103_500);
    expect(new Set(t.slice(1).map((v, i) => v - t[i]!)).size).toBe(1);
    // A flat line still gets a band around it.
    const flat = niceTicks(50_000, 50_000);
    expect(flat[0]).toBeLessThan(50_000);
    expect(flat.at(-1)).toBeGreaterThan(50_000);
  });

  it('steps across then up or down, carrying the last balance to the end', () => {
    const points = [
      { date: '2026-01-01', amountMinor: 100 },
      { date: '2026-01-11', amountMinor: 200 },
    ];
    const { x, y } = scales(points, '2026-01-01', '2026-01-21');
    expect(stepPath(points, '2026-01-21', x, y)).toBe(`M0,${y(100)} H50 V${y(200)} H100`);
  });

  it('finds the balance in effect at a position', () => {
    const points = [
      { date: '2026-01-01', amountMinor: 100 },
      { date: '2026-01-11', amountMinor: 200 },
    ];
    const { x } = scales(points, '2026-01-01', '2026-01-21');
    expect(pointAt(points, x, 10)).toBe(0);
    expect(pointAt(points, x, 50)).toBe(1);
    expect(pointAt(points, x, 99)).toBe(1);
  });
});
