// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DbHandle, passwordResetTokens, sessions, users } from '@fiscus/db';
import type { CurrentUser } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { Problem, problems } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DB } from '../database/database.module.js';
import { dummyPasswordHash, hashPassword, needsRehash, verifyPassword } from './password.js';
import { RateLimiter } from './rate-limiter.js';
import { type ClientMeta, SessionService } from './session.service.js';
import { randomToken, sha256 } from './tokens.js';

const LOGIN_LIMIT_PER_ACCOUNT = { limit: 10, windowMs: 15 * 60_000 };
const LOGIN_LIMIT_PER_IP = { limit: 30, windowMs: 15 * 60_000 };
const RESET_TOKEN_TTL_MS = 24 * 60 * 60_000;

const invalidCredentials = () =>
  new Problem(401, 'invalid_credentials', 'Email or password is incorrect');

type UserRow = typeof users.$inferSelect;
const toCurrentUser = (u: UserRow): CurrentUser => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  isInstanceAdmin: u.isInstanceAdmin,
});

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
  ) {}

  async signup(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<CurrentUser> {
    if (this.config.signupMode === 'closed') {
      throw new Problem(403, 'signup_closed', 'New accounts are disabled on this instance');
    }
    if (this.config.signupMode === 'invite_only') {
      throw new Problem(
        403,
        'signup_invite_required',
        'This instance is invite-only',
        'Ask a household owner for an invite link.',
      );
    }
    const passwordHash = await hashPassword(input.password);
    const [user] = await this.db.db
      .insert(users)
      .values({ email: input.email, displayName: input.displayName, passwordHash })
      .onConflictDoNothing({ target: users.email })
      .returning();
    if (!user) throw new Problem(409, 'email_taken', 'An account with this email already exists');
    await this.audit.record({
      actorKind: 'user',
      actorUserId: user.id,
      action: 'auth.signup',
      targetType: 'user',
      targetId: user.id,
    });
    return toCurrentUser(user);
  }

  /**
   * Verifies credentials with uniform failures: unknown email and wrong password produce the same
   * response and similar timing, and both count against the rate limits.
   */
  async login(email: string, password: string, meta: ClientMeta): Promise<CurrentUser> {
    this.#limit(`login:account:${email}`, LOGIN_LIMIT_PER_ACCOUNT);
    this.#limit(`login:ip:${meta.ip ?? 'unknown'}`, LOGIN_LIMIT_PER_IP);

    const [user] = await this.db.db.select().from(users).where(eq(users.email, email)).limit(1);
    const ok = await verifyPassword(user?.passwordHash ?? (await dummyPasswordHash()), password);
    if (!user || !user.passwordHash || !ok) {
      if (user) {
        await this.audit.record({
          actorKind: 'anonymous',
          action: 'auth.login_failed',
          targetType: 'user',
          targetId: user.id,
          ip: meta.ip,
        });
      }
      throw invalidCredentials();
    }
    if (user.disabledAt) throw new Problem(403, 'account_disabled', 'This account is disabled');

    this.limiter.reset(`login:account:${email}`);
    if (needsRehash(user.passwordHash)) {
      await this.db.db
        .update(users)
        .set({ passwordHash: await hashPassword(password) })
        .where(eq(users.id, user.id));
    }
    await this.audit.record({
      actorKind: 'user',
      actorUserId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      ip: meta.ip,
    });
    return toCurrentUser(user);
  }

  async reauthenticate(userId: string, sessionId: string, password: string, ip: string | null) {
    this.#limit(`reauth:${userId}`, LOGIN_LIMIT_PER_ACCOUNT);
    const [user] = await this.db.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw new Problem(401, 'invalid_credentials', 'Password is incorrect');
    }
    await this.sessions.markReauthenticated(sessionId);
    await this.audit.record({
      actorKind: 'user',
      actorUserId: userId,
      action: 'auth.reauthenticated',
      targetType: 'session',
      targetId: sessionId,
      ip,
    });
  }

  /** Instance-admin action (ADM-02): a single-use link valid for 24 hours. */
  async createPasswordResetLink(adminUserId: string, userId: string, ip: string | null) {
    const [user] = await this.db.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw problems.notFound();
    const token = randomToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await this.db.db.insert(passwordResetTokens).values({
      userId,
      tokenHash: sha256(token),
      createdByUserId: adminUserId,
      expiresAt,
    });
    await this.audit.record({
      actorKind: 'instance_admin',
      actorUserId: adminUserId,
      action: 'admin.user.password_reset_link_created',
      targetType: 'user',
      targetId: userId,
      ip,
    });
    // The token goes in the URL fragment, which browsers never send to servers or in Referer.
    const url = new URL('/reset-password', this.config.publicUrl);
    url.hash = `token=${token}`;
    return { url: url.toString(), expiresAt: expiresAt.toISOString() };
  }

  /** Sets a new password and signs the user out everywhere. */
  async resetPassword(token: string, password: string, ip: string | null): Promise<void> {
    const passwordHash = await hashPassword(password);
    const userId = await this.db.db.transaction(async (tx) => {
      const [row] = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, sha256(token)),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: passwordResetTokens.userId });
      if (!row) {
        throw new Problem(400, 'invalid_reset_token', 'This reset link is invalid or has expired');
      }
      await tx.update(users).set({ passwordHash }).where(eq(users.id, row.userId));
      await tx.delete(sessions).where(eq(sessions.userId, row.userId));
      return row.userId;
    });
    await this.audit.record({
      actorKind: 'user',
      actorUserId: userId,
      action: 'auth.password_reset',
      targetType: 'user',
      targetId: userId,
      ip,
    });
  }

  #limit(key: string, { limit, windowMs }: { limit: number; windowMs: number }): void {
    const result = this.limiter.consume(key, limit, windowMs);
    if (!result.allowed) throw problems.rateLimited(result.retryAfterSeconds);
  }
}
