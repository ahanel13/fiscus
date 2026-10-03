// Time-range presets (ADR 0011). Rolling and calendar presets are grouped separately so the
// difference is obvious.
export const RANGE_GROUPS = [
  {
    label: 'Rolling',
    presets: [
      ['last_7d', 'Last 7 days'],
      ['last_30d', 'Last 30 days'],
      ['last_90d', 'Last 90 days'],
    ],
  },
  {
    label: 'Calendar',
    presets: [
      ['this_month', 'This month'],
      ['last_month', 'Last month'],
      ['this_quarter', 'This quarter'],
      ['last_quarter', 'Last quarter'],
      ['last_3m', 'Last 3 months'],
      ['last_6m', 'Last 6 months'],
      ['last_12m', 'Last 12 months'],
      ['ytd', 'Year to date'],
      ['this_year', 'This year'],
      ['last_year', 'Last year'],
      ['all_time', 'All time'],
    ],
  },
] as const;

export type RangePreset = (typeof RANGE_GROUPS)[number]['presets'][number][0];
const ALL = new Set<string>(RANGE_GROUPS.flatMap((g) => g.presets.map(([v]) => v)));

export const parseRange = (value: unknown, fallback: RangePreset = 'last_30d'): RangePreset =>
  typeof value === 'string' && ALL.has(value) ? (value as RangePreset) : fallback;
