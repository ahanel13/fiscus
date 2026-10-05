/**
 * Member identity colors (ADR 0006): distinct from each other and from the semantic red/green,
 * readable with white initials (≥4.5:1), and ≥3:1 against both light and dark surfaces.
 * Assigned in join order. Checked by apps/web/src/styles/tokens.test.ts.
 */
export const MEMBER_COLORS = [
  '#2f6fdb', // blue
  '#c2410c', // orange
  '#7c4dcc', // violet
  '#be3d86', // magenta
  '#0e7490', // cyan
  '#6b7d1f', // olive
  '#9a5b34', // brown
  '#5d6f8a', // slate
] as const;
