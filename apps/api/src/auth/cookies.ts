// SPDX-License-Identifier: AGPL-3.0-or-later
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { SESSION_TTL_MS } from './session.service.js';

/**
 * Session and CSRF cookies. With COOKIE_SECURE (the default) they use the `__Host-` prefix, which
 * browsers only accept when Secure, Path=/, and no Domain, so subdomains can't plant or read them.
 */
@Injectable()
export class AuthCookies {
  readonly session: string;
  readonly csrf: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const prefix = config.cookieSecure ? '__Host-' : '';
    this.session = `${prefix}fiscus_session`;
    this.csrf = `${prefix}fiscus_csrf`;
  }

  readSession(req: FastifyRequest): string | undefined {
    return req.cookies?.[this.session];
  }

  readCsrf(req: FastifyRequest): string | undefined {
    return req.cookies?.[this.csrf];
  }

  setSession(reply: FastifyReply, token: string): void {
    void reply.setCookie(this.session, token, {
      path: '/',
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  setCsrf(reply: FastifyReply, token: string): void {
    void reply.setCookie(this.csrf, token, {
      path: '/',
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
    });
  }

  clearSession(reply: FastifyReply): void {
    void reply.clearCookie(this.session, { path: '/', secure: this.config.cookieSecure });
  }
}
