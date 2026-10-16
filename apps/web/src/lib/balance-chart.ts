// SPDX-License-Identifier: AGPL-3.0-or-later
// The geometry of an account's balance chart (#353): pure, so it's tested without a browser.

export interface ChartPoint {
  /** A calendar date, "2026-10-03". */
  date: string;
  amountMinor: number;
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** Round tick values covering [min, max]: 1, 2, or 5 times a power of ten apart. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.1, 100);
    return niceTicks(min - pad, max + pad, target);
  }
  const raw = (max - min) / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = Math.floor(min / step) * step; t < max + step; t += step) {
    ticks.push(Math.round(t));
    if (t >= max) break;
  }
  return ticks;
}

/**
 * A balance holds until the next one changes it, so the line steps: across to the next day, then
 * up or down. The last balance carries to the range's end.
 */
export function stepPath(
  points: ChartPoint[],
  to: string,
  x: (date: string) => number,
  y: (minor: number) => number,
): string {
  if (points.length === 0) return '';
  const end = x(to);
  let d = `M${x(points[0]!.date)},${y(points[0]!.amountMinor)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` H${x(points[i]!.date)} V${y(points[i]!.amountMinor)}`;
  }
  return `${d} H${end}`;
}

/** Scales from dates and amounts to a 0–100 box (the SVG viewBox), y growing downward. */
export function scales(points: ChartPoint[], from: string, to: string) {
  const values = points.map((p) => p.amountMinor);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const start = day(from);
  const span = Math.max(day(to) - start, 1);
  return {
    ticks,
    x: (date: string) => ((day(date) - start) / span) * 100,
    y: (minor: number) => 100 - ((minor - lo) / (hi - lo || 1)) * 100,
  };
}

/** The point in effect at a horizontal position (0–100): the last one on or before it. */
export function pointAt(points: ChartPoint[], x: (date: string) => number, at: number): number {
  let index = 0;
  for (let i = 0; i < points.length; i++) if (x(points[i]!.date) <= at) index = i;
  return index;
}
