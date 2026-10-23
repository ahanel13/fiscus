// SPDX-License-Identifier: AGPL-3.0-or-later

// "2 hours ago", "in 3 hours", "just now": how fresh a sync is (the bank connections walkthrough
// §5). Rounded to the unit that reads naturally; the exact time goes in a title or a date.

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 24 * 60 * 60_000],
  ['hour', 60 * 60_000],
  ['minute', 60_000],
];

/** `iso` relative to `now`: "just now" within a minute either way. */
export function relativeTime(iso: string, now: number = Date.now(), locale?: string): string {
  const diff = Date.parse(iso) - now;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(diff) < 60_000) return 'just now';
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms || unit === 'minute')
      return format.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}
