import { type DbHandle, householdMembers, households, HouseholdKeyStore } from '@fiscus/db';
import { planVersionedPatch } from '@fiscus/domain';
import type { CurrentUser, Household, Membership, updateHouseholdSchema } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Problem, problems } from '../common/problem.js';
import { DB } from '../database/database.module.js';
import type { Membership as Access } from './household-access.js';

type HouseholdRow = typeof households.$inferSelect;
type HouseholdPatch = z.infer<typeof updateHouseholdSchema>;

/** Distinct, readable colors assigned to members in join order (ADR 0006 viewer-relative UI). */
export const MEMBER_COLORS = [
  '#2563eb',
  '#db2777',
  '#16a34a',
  '#ea580c',
  '#7c3aed',
  '#0891b2',
  '#ca8a04',
  '#dc2626',
];

const SETTINGS = [
  'name',
  'baseCurrency',
  'timezone',
  'weekStart',
  'fiscalYearStartMonth',
  'dateBasis',
  'financeStyle',
] as const;

export function toHousehold(
  row: HouseholdRow,
  access: Pick<Access, 'memberId' | 'role'>,
): Household {
  return {
    id: row.id,
    name: row.name,
    baseCurrency: row.baseCurrency,
    timezone: row.timezone,
    weekStart: row.weekStart,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    dateBasis: row.dateBasis,
    financeStyle: row.financeStyle,
    status: row.status,
    version: row.version,
    you: { memberId: access.memberId, role: access.role },
  };
}

@Injectable()
export class HouseholdsService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    private readonly keys: HouseholdKeyStore,
    private readonly audit: AuditService,
  ) {}

  /** Creates a household with the caller as its owner and generates its data key atomically. */
  async create(
    user: CurrentUser,
    input: Omit<
      HouseholdRow,
      'id' | 'status' | 'version' | 'fieldVersions' | 'createdAt' | 'updatedAt'
    > & {
      displayName?: string | undefined;
    },
  ): Promise<Household> {
    const { displayName, ...settings } = input;
    const { household, member } = await this.db.db.transaction(async (tx) => {
      const [household] = await tx.insert(households).values(settings).returning();
      const [member] = await tx
        .insert(householdMembers)
        .values({
          householdId: household!.id,
          userId: user.id,
          role: 'owner',
          displayName: displayName ?? user.displayName,
          color: MEMBER_COLORS[0]!,
        })
        .returning();
      await this.keys.createForHousehold(household!.id, tx);
      return { household: household!, member: member! };
    });
    await this.audit.record({
      actorKind: 'user',
      actorUserId: user.id,
      actorMemberId: member.id,
      householdId: household.id,
      action: 'household.created',
      targetType: 'household',
      targetId: household.id,
      visibleToHousehold: true,
    });
    return toHousehold(household, { memberId: member.id, role: 'owner' });
  }

  async get(access: Access): Promise<Household> {
    const [row] = await this.db.db
      .select()
      .from(households)
      .where(eq(households.id, access.householdId));
    if (!row) throw problems.notFound();
    return toHousehold(row, access);
  }

  /** Field-level first-save-wins update (API conventions §8). */
  async update(
    access: Access,
    userId: string,
    baseVersion: number,
    patch: HouseholdPatch,
  ): Promise<Household> {
    const result = await this.db.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(households)
        .where(eq(households.id, access.householdId))
        .for('update');
      if (!row) throw problems.notFound();
      const current = Object.fromEntries(SETTINGS.map((k) => [k, row[k]]));
      const plan = planVersionedPatch(
        current,
        { version: row.version, fieldVersions: row.fieldVersions },
        baseVersion,
        patch,
      );
      if (!plan.ok) {
        throw new Problem(
          409,
          'edit_conflict',
          'Someone else changed this first',
          'Reload to see their changes, then apply yours again if still needed.',
          undefined,
          {},
          { conflicts: plan.conflicts, current: toHousehold(row, access) },
        );
      }
      if (Object.keys(plan.changes).length === 0) return { row, changed: [] as string[] };
      const [updated] = await tx
        .update(households)
        .set({
          ...plan.changes,
          version: plan.next.version,
          fieldVersions: plan.next.fieldVersions,
        })
        .where(and(eq(households.id, row.id), eq(households.version, row.version)))
        .returning();
      return { row: updated!, changed: Object.keys(plan.changes) };
    });
    if (result.changed.length > 0) {
      await this.audit.record({
        actorKind: 'user',
        actorUserId: userId,
        actorMemberId: access.memberId,
        householdId: access.householdId,
        action: 'household.updated',
        targetType: 'household',
        targetId: access.householdId,
        visibleToHousehold: true,
        metadata: { fields: result.changed },
      });
    }
    return toHousehold(result.row, access);
  }

  async memberships(userId: string): Promise<Membership[]> {
    const rows = await this.db.db
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
      .orderBy(sql`${householdMembers.joinedAt}`);
    return rows;
  }
}
