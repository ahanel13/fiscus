// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MasterKey } from '@fiscus/crypto';
import { Injectable } from '@nestjs/common';

/**
 * Signed double-submit CSRF tokens (OWASP). The token is set as a cookie and must be echoed in
 * X-CSRF-Token; its HMAC binds it to the current session, so a token from before login (or from
 * another session) is rejected.
 */
@Injectable()
export class CsrfService {
  constructor(private readonly master: MasterKey) {}

  issue(sessionId: string | null): string {
    const nonce = randomBytes(18).toString('base64url');
    return `${nonce}.${this.#mac(sessionId, nonce)}`;
  }

  verify(
    header: string | undefined,
    cookie: string | undefined,
    sessionId: string | null,
  ): boolean {
    if (!header || !cookie || header.length !== cookie.length) return false;
    if (!timingSafeEqual(Buffer.from(header), Buffer.from(cookie))) return false;
    const [nonce, mac] = header.split('.');
    if (!nonce || !mac) return false;
    const expected = this.#mac(sessionId, nonce);
    return (
      mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
    );
  }

  #mac(sessionId: string | null, nonce: string): string {
    return createHmac('sha256', this.master.csrfKey.bytes)
      .update(`${sessionId ?? 'anonymous'}.${nonce}`)
      .digest('base64url');
  }
}
