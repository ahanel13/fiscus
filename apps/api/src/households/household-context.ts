// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MemberRole } from '@fiscus/shared';
import type { FastifyRequest } from 'fastify';
import { problems } from '../common/problem.js';
import { HouseholdAccess } from './household-access.js';

/** The household a request acts in, resolved from the path and the caller's membership. */
export interface HouseholdContext {
  householdId: string;
  memberId: string;
  role: MemberRole;
  userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    household?: HouseholdContext;
  }
}

const HOUSEHOLD_ROLES = 'fiscus:householdRoles';

/** Restricts a household route to these roles (members with other roles get 403). */
export const HouseholdRoles = (...roles: MemberRole[]) => SetMetadata(HOUSEHOLD_ROLES, roles);

/**
 * Resolves `:householdId` into a HouseholdContext before validation runs, so outsiders get 404
 * without learning anything from field errors (permissions §1). Runs after the global AuthGuard.
 */
@Injectable()
export class HouseholdGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: HouseholdAccess,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest<{ Params: { householdId?: string } }>>();
    const householdId = req.params.householdId;
    if (householdId === undefined) return true;
    if (!req.auth) throw problems.unauthenticated();
    const roles = this.reflector.getAllAndOverride<MemberRole[] | undefined>(HOUSEHOLD_ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const membership = await this.access.require(req.auth.user.id, householdId, roles);
    req.household = { ...membership, userId: req.auth.user.id };
    return true;
  }
}

export const Household = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const household = ctx.switchToHttp().getRequest<FastifyRequest>().household;
  if (!household) throw new Error('@Household() used on a route without :householdId');
  return household;
});
