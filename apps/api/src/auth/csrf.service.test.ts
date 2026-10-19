// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { MasterKey, MasterKeys } from '@fiscus/crypto';
import { describe, expect, it } from 'vitest';
import { CsrfService } from './csrf.service.js';

describe('CSRF tokens across a master key rotation (#25)', () => {
  const key = (version: number) =>
    MasterKey.fromBase64(randomBytes(32).toString('base64'), version);
  const v1 = key(1);
  const v2 = key(2);
  const check = (csrf: CsrfService, token: string, session: string | null = 's1') =>
    csrf.verify(token, token, session);

  it('accepts a token signed with the previous key while it is loaded, and not after', () => {
    const before = new CsrfService(new MasterKeys(v1)).issue('s1');
    expect(check(new CsrfService(new MasterKeys(v2, [v1])), before)).toBe(true);
    expect(check(new CsrfService(new MasterKeys(v2)), before)).toBe(false);
  });

  it('signs with the current key, and still binds the token to its session', () => {
    const rotating = new CsrfService(new MasterKeys(v2, [v1]));
    const token = rotating.issue('s1');
    expect(check(new CsrfService(new MasterKeys(v2)), token)).toBe(true);
    expect(check(rotating, token, 's2')).toBe(false);
    expect(check(rotating, token, null)).toBe(false);
  });
});
