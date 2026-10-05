import { householdMembers, households, HouseholdKeyStore } from '@fiscus/db';
import { planVersionedPatch } from '@fiscus/domain';
import type { CurrentUser, Household, updateHouseholdSchema } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { MEMBER_COLORS } from '@fiscus/shared';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from './household-context.js';
import { HouseholdScope } from './household-scope.js';

type HouseholdRow = typeof households.$inferSelect;
type HouseholdPatch = z.infer<typeof updateHouseholdSchema>;

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
  you: Pick<HouseholdContext, 'memberId' | 'role'>,
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
    you: { memberId: you.memberId, role: you.role },
  };
}

type HouseholdInput = Pick<
  HouseholdRow,
  | 'name'
  | 'baseCurrency'
  | 'timezone'
  | 'weekStart'
  | 'fiscalYearStartMonth'
  | 'dateBasis'
  | 'financeStyle'
> & { displayName?: string | undefined };

@Injectable()
export class HouseholdsService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly keys: HouseholdKeyStore,
  ) {}

  /**
   * Creates a household with the caller as owner and generates its data key, atomically. The id
   * is generated up front so the whole transaction already runs in the new household's context.
   */
  async create(user: CurrentUser, input: HouseholdInput): Promise<Household> {
    const { displayName, ...settings } = input;
    const id = uuidv7();
    const { household, member } = await this.scope.asSystem(
      id,
      { kind: 'user', userId: user.id, memberId: null },
      async (tx, activity) => {
        const [household] = await tx
          .insert(households)
          .values({ id, ...settings })
          .returning();
        const [member] = await tx
          .insert(householdMembers)
          .values({
            householdId: id,
            userId: user.id,
            role: 'owner',
            displayName: displayName ?? user.displayName,
            color: MEMBER_COLORS[0]!,
          })
          .returning();
        await this.keys.createForHousehold(id, tx);
        await activity.record({
          action: 'household.created',
          targetType: 'household',
          targetId: id,
          actorMemberId: member!.id,
        });
        return { household: household!, member: member! };
      },
    );
    return toHousehold(household, { memberId: member.id, role: 'owner' });
  }

  async get(ctx: HouseholdContext): Promise<Household> {
    const [row] = await this.scope.run(ctx, (tx) =>
      tx.select().from(households).where(eq(households.id, ctx.householdId)),
    );
    if (!row) throw problems.notFound();
    return toHousehold(row, ctx);
  }

  /** Field-level first-save-wins update (API conventions §8). */
  async update(
    ctx: HouseholdContext,
    baseVersion: number,
    patch: HouseholdPatch,
  ): Promise<Household> {
    const result = await this.scope.run(ctx, async (tx, activity) => {
      const [row] = await tx
        .select()
        .from(households)
        .where(eq(households.id, ctx.householdId))
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
          { conflicts: plan.conflicts, current: toHousehold(row, ctx) },
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
      const changed = Object.keys(plan.changes);
      await activity.record({
        action: 'household.updated',
        targetType: 'household',
        targetId: ctx.householdId,
        metadata: { fields: changed },
        changes: {
          before: Object.fromEntries(changed.map((k) => [k, current[k]])),
          after: plan.changes,
        },
      });
      return { row: updated!, changed };
    });
    return toHousehold(result.row, ctx);
  }
}
