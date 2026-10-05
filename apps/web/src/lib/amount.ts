import { minorUnitExponent } from '@fiscus/shared';

// Money is integer minor units everywhere (API conventions §2). Number fields work in major units
// (dollars), so these convert at the edge, rounding away binary floating-point noise: 0.1 + 0.2
// dollars must become 30 cents, not 30.000000000000004.

/**
 * The largest amount a number field accepts: 15 significant digits, which a double holds exactly
 * ($9,999,999,999,999.99 in USD). Beyond that, typed cents could silently change.
 */
export function maxMajor(currency: string): number {
  const exponent = minorUnitExponent(currency);
  return (10 ** 15 - 1) / 10 ** exponent;
}

export function toMinor(major: number, currency: string): number {
  const minor = Math.round(major * 10 ** minorUnitExponent(currency));
  if (!Number.isSafeInteger(minor)) throw new RangeError(`Amount out of range: ${major}`);
  return minor === 0 ? 0 : minor; // no -0
}

export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** minorUnitExponent(currency);
}
