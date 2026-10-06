// SPDX-License-Identifier: AGPL-3.0-or-later
// Dates and amounts as banks write them (docs/design/imports.md §1, column mapping). Amounts are
// converted to integer minor units by string arithmetic, never through a float.

export type DateFormat = 'ymd' | 'mdy' | 'dmy' | 'text';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const iso = (y: number, m: number, d: number): string | null => {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const year = (s: string) => {
  const n = Number(s);
  return s.length === 2 ? 2000 + n : n;
};

/** Parses a date in the given format to "YYYY-MM-DD", or null if it isn't a real date. */
export function parseDate(raw: string, format: DateFormat): string | null {
  const s = raw.trim().replace(/[T ]\d{1,2}:\d{2}.*$/, '');
  if (format === 'text') {
    // "Oct 6, 2026", "6 Oct 2026", "October 6 2026"
    const m1 = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
    const m2 = /^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s);
    const [mon, d, y] = m1 ? [m1[1]!, m1[2]!, m1[3]!] : m2 ? [m2[2]!, m2[1]!, m2[3]!] : [];
    if (!mon) return null;
    const month = MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1;
    return month ? iso(Number(y), month, Number(d)) : null;
  }
  const parts = s.split(/[-/.]/);
  if (parts.length !== 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  const [a, b, c] = parts as [string, string, string];
  if (format === 'ymd') return a.length === 4 ? iso(Number(a), Number(b), Number(c)) : null;
  if (c.length !== 4 && c.length !== 2) return null;
  return format === 'mdy' ? iso(year(c), Number(a), Number(b)) : iso(year(c), Number(b), Number(a));
}

export interface DateDetection {
  /** The formats that read the most samples (a bad row doesn't rule a format out). */
  formats: DateFormat[];
  /** Month-first and day-first both fit (every day ≤ 12): ask which. */
  ambiguous: boolean;
}

/** Works out which date formats fit the non-empty samples best. */
export function detectDateFormat(samples: string[]): DateDetection {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  const counts = (['ymd', 'mdy', 'dmy', 'text'] as const).map(
    (f) => [f, values.filter((v) => parseDate(v, f) !== null).length] as const,
  );
  const best = Math.max(...counts.map(([, n]) => n));
  const formats = best > 0 ? counts.filter(([, n]) => n === best).map(([f]) => f) : [];
  return { formats, ambiguous: formats.includes('mdy') && formats.includes('dmy') };
}

export type DecimalSeparator = '.' | ',';

/**
 * Which decimal separator the amounts use: "1.234,56" or "-12,50" mean a comma; anything else
 * ("1,234.56", "12.50", "12") means a point.
 */
export function detectDecimalSeparator(samples: string[]): DecimalSeparator {
  let comma = 0;
  let point = 0;
  for (const raw of samples) {
    const s = raw.replace(/[^\d.,]/g, '');
    const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    if (last < 0) continue;
    const decimals = s.length - last - 1;
    const sep = s[last];
    // "1,234" or "1.234" with three digits after could be thousands; it doesn't decide.
    if (decimals === 3 && s.indexOf(sep!) === last && !s.includes(sep === '.' ? ',' : '.')) {
      continue;
    }
    if (sep === ',') comma++;
    else point++;
  }
  return comma > point ? ',' : '.';
}

/**
 * Parses an amount to integer minor units: "$1,234.56", "-12.50", "(12.50)", "12.50-",
 * "1.234,56 €", "USD 12". Returns null if it isn't a number or has more decimals than the
 * currency allows.
 */
export function parseAmount(
  raw: string,
  decimal: DecimalSeparator,
  exponent: number,
): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[A-Za-z$€£¥₹\s\u00a0'’]/g, '');
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  const thousands = decimal === '.' ? ',' : '.';
  s = s.split(thousands).join('');
  const [whole, fraction = '', extra] = s.split(decimal);
  if (extra !== undefined || !/^\d*$/.test(whole!) || !/^\d*$/.test(fraction)) return null;
  if (whole === '' && fraction === '') return null;
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) return null;
  const minor =
    BigInt(whole || '0') * 10n ** BigInt(exponent) +
    BigInt((fraction.slice(0, exponent) || '0').padEnd(exponent, '0'));
  const value = Number(negative ? -minor : minor);
  return Number.isSafeInteger(value) ? value || 0 : null;
}
