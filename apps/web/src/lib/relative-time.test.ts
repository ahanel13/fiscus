// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time.js';

const now = Date.parse('2026-10-22T12:00:00Z');
const at = (ms: number) => new Date(now + ms).toISOString();

describe('relativeTime', () => {
  it('reads naturally, past and future', () => {
    expect(relativeTime(at(-20_000), now, 'en')).toBe('just now');
    expect(relativeTime(at(-5 * 60_000), now, 'en')).toBe('5 minutes ago');
    expect(relativeTime(at(-2 * 3_600_000), now, 'en')).toBe('2 hours ago');
    expect(relativeTime(at(3 * 3_600_000 + 10 * 60_000), now, 'en')).toBe('in 3 hours');
    expect(relativeTime(at(-26 * 3_600_000), now, 'en')).toBe('yesterday');
    expect(relativeTime(at(-3 * 24 * 3_600_000), now, 'en')).toBe('3 days ago');
    expect(relativeTime(at(14 * 60_000), now, 'en')).toBe('in 14 minutes');
  });
});
