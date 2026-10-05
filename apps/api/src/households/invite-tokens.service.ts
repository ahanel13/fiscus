// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DbHandle, type Executor, householdMembers, invites, users } from '@fiscus/db';
import type { CurrentUser, InvitePreview } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { MEMBER_COLORS } from '@fiscus/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword } from '../auth/password.js';
import { sha256 } from '../auth/tokens.js';
import { Problem } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DB } from '../database/database.module.js';
import { HouseholdScope } from './household-scope.js';

const invalidInvite = () =>
  new Problem(404, 'invalid_invite', 'This invite link is invalid, used, or expired');

interface FoundInvite {
  id: string;
  householdId: string;
  email: string;
  role: (typeof invites.$inferSelect)['role'];
  invitedByMemberId: string | null;
  householdName: string;
}

/**
 * Invite-token flows. The caller holds a token but isn't a member yet, so the invite must be found
 * across households: the token lookup is the one deliberately cross-household query (allow-listed
 * in architecture.test.ts; a SECURITY DEFINER function replaces it under row-level security, #19).
 * Everything after the lookup runs in the invite's household context.
 *
 * Until email delivery exists (M4), owners share the link themselves. The token travels in the URL
 * fragment and request bodies, never in paths, so it stays out of server and proxy logs.
 */
@Injectable()
export class InviteTokensService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly scope: HouseholdScope,
    private readonly audit: AuditService,
  ) {}

  /** What the invitee sees before accepting. Reveals nothing without a valid token. */
  async preview(token: string): Promise<InvitePreview> {
    const { invite, householdName } = await this.#find(token);
    return this.scope.asSystem(
      invite.householdId,
      { kind: 'anonymous', userId: null, memberId: null },
      async (tx) => {
        const [inviter] = invite.invitedByMemberId
          ? await tx
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
      },
    );
  }

  /** A signed-in user accepts; their account email must match the invite. */
  async accept(
    token: string,
    user: CurrentUser,
  ): Promise<{ householdId: string; memberId: string }> {
    const { invite } = await this.#find(token);
    if (invite.email !== user.email) {
      throw new Problem(
        403,
        'invite_email_mismatch',
        'This invite is for a different email address',
        `Sign in as ${invite.email} to accept it.`,
      );
    }
    return this.#join(invite, async () => user);
  }

  /**
   * Creates an account for the invited email and joins the household. Allowed even when
   * SIGNUP_MODE is invite_only (that's the point of an invite), but not when closed.
   */
  async signup(token: string, password: string, displayName: string): Promise<CurrentUser> {
    if (this.config.signupMode === 'closed') {
      throw new Problem(403, 'signup_closed', 'New accounts are disabled on this instance');
    }
    const { invite } = await this.#find(token);
    const passwordHash = await hashPassword(password);
    let created: CurrentUser | undefined;
    // Account creation and joining commit together: no account without its membership.
    await this.#join(invite, async (tx) => {
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
      return created;
    });
    await this.audit.record({
      actorKind: 'user',
      actorUserId: created!.id,
      action: 'auth.signup',
      targetType: 'user',
      targetId: created!.id,
      metadata: { via: 'invite' },
    });
    return created!;
  }

  /**
   * The one cross-household read: a SECURITY DEFINER function that returns at most the single live
   * invite matching the token hash (migration 0005), since row-level security hides invites from
   * anyone outside the household.
   */
  async #find(token: string): Promise<{ invite: FoundInvite; householdName: string }> {
    const result = await this.db.db.execute<{
      id: string;
      household_id: string;
      email: string;
      role: FoundInvite['role'];
      invited_by_member_id: string | null;
      household_name: string;
    }>(sql`SELECT * FROM fiscus_find_invite(${sha256(token)})`);
    const row = result.rows[0];
    if (!row) throw invalidInvite();
    const invite: FoundInvite = {
      id: row.id,
      householdId: row.household_id,
      email: row.email,
      role: row.role,
      invitedByMemberId: row.invited_by_member_id,
      householdName: row.household_name,
    };
    return { invite, householdName: invite.householdName };
  }

  /** Joins in the invite's household context, re-checking the invite under a row lock. */
  async #join(
    invite: FoundInvite,
    resolveUser: (tx: Executor) => Promise<CurrentUser>,
  ): Promise<{ householdId: string; memberId: string }> {
    let user: CurrentUser | undefined;
    const memberId = await this.scope.asSystem(
      invite.householdId,
      { kind: 'user', userId: null, memberId: null },
      async (tx, activity) => {
        const [fresh] = await tx
          .select()
          .from(invites)
          .where(
            and(
              eq(invites.id, invite.id),
              isNull(invites.acceptedAt),
              isNull(invites.revokedAt),
              gt(invites.expiresAt, new Date()),
            ),
          )
          .for('update');
        if (!fresh) throw invalidInvite();
        user = await resolveUser(tx);
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
        await activity.record({
          action: 'member.joined',
          targetType: 'household_member',
          targetId: member!.id,
          actorMemberId: member!.id,
          actorUserId: user.id,
          metadata: { inviteId: invite.id },
        });
        return member!.id;
      },
    );
    return { householdId: invite.householdId, memberId };
  }
}
