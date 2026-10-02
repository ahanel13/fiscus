import { describe, expect, it } from 'vitest';
import { etagFor, parseIfMatch, planVersionedPatch } from './versioned-patch.js';

const current = { name: 'Home', timezone: 'America/Chicago', weekStart: 1 };
// v3: name changed in v2, timezone in v3.
const state = { version: 3, fieldVersions: { name: 2, timezone: 3 } };

describe('planVersionedPatch', () => {
  it('applies a patch based on the latest version and bumps changed fields', () => {
    const plan = planVersionedPatch(current, state, 3, { name: 'Our Home' });
    expect(plan).toEqual({
      ok: true,
      changes: { name: 'Our Home' },
      next: { version: 4, fieldVersions: { name: 4, timezone: 3 } },
    });
  });

  it('merges a stale save that touches only untouched fields', () => {
    // Based on v1; only timezone and name changed since, weekStart did not.
    const plan = planVersionedPatch(current, state, 1, { weekStart: 0 });
    expect(plan.ok).toBe(true);
  });

  it('rejects a stale save that changes a field someone else changed (first save wins)', () => {
    const plan = planVersionedPatch(current, state, 2, { timezone: 'Europe/Berlin', weekStart: 0 });
    expect(plan).toEqual({
      ok: false,
      conflicts: [
        {
          field: 'timezone',
          yourValue: 'Europe/Berlin',
          currentValue: 'America/Chicago',
          changedInVersion: 3,
        },
      ],
    });
  });

  it('treats setting a field to its current value as no change', () => {
    const plan = planVersionedPatch(current, state, 1, { timezone: 'America/Chicago' });
    expect(plan).toEqual({ ok: true, changes: {}, next: state });
  });
});

describe('If-Match / ETag', () => {
  it('round-trips', () => {
    expect(parseIfMatch(etagFor(12))).toBe(12);
    expect(parseIfMatch('W/"v3"')).toBe(3);
    expect(parseIfMatch('"12"')).toBeUndefined();
    expect(parseIfMatch(undefined)).toBeUndefined();
  });
});
