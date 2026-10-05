import { householdMembers, invites, users } from '@fiscus/db';
import type { InviteSummary, MemberRole } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { randomToken, sha256 } from '../auth/tokens.js';
import { Problem, problems } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { HouseholdContext } from './household-context.js';
import { HouseholdScope } from './household-scope.js';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

type InviteRow = typeof invites.$inferSelect;
export const toInviteSummary = (i: InviteRow): InviteSummary => ({
  id: i.id,
  email: i.email,
  role: i.role,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
});

/** Owners managing their household's invites. Token-based flows live in InviteTokensService. */
@Injectable()
export class InvitesService {
  constructor(
    private readonly scope: HouseholdScope,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(ctx: HouseholdContext, email: string, role: MemberRole) {
    const token = randomToken();
    const invite = await this.scope.run(ctx, async (tx, activity) => {
      const [existing] = await tx
        .select({ id: householdMembers.id })
        .from(householdMembers)
        .innerJoin(users, eq(users.id, householdMembers.userId))
        .where(
          and(
            eq(householdMembers.householdId, ctx.householdId),
            eq(users.email, email),
            isNull(householdMembers.leftAt),
          ),
        );
      if (existing) throw new Problem(409, 'already_member', 'This person is already a member');
      const [invite] = await tx
        .insert(invites)
        .values({
          householdId: ctx.householdId,
          email,
          role,
          tokenHash: sha256(token),
          invitedByMemberId: ctx.memberId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        })
        .returning();
      await activity.record({
        action: 'invite.created',
        targetType: 'invite',
        targetId: invite!.id,
        metadata: { role },
        changes: { after: { email, role } },
      });
      return invite!;
    });
    const url = new URL('/invite', this.config.publicUrl);
    url.hash = `token=${token}`;
    return { invite: toInviteSummary(invite), url: url.toString() };
  }

  async listPending(ctx: HouseholdContext): Promise<InviteSummary[]> {
    const rows = await this.scope.run(ctx, (tx) =>
      tx
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.householdId, ctx.householdId),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
            gt(invites.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(invites.createdAt)),
    );
    return rows.map(toInviteSummary);
  }

  async revoke(ctx: HouseholdContext, inviteId: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const revoked = await tx
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invites.id, inviteId),
            eq(invites.householdId, ctx.householdId),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
          ),
        )
        .returning({ id: invites.id });
      if (revoked.length === 0) throw problems.notFound();
      await activity.record({ action: 'invite.revoked', targetType: 'invite', targetId: inviteId });
    });
  }
}
