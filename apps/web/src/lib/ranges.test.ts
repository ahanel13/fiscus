// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bucketLabel, formatSpan, rangeParams, readSelection } from './ranges.js';

describe('range selections', () => {
  it('reads valid selections from the URL or a preference, and drops invalid ones', () => {
    expect(readSelection({ range: 'ytd' })).toEqual({ range: 'ytd', compare: 'none' });
    expect(
      readSelection({
        range: 'custom',
        from: '2026-01-01',
        to: '2026-03-31',
        granularity: 'month',
        compare: 'previous_period',
      }),
    ).toEqual({
      range: 'custom',
      from: '2026-01-01',
      to: '2026-03-31',
      granularity: 'month',
      compare: 'previous_period',
    });
    expect(
      readSelection({ range: 'custom', from: '2026-03-31', to: '2026-01-01' }),
    ).toBeUndefined(); // backwards
    expect(readSelection({ range: 'forever' })).toBeUndefined();
    expect(readSelection({ range: 'ytd', granularity: 'hourly', compare: 'sideways' })).toEqual({
      range: 'ytd',
      compare: 'none',
    });
    expect(readSelection(undefined)).toBeUndefined();
  });

  it('builds API parameters', () => {
    expect(rangeParams({ range: 'last_30d', compare: 'none' }).toString()).toBe('range=last_30d');
    expect(
      rangeParams(
        { range: 'custom', from: '2026-01-01', to: '2026-01-31', compare: 'previous_period' },
        'week',
      ).toString(),
    ).toBe('range=custom&from=2026-01-01&to=2026-01-31&granularity=week&compare=previous_period');
  });

  it('formats spans briefly, adding the year only when needed', () => {
    expect(formatSpan('2026-09-07', '2026-10-06', 2026)).toMatch(/Sep 7 – Oct 6$/);
    expect(formatSpan('2025-12-15', '2026-01-14', 2026)).toMatch(/2025.*2026/);
    expect(formatSpan('2026-10-06', '2026-10-06', 2026)).toMatch(/^Oct 6$/);
  });

  it('labels whole-month buckets by month', () => {
    expect(bucketLabel('2026-05-01', '2026-05-31', 2026)).toBe('May');
    expect(bucketLabel('2025-12-01', '2025-12-31', 2026)).toMatch(/December 2025/);
    expect(bucketLabel('2026-10-01', '2026-10-06', 2026)).toMatch(/Oct 1 – Oct 6/);
  });
});
