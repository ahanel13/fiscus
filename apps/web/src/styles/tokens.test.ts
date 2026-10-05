// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment node
// (reads tokens.css from disk; the browser-like environment stubs CSS imports)
import { readFileSync } from 'node:fs';
import { MEMBER_COLORS } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import { contrast } from './contrast.js';

/** Parses `--name: #hex;` declarations from one block of tokens.css. */
function tokens(block: 'root' | 'dark'): Record<string, string> {
  const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
  const start = css.indexOf(block === 'root' ? ':root {' : '.dark {');
  const body = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]!.toLowerCase()]),
  );
}

// [foreground, background, minimum ratio]. 4.5 = WCAG AA text, 3 = large text / UI graphics.
const PAIRS: [string, string, number][] = [
  ['fg', 'bg', 7],
  ['fg', 'surface', 7],
  ['fg', 'surface-2', 7],
  ['muted', 'bg', 4.5],
  ['muted', 'surface', 4.5],
  ['muted', 'surface-2', 4.5],
  ['subtle', 'surface', 3],
  ['accent-fg', 'accent', 4.5],
  ['accent-fg', 'accent-hover', 4.5],
  ['accent-text', 'surface', 4.5],
  ['accent-text', 'accent-soft', 4.5],
  ['accent', 'surface', 3],
  ['positive', 'surface', 4.5],
  ['positive', 'bg', 4.5],
  ['danger', 'surface', 4.5],
  ['danger', 'danger-soft', 4.5],
  ['warning', 'surface', 4.5],
  ['warning', 'warning-soft', 4.5],
  ['border-strong', 'surface', 1.4],
];

describe.each(['root', 'dark'] as const)('%s theme tokens', (block) => {
  const t = tokens(block);

  it('parses the theme', () => expect(Object.keys(t).length).toBeGreaterThan(20));

  it.each(PAIRS)('%s on %s ≥ %d:1', (fg, bg, min) => {
    expect(t[fg], `missing --${fg}`).toBeDefined();
    expect(t[bg], `missing --${bg}`).toBeDefined();
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(min);
  });

  it('chart colors are ≥3:1 against the surface (WCAG 1.4.11)', () => {
    for (let i = 1; i <= 8; i++) {
      expect(contrast(t[`chart-${i}`]!, t.surface!), `--chart-${i}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('member colors are ≥3:1 against the surface', () => {
    for (const c of MEMBER_COLORS) expect(contrast(c, t.surface!), c).toBeGreaterThanOrEqual(3);
  });
});

describe('contrast()', () => {
  it('handles the short hex form minifiers produce', () => {
    expect(contrast('#fff', '#000')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#fff')).toBe(1);
  });
});

describe('member colors', () => {
  it('carry white initials at ≥4.5:1 and are all distinct', () => {
    for (const c of MEMBER_COLORS) expect(contrast(c, '#ffffff'), c).toBeGreaterThanOrEqual(4.5);
    expect(new Set(MEMBER_COLORS).size).toBe(MEMBER_COLORS.length);
  });
});
