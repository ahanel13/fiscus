import { type Executor, householdMembers, households, users } from '@fiscus/db';
import type { HouseholdMember, MemberRole } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from './household-context.js';
import { HouseholdScope } from './household-scope.js';

const lastOwner = () =>
  new Problem(
    409,
    'last_owner',
    'A household needs at least one owner',
    'Make someone else an owner first, or delete the household.',
  );

@Injectable()
export class MembersService {
  constructor(private readonly scope: HouseholdScope) {}

  async list(access: HouseholdContext): Promise<HouseholdMember[]> {
    const rows = await this.scope.run(access, (tx) =>
      tx
        .select({ member: householdMembers, email: users.email })
        .from(householdMembers)
        .leftJoin(users, eq(users.id, householdMembers.userId))
        .where(
          and(
            eq(householdMembers.householdId, access.householdId),
            isNull(householdMembers.leftAt),
          ),
        )
        .orderBy(asc(householdMembers.joinedAt)),
    );
    return rows.map(({ member, email }) => ({
      id: member.id,
      displayName: member.displayName,
      color: member.color,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
      isYou: member.id === access.memberId,
      // Emails are visible to owners only (permissions HH-03).
      ...(access.role === 'owner' && email ? { email } : {}),
    }));
  }

  async changeRole(access: HouseholdContext, memberId: string, role: MemberRole) {
    await this.scope.run(access, async (tx, activity) => {
      const target = await this.#lockTarget(tx, access.householdId, memberId);
      if (target.role === role) return;
      if (target.role === 'owner' && (await this.#ownerCount(tx, access.householdId)) <= 1) {
        throw lastOwner();
      }
      // HH-06: once accounts exist (#35, #52), demoting a member who owns accounts to viewer is
      // rejected here until their accounts are transferred.
      await tx.update(householdMembers).set({ role }).where(eq(householdMembers.id, memberId));
      await activity.record({
        action: 'member.role_changed',
        targetType: 'household_member',
        targetId: memberId,
        metadata: { from: target.role, to: role },
      });
    });
  }

  async remove(access: HouseholdContext, memberId: string): Promise<void> {
    if (memberId === access.memberId) {
      throw new Problem(409, 'use_leave', 'To remove yourself, leave the household instead');
    }
    await this.scope.run(access, async (tx, activity) => {
      const target = await this.#lockTarget(tx, access.householdId, memberId);
      if (target.role === 'owner' && (await this.#ownerCount(tx, access.householdId)) <= 1) {
        throw lastOwner();
      }
      await tx
        .update(householdMembers)
        .set({ leftAt: new Date() })
        .where(eq(householdMembers.id, memberId));
      await activity.record({
        action: 'member.removed',
        targetType: 'household_member',
        targetId: memberId,
      });
    });
  }

  async leave(access: HouseholdContext): Promise<void> {
    await this.scope.run(access, async (tx, activity) => {
      await this.#lockTarget(tx, access.householdId, access.memberId);
      if (access.role === 'owner' && (await this.#ownerCount(tx, access.householdId)) <= 1) {
        throw lastOwner();
      }
      // Record first: once left_at is set, this member's context no longer passes row-level
      // security for the rest of the transaction.
      await activity.record({
        action: 'member.left',
        targetType: 'household_member',
        targetId: access.memberId,
      });
      await tx
        .update(householdMembers)
        .set({ leftAt: new Date() })
        .where(eq(householdMembers.id, access.memberId));
    });
  }

  /** Locks the household row so concurrent role changes can't remove the last owner together. */
  async #lockTarget(tx: Executor, householdId: string, memberId: string) {
    await tx
      .select({ id: households.id })
      .from(households)
      .where(eq(households.id, householdId))
      .for('update');
    const [target] = await tx
      .select()
      .from(householdMembers)
      .where(
        and(
          eq(householdMembers.id, memberId),
          eq(householdMembers.householdId, householdId),
          isNull(householdMembers.leftAt),
        ),
      );
    if (!target) throw problems.notFound();
    return target;
  }

  async #ownerCount(tx: Executor, householdId: string): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(householdMembers)
      .where(
        and(
          eq(householdMembers.householdId, householdId),
          eq(householdMembers.role, 'owner'),
          isNull(householdMembers.leftAt),
        ),
      );
    return row?.n ?? 0;
  }
}
