// SPDX-License-Identifier: AGPL-3.0-or-later
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from './auth-context.js';

export const IS_PUBLIC = 'fiscus:isPublic';
export const NO_SESSION = 'fiscus:noSession';
export const SKIP_CSRF = 'fiscus:skipCsrf';
export const REQUIRE_INSTANCE_ADMIN = 'fiscus:requireInstanceAdmin';
export const REQUIRE_RECENT_AUTH = 'fiscus:requireRecentAuth';

/** No session required (CSRF is still checked on unsafe methods). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/**
 * Skips session lookup and CSRF entirely. For infrastructure endpoints (health probes) that must
 * not depend on the database or cookies.
 */
export const NoSession = () => SetMetadata(NO_SESSION, true);
/** For machine-to-machine endpoints such as provider webhooks. */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);
export const RequireInstanceAdmin = () => SetMetadata(REQUIRE_INSTANCE_ADMIN, true);
/** The session must have confirmed its password recently (API conventions §7). */
export const RequireRecentAuth = () => SetMetadata(REQUIRE_RECENT_AUTH, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<FastifyRequest>().auth;
  if (!auth) throw new Error('@Auth() used on a route without authentication');
  return auth;
});
