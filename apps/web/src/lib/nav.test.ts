// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { phoneTabs, SECTIONS, visibleSections } from './nav.js';
import { lensOptions, lensVisible, parseLens } from './lens.js';
import { parseRange } from './ranges.js';

describe('navigation model', () => {
  it('has unique ids, paths, and jump shortcuts', () => {
    const unique = (xs: unknown[]) => new Set(xs).size === xs.length;
    expect(unique(SECTIONS.map((s) => s.id))).toBe(true);
    expect(unique(SECTIONS.map((s) => s.path))).toBe(true);
    expect(unique(SECTIONS.flatMap((s) => (s.shortcut ? [s.shortcut] : [])))).toBe(true);
  });

  it.each([
    ['single member', 'hybrid', 1, false],
    ['combined couple', 'combined', 2, false],
    ['hybrid couple', 'hybrid', 2, true],
    ['roommates', 'roommates', 3, true],
  ] as const)('%s → shared costs %s', (_, financeStyle, members, shown) => {
    const ids = visibleSections({ financeStyle }, members).map((s) => s.id);
    expect(ids.includes('shared')).toBe(shown);
    expect(lensVisible({ financeStyle }, members)).toBe(shown);
  });

  it('puts shared costs first for roommates, and swaps it into the phone tabs', () => {
    expect(
      visibleSections({ financeStyle: 'roommates' }, 3)
        .map((s) => s.id)
        .slice(0, 2),
    ).toEqual(['dashboard', 'shared']);
    expect(phoneTabs({ financeStyle: 'roommates' }, 3)).toContain('shared');
    expect(phoneTabs({ financeStyle: 'hybrid' }, 2)).toContain('accounts');
  });

  it('hides the assistant until AI is enabled', () => {
    expect(visibleSections({ financeStyle: 'hybrid' }, 1).map((s) => s.id)).not.toContain(
      'assistant',
    );
    expect(
      visibleSections({ financeStyle: 'hybrid' }, 1, { assistantEnabled: true }).map((s) => s.id),
    ).toContain('assistant');
  });
});

describe('lens', () => {
  it('uses viewer-relative, name-based labels', () => {
    const members = [
      { id: 'a', displayName: 'Anthony', isYou: true },
      { id: 'b', displayName: 'Alex', isYou: false },
    ];
    expect(lensOptions(members).map((o) => o.label)).toEqual(['Mine', 'Alex', 'Ours', 'All']);
  });

  it('parses only valid values', () => {
    expect(parseLens('me')).toBe('me');
    expect(parseLens('member:01a0fe9e-40fe-74ab-b5c8-d1607913c4a0')).toBe(
      'member:01a0fe9e-40fe-74ab-b5c8-d1607913c4a0',
    );
    expect(parseLens('member:../../x')).toBe('all');
    expect(parseRange('ytd')).toBe('ytd');
    expect(parseRange('forever')).toBe('last_30d');
  });
});
