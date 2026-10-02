import { describe, expect, it } from 'vitest';
import { formatMoney, minorUnitExponent } from './money.js';

describe('minorUnitExponent', () => {
  it.each([
    ['USD', 2],
    ['EUR', 2],
    ['JPY', 0],
    ['BHD', 3],
    ['CLF', 4],
  ])('%s has exponent %i', (currency, exponent) => {
    expect(minorUnitExponent(currency)).toBe(exponent);
  });

  it('rejects malformed codes', () => {
    expect(() => minorUnitExponent('usd')).toThrow(RangeError);
  });
});

describe('formatMoney', () => {
  it('formats cents without float error', () => {
    expect(formatMoney(4580, 'USD')).toBe('$45.80');
    expect(formatMoney(-4580, 'USD')).toBe('-$45.80');
    expect(formatMoney(30, 'USD')).toBe('$0.30');
    expect(formatMoney(0, 'USD')).toBe('$0.00');
  });

  // Intl separates some currency symbols with a non-breaking space (U+00A0).
  it('uses each currency exponent', () => {
    expect(formatMoney(4200, 'EUR')).toBe('€42.00');
    expect(formatMoney(5000, 'JPY')).toBe('¥5,000');
    expect(formatMoney(1234, 'BHD')).toBe('BHD\u00a01.234');
  });

  it('is exact beyond the safe-integer range when given a bigint', () => {
    expect(formatMoney(12345678901234567890n, 'USD')).toBe('$123,456,789,012,345,678.90');
  });

  it('respects locale and sign display', () => {
    expect(formatMoney(4580, 'EUR', { locale: 'de-DE' })).toBe('45,80\u00a0€');
    expect(formatMoney(4580, 'USD', { signDisplay: 'always' })).toBe('+$45.80');
  });

  it('rejects non-integer amounts', () => {
    expect(() => formatMoney(45.8, 'USD')).toThrow(RangeError);
  });
});
