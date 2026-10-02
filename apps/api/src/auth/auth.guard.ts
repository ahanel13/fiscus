import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { problems } from '../common/problem.js';
import { AuthCookies } from './cookies.js';
import { CsrfService } from './csrf.service.js';
import {
  IS_PUBLIC,
  NO_SESSION,
  REQUIRE_INSTANCE_ADMIN,
  REQUIRE_RECENT_AUTH,
  SKIP_CSRF,
} from './decorators.js';
import { SessionService } from './session.service.js';

export const REAUTH_WINDOW_MS = 10 * 60_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Global guard: resolves the session, enforces CSRF, then route requirements. Deny by default. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly csrf: CsrfService,
    private readonly cookies: AuthCookies,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const flag = (key: string) =>
      this.reflector.getAllAndOverride<boolean>(key, [ctx.getHandler(), ctx.getClass()]) ?? false;

    if (flag(NO_SESSION)) return true;

    const token = this.cookies.readSession(req);
    req.auth = token ? await this.sessions.resolve(token) : null;

    if (!SAFE_METHODS.has(req.method) && !flag(SKIP_CSRF)) {
      const header = req.headers['x-csrf-token'];
      const ok = this.csrf.verify(
        typeof header === 'string' ? header : undefined,
        this.cookies.readCsrf(req),
        req.auth?.session.id ?? null,
      );
      if (!ok) throw problems.csrf();
    }

    if (flag(IS_PUBLIC)) return true;
    if (!req.auth) throw problems.unauthenticated();
    if (flag(REQUIRE_INSTANCE_ADMIN) && !req.auth.user.isInstanceAdmin) throw problems.forbidden();
    if (
      flag(REQUIRE_RECENT_AUTH) &&
      this.sessions.now().getTime() - req.auth.session.reauthenticatedAt.getTime() >
        REAUTH_WINDOW_MS
    ) {
      throw problems.reauthRequired();
    }
    return true;
  }
}
