// SPDX-License-Identifier: AGPL-3.0-or-later
// ISO 4217 minor-unit exponents that differ from the default of 2. Amounts are stored and
// transported in these minor units (API conventions §2), so this table, not CLDR display
// rules, decides where the decimal point goes.
const NON_DEFAULT_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

const CURRENCY_CODE = /^[A-Z]{3}$/;

export function minorUnitExponent(currency: string): number {
  if (!CURRENCY_CODE.test(currency)) {
    throw new RangeError(`Invalid ISO 4217 currency code: ${currency}`);
  }
  return NON_DEFAULT_EXPONENTS[currency] ?? 2;
}

export interface FormatMoneyOptions {
  locale?: string;
  signDisplay?: Intl.NumberFormatOptions['signDisplay'];
}

/**
 * Formats an amount in minor units (e.g. cents) for display, without ever converting it to a
 * floating-point value.
 */
export function formatMoney(
  amountMinor: number | bigint,
  currency: string,
  { locale = 'en-US', signDisplay = 'auto' }: FormatMoneyOptions = {},
): string {
  if (typeof amountMinor === 'number' && !Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`Money amounts must be integer minor units, got ${amountMinor}`);
  }
  const exponent = minorUnitExponent(currency);
  const minor = BigInt(amountMinor);
  const digits = (minor < 0n ? -minor : minor).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  const decimal = `${minor < 0n ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`;

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    signDisplay,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(decimal as Intl.StringNumericLiteral);
}
