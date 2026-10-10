// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DbHandle, serverInvites, users } from '@fiscus/db';
import type { CurrentUser, ServerInvite, ServerInvitePreview } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { Problem, problems } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DB } from '../database/database.module.js';
import { hashPassword } from './password.js';
import { randomToken, sha256 } from './tokens.js';

/** As long as a household invite (permissions HH-04): a week to act on it. */
const SERVER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const invalidInvite = () =>
  new Problem(404, 'invalid_invite', 'This invite link is invalid, used, or expired');

/**
 * Server invites (permissions ADM-08): an instance admin invites someone to make an account on
 * this server, even when signup is invite-only; they then create their own household. Instance-
 * level, like password resets: no household, so no household data is reachable through one. The
 * token is stored only as a hash and travels in the link's fragment, never a path or a log.
 */
@Injectable()
export class ServerInvitesService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async create(
    adminUserId: string,
    email: string,
    ip: string | null,
  ): Promise<{ invite: ServerInvite; url: string }> {
    const [existing] = await this.db.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) {
      throw new Problem(
        409,
        'account_exists',
        'They already have an account here',
        'They can sign in and create a household, or you can invite them into yours.',
      );
    }
    const token = randomToken();
    const expiresAt = new Date(Date.now() + SERVER_INVITE_TTL_MS);
    const [row] = await this.db.db
      .insert(serverInvites)
      .values({ email, tokenHash: sha256(token), invitedByUserId: adminUserId, expiresAt })
      .returning();
    await this.audit.record({
      actorKind: 'instance_admin',
      actorUserId: adminUserId,
      action: 'admin.server_invite_created',
      targetType: 'server_invite',
      targetId: row!.id,
      ip,
    });
    const url = new URL('/join', this.config.publicUrl);
    url.hash = `token=${token}`;
    const [admin] = await this.db.db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, adminUserId));
    return { invite: present(row!, admin?.name ?? null), url: url.toString() };
  }

  /** Pending: not accepted, cancelled, or expired. Newest first. */
  async list(): Promise<ServerInvite[]> {
    const rows = await this.db.db
      .select({ invite: serverInvites, name: users.displayName })
      .from(serverInvites)
      .leftJoin(users, eq(users.id, serverInvites.invitedByUserId))
      .where(
        and(
          isNull(serverInvites.acceptedAt),
          isNull(serverInvites.revokedAt),
          gt(serverInvites.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(serverInvites.createdAt));
    return rows.map((r) => present(r.invite, r.name));
  }

  async revoke(adminUserId: string, id: string, ip: string | null): Promise<void> {
    const [row] = await this.db.db
      .update(serverInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(serverInvites.id, id),
          isNull(serverInvites.acceptedAt),
          isNull(serverInvites.revokedAt),
        ),
      )
      .returning({ id: serverInvites.id });
    if (!row) throw problems.notFound();
    await this.audit.record({
      actorKind: 'instance_admin',
      actorUserId: adminUserId,
      action: 'admin.server_invite_revoked',
      targetType: 'server_invite',
      targetId: id,
      ip,
    });
  }

  /** What the invitee sees. Reveals nothing without a valid token. */
  async preview(token: string): Promise<ServerInvitePreview> {
    const invite = await this.#find(token);
    const [inviter] = invite.invitedByUserId
      ? await this.db.db
          .select({ name: users.displayName })
          .from(users)
          .where(eq(users.id, invite.invitedByUserId))
      : [];
    const [account] = await this.db.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invite.email));
    return { email: invite.email, invitedBy: inviter?.name ?? null, accountExists: !!account };
  }

  /**
   * Creates the invited account, for the invite's email. Allowed when signup is invite-only (the
   * point of an invite), not when it's closed. The invite is used up in the same transaction.
   */
  async join(
    token: string,
    password: string,
    displayName: string,
    ip: string | null,
  ): Promise<CurrentUser> {
    if (this.config.signupMode === 'closed') {
      throw new Problem(403, 'signup_closed', 'New accounts are disabled on this instance');
    }
    const passwordHash = await hashPassword(password);
    const user = await this.db.db.transaction(async (tx) => {
      const [invite] = await tx
        .update(serverInvites)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(serverInvites.tokenHash, sha256(token)),
            isNull(serverInvites.acceptedAt),
            isNull(serverInvites.revokedAt),
            gt(serverInvites.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!invite) throw invalidInvite();
      const [created] = await tx
        .insert(users)
        .values({ email: invite.email, displayName, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning();
      if (!created) {
        throw new Problem(
          409,
          'account_exists',
          'An account with this email already exists',
          'Sign in instead.',
        );
      }
      await tx
        .update(serverInvites)
        .set({ acceptedByUserId: created.id })
        .where(eq(serverInvites.id, invite.id));
      return created;
    });
    await this.audit.record({
      actorKind: 'user',
      actorUserId: user.id,
      action: 'auth.signup',
      targetType: 'user',
      targetId: user.id,
      metadata: { via: 'server_invite' },
      ip,
    });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isInstanceAdmin: user.isInstanceAdmin,
    };
  }

  async #find(token: string) {
    const [invite] = await this.db.db
      .select()
      .from(serverInvites)
      .where(
        and(
          eq(serverInvites.tokenHash, sha256(token)),
          isNull(serverInvites.acceptedAt),
          isNull(serverInvites.revokedAt),
          gt(serverInvites.expiresAt, new Date()),
        ),
      );
    if (!invite) throw invalidInvite();
    return invite;
  }
}

const present = (r: typeof serverInvites.$inferSelect, invitedBy: string | null): ServerInvite => ({
  id: r.id,
  email: r.email,
  invitedBy,
  expiresAt: r.expiresAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
});
