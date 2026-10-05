import { describe, expect, it } from 'vitest';
import { maxMajor, toMajor, toMinor } from './amount.js';

describe('amount conversion', () => {
  it('rounds away binary floating-point noise', () => {
    expect(toMinor(0.1 + 0.2, 'USD')).toBe(30);
    expect(toMinor(1.005, 'USD')).toBe(100); // 1.005 is 1.00499999… as a double
    expect(toMinor(19.99, 'USD')).toBe(1999);
  });

  it('follows the currency exponent', () => {
    expect(toMinor(1500, 'JPY')).toBe(1500);
    expect(toMinor(12.345, 'KWD')).toBe(12345);
    expect(toMinor(1.2345, 'CLF')).toBe(12345);
    expect(toMajor(12345, 'KWD')).toBe(12.345);
  });

  it('never produces negative zero', () => {
    expect(Object.is(toMinor(-0.001, 'USD'), 0)).toBe(true);
  });

  it('round-trips every amount up to 15 significant digits', () => {
    for (const currency of ['JPY', 'USD', 'KWD', 'CLF']) {
      const max = maxMajor(currency);
      const maxMinor = toMinor(max, currency);
      expect(maxMinor).toBe(10 ** 15 - 1);
      const samples = [0, 1, 99, 100, 101, 123456, maxMinor, maxMinor - 1];
      for (let i = 0; i < 2000; i++) samples.push(Math.floor(Math.random() * maxMinor));
      for (const minor of samples) {
        expect(toMinor(toMajor(minor, currency), currency)).toBe(minor);
        expect(toMinor(toMajor(-minor, currency), currency)).toBe(-minor || 0);
      }
    }
  });

  it('refuses amounts that are not safe integers', () => {
    expect(() => toMinor(1e300, 'USD')).toThrow(RangeError);
  });
});
