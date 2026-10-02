import {
  type DbHandle,
  type Executor,
  householdMembers,
  households,
  invites,
  users,
} from '@fiscus/db';
import type { CurrentUser, InvitePreview, InviteSummary, MemberRole } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword } from '../auth/password.js';
import { randomToken, sha256 } from '../auth/tokens.js';
import { Problem, problems } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DB } from '../database/database.module.js';
import type { Membership } from './household-access.js';
import { MEMBER_COLORS } from './households.service.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

const invalidInvite = () =>
  new Problem(404, 'invalid_invite', 'This invite link is invalid, used, or expired');

type InviteRow = typeof invites.$inferSelect;
const toSummary = (i: InviteRow): InviteSummary => ({
  id: i.id,
  email: i.email,
  role: i.role,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
});

/**
 * Household invites (ADR 0005). Until email delivery exists (M4), the owner shares the link
 * themselves. The token travels in the URL fragment and request bodies, never in paths, so it
 * stays out of server and proxy logs.
 */
@Injectable()
export class InvitesService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async create(access: Membership, userId: string, email: string, role: MemberRole) {
    const [existing] = await this.db.db
      .select({ id: householdMembers.id })
      .from(householdMembers)
      .innerJoin(users, eq(users.id, householdMembers.userId))
      .where(
        and(
          eq(householdMembers.householdId, access.householdId),
          eq(users.email, email),
          isNull(householdMembers.leftAt),
        ),
      );
    if (existing) throw new Problem(409, 'already_member', 'This person is already a member');

    const token = randomToken();
    const [invite] = await this.db.db
      .insert(invites)
      .values({
        householdId: access.householdId,
        email,
        role,
        tokenHash: sha256(token),
        invitedByMemberId: access.memberId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    await this.audit.record({
      actorKind: 'user',
      actorUserId: userId,
      actorMemberId: access.memberId,
      householdId: access.householdId,
      action: 'invite.created',
      targetType: 'invite',
      targetId: invite!.id,
      visibleToHousehold: true,
      metadata: { role },
    });
    const url = new URL('/invite', this.config.publicUrl);
    url.hash = `token=${token}`;
    return { invite: toSummary(invite!), url: url.toString() };
  }

  async listPending(access: Membership): Promise<InviteSummary[]> {
    const rows = await this.db.db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.householdId, access.householdId),
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(invites.createdAt));
    return rows.map(toSummary);
  }

  async revoke(access: Membership, userId: string, inviteId: string): Promise<void> {
    const revoked = await this.db.db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invites.id, inviteId),
          eq(invites.householdId, access.householdId),
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt),
        ),
      )
      .returning({ id: invites.id });
    if (revoked.length === 0) throw problems.notFound();
    await this.audit.record({
      actorKind: 'user',
      actorUserId: userId,
      actorMemberId: access.memberId,
      householdId: access.householdId,
      action: 'invite.revoked',
      targetType: 'invite',
      targetId: inviteId,
      visibleToHousehold: true,
    });
  }

  /** What the invitee sees before accepting. Reveals nothing without a valid token. */
  async preview(token: string): Promise<InvitePreview> {
    const { invite, householdName } = await this.#find(this.db.db, token);
    const [inviter] = invite.invitedByMemberId
      ? await this.db.db
          .select({ name: householdMembers.displayName })
          .from(householdMembers)
          .where(eq(householdMembers.id, invite.invitedByMemberId))
      : [];
    const [account] = await this.db.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invite.email));
    return {
      householdName,
      invitedBy: inviter?.name ?? null,
      email: invite.email,
      role: invite.role,
      accountExists: Boolean(account),
    };
  }

  /** A signed-in user accepts; their account email must match the invite. */
  async accept(
    token: string,
    user: CurrentUser,
  ): Promise<{ householdId: string; memberId: string }> {
    return this.#join(token, async (tx, invite) => {
      if (invite.email !== user.email) {
        throw new Problem(
          403,
          'invite_email_mismatch',
          'This invite is for a different email address',
          `Sign in as ${invite.email} to accept it.`,
        );
      }
      return user;
    });
  }

  /**
   * Creates an account for the invited email and joins the household in one step. Allowed even
   * when SIGNUP_MODE is invite_only (that's the point of an invite), but not when closed.
   */
  async signup(token: string, password: string, displayName: string): Promise<CurrentUser> {
    if (this.config.signupMode === 'closed') {
      throw new Problem(403, 'signup_closed', 'New accounts are disabled on this instance');
    }
    const passwordHash = await hashPassword(password);
    let created: CurrentUser | undefined;
    await this.#join(token, async (tx, invite) => {
      const [user] = await tx
        .insert(users)
        .values({ email: invite.email, displayName, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning();
      if (!user) {
        throw new Problem(
          409,
          'account_exists',
          'An account with this email already exists',
          'Sign in, then accept the invite.',
        );
      }
      created = {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isInstanceAdmin: user.isInstanceAdmin,
      };
      await this.audit.record({
        actorKind: 'user',
        actorUserId: user.id,
        action: 'auth.signup',
        targetType: 'user',
        targetId: user.id,
        metadata: { via: 'invite' },
      });
      return created;
    });
    return created!;
  }

  async #find(tx: Executor, token: string, lock = false) {
    const query = tx
      .select({ invite: invites, householdName: households.name })
      .from(invites)
      .innerJoin(households, eq(households.id, invites.householdId))
      .where(
        and(
          eq(invites.tokenHash, sha256(token)),
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, new Date()),
          eq(households.status, 'active'),
        ),
      );
    const [row] = lock ? await query.for('update', { of: invites }) : await query;
    if (!row) throw invalidInvite();
    return row;
  }

  async #join(
    token: string,
    resolveUser: (tx: Executor, invite: InviteRow) => Promise<CurrentUser>,
  ): Promise<{ householdId: string; memberId: string }> {
    const result = await this.db.db.transaction(async (tx) => {
      const { invite } = await this.#find(tx, token, true);
      const user = await resolveUser(tx, invite);
      const [already] = await tx
        .select({ id: householdMembers.id })
        .from(householdMembers)
        .where(
          and(
            eq(householdMembers.householdId, invite.householdId),
            eq(householdMembers.userId, user.id),
            isNull(householdMembers.leftAt),
          ),
        );
      if (already) throw new Problem(409, 'already_member', 'You are already a member');

      const used = await tx
        .select({ color: householdMembers.color })
        .from(householdMembers)
        .where(
          and(
            eq(householdMembers.householdId, invite.householdId),
            isNull(householdMembers.leftAt),
          ),
        );
      const taken = new Set(used.map((u) => u.color));
      const color =
        MEMBER_COLORS.find((c) => !taken.has(c)) ??
        MEMBER_COLORS[used.length % MEMBER_COLORS.length]!;

      const [member] = await tx
        .insert(householdMembers)
        .values({
          householdId: invite.householdId,
          userId: user.id,
          role: invite.role,
          displayName: user.displayName,
          color,
        })
        .returning({ id: householdMembers.id });
      await tx
        .update(invites)
        .set({ acceptedAt: new Date(), acceptedByUserId: user.id })
        .where(eq(invites.id, invite.id));
      return {
        householdId: invite.householdId,
        memberId: member!.id,
        userId: user.id,
        inviteId: invite.id,
      };
    });
    await this.audit.record({
      actorKind: 'user',
      actorUserId: result.userId,
      actorMemberId: result.memberId,
      householdId: result.householdId,
      action: 'member.joined',
      targetType: 'household_member',
      targetId: result.memberId,
      visibleToHousehold: true,
      metadata: { inviteId: result.inviteId },
    });
    return { householdId: result.householdId, memberId: result.memberId };
  }
}
