// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { passwordMissing, passwordSchema } from './auth.js';

describe('the password policy', () => {
  it('needs 15 characters, upper and lower case, a number, and a symbol', () => {
    expect(passwordSchema.safeParse('Correct horse 1!').success).toBe(true);
    expect(passwordSchema.safeParse('Ünïcode Pässwörd 9§').success).toBe(true);
    expect(passwordMissing('Short 1!').map((r) => r.id)).toEqual(['length']);
    expect(passwordMissing('all lowercase words').map((r) => r.id)).toEqual([
      'upper',
      'number',
      'symbol',
    ]);
    // A space isn't a symbol.
    expect(passwordMissing('Spaces only 123 here').map((r) => r.id)).toEqual(['symbol']);
  });

  it('says what’s missing in one message, and caps the length', () => {
    const r = passwordSchema.safeParse('lowercase only long');
    expect(r.error?.issues.map((i) => i.message)).toEqual([
      'Your password needs: an uppercase letter, a number, a symbol (like ! or #).',
    ]);
    expect(passwordSchema.safeParse(`Aa1!${'x'.repeat(253)}`).success).toBe(false);
  });
});
