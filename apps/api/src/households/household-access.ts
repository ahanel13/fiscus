import { type DbHandle, householdMembers, households, userContext, withContext } from '@fiscus/db';
import type { MemberRole, Membership as MembershipSummary } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { problems } from '../common/problem.js';
import { DB } from '../database/database.module.js';

export interface Membership {
  memberId: string;
  householdId: string;
  role: MemberRole;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * User-level membership lookups, which span households by nature: resolving the caller's role in
 * a household (non-members get 404, missing role 403, per permissions §1) and listing a user's
 * memberships. Allow-listed for direct DB access in architecture.test.ts; under row-level security
 * (#19) these run through policies keyed on app.user_id.
 */
@Injectable()
export class HouseholdAccess {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  async require(userId: string, householdId: string, roles?: MemberRole[]): Promise<Membership> {
    if (!UUID.test(householdId)) throw problems.notFound();
    const [row] = await withContext(this.db.db, userContext(userId), (tx) =>
      tx
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
        .limit(1),
    );
    if (!row) throw problems.notFound();
    if (roles && !roles.includes(row.role)) throw problems.forbidden();
    return { memberId: row.memberId, householdId, role: row.role };
  }

  async memberships(userId: string): Promise<MembershipSummary[]> {
    return withContext(this.db.db, userContext(userId), (tx) =>
      tx
        .select({
          householdId: households.id,
          householdName: households.name,
          memberId: householdMembers.id,
          role: householdMembers.role,
        })
        .from(householdMembers)
        .innerJoin(households, eq(households.id, householdMembers.householdId))
        .where(
          and(
            eq(householdMembers.userId, userId),
            isNull(householdMembers.leftAt),
            eq(households.status, 'active'),
          ),
        )
        .orderBy(asc(householdMembers.joinedAt)),
    );
  }
}
