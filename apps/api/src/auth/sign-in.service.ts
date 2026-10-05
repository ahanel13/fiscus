// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CurrentUser } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthCookies } from './cookies.js';
import { CsrfService } from './csrf.service.js';
import { type ClientMeta, SessionService } from './session.service.js';

export interface SignedIn {
  data: { user: CurrentUser; csrfToken: string };
}

export const clientMeta = (req: FastifyRequest): ClientMeta => ({
  ip: req.ip ?? null,
  userAgent: req.headers['user-agent'] ?? null,
});

/** Starts sessions and issues the matching CSRF token. Shared by login, setup, and invites. */
@Injectable()
export class SignInService {
  constructor(
    private readonly sessions: SessionService,
    private readonly csrf: CsrfService,
    private readonly cookies: AuthCookies,
  ) {}

  /** Starts a fresh session (rotating out any previous one) and returns a matching CSRF token. */
  async signIn(user: CurrentUser, req: FastifyRequest, reply: FastifyReply): Promise<SignedIn> {
    if (req.auth) await this.sessions.revoke(req.auth.session.id);
    const { token, id } = await this.sessions.create(user.id, clientMeta(req));
    this.cookies.setSession(reply, token);
    return { data: { user, csrfToken: this.newCsrf(reply, id) } };
  }

  newCsrf(reply: FastifyReply, sessionId: string | null): string {
    const token = this.csrf.issue(sessionId);
    this.cookies.setCsrf(reply, token);
    return token;
  }
}
