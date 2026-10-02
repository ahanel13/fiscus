import { type DbHandle, householdMembers, households } from '@fiscus/db';
import type { MemberRole } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { problems } from '../common/problem.js';
import { DB } from '../database/database.module.js';

export interface Membership {
  memberId: string;
  householdId: string;
  role: MemberRole;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the caller's membership in a household. Non-members get 404 (never confirm that a
 * household exists); members without the needed role get 403 (permissions §1). The request-scoped
 * HouseholdContext and database-enforced scoping arrive in #18/#19.
 */
@Injectable()
export class HouseholdAccess {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  async require(userId: string, householdId: string, roles?: MemberRole[]): Promise<Membership> {
    if (!UUID.test(householdId)) throw problems.notFound();
    const [row] = await this.db.db
      .select({ memberId: householdMembers.id, role: householdMembers.role })
      .from(householdMembers)
      .innerJoin(households, eq(households.id, householdMembers.householdId))
      .where(
        and(
          eq(householdMembers.householdId, householdId),
          eq(householdMembers.userId, userId),
          isNull(householdMembers.leftAt),
          eq(households.status, 'active'),
        ),
      )
      .limit(1);
    if (!row) throw problems.notFound();
    if (roles && !roles.includes(row.role)) throw problems.forbidden();
    return { memberId: row.memberId, householdId, role: row.role };
  }
}
