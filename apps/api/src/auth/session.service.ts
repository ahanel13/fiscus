// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DbHandle, sessions, users } from '@fiscus/db';
import type { SessionSummary } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DB } from '../database/database.module.js';
import type { AuthContext } from './auth-context.js';
import { randomToken, sha256 } from './tokens.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class SessionService {
  now: () => Date = () => new Date();

  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** Creates a session and returns the opaque token for the cookie (only its hash is stored). */
  async create(userId: string, meta: ClientMeta): Promise<{ token: string; id: string }> {
    const token = randomToken();
    const now = this.now();
    const [row] = await this.db.db
      .insert(sessions)
      .values({
        userId,
        tokenHash: sha256(token),
        createdAt: now,
        lastSeenAt: now,
        reauthenticatedAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      })
      .returning({ id: sessions.id });
    return { token, id: row!.id };
  }

  async resolve(token: string): Promise<AuthContext | null> {
    const [row] = await this.db.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), isNull(users.disabledAt)))
      .limit(1);
    if (!row) return null;

    const now = this.now();
    const { session, user } = row;
    if (
      session.expiresAt <= now ||
      now.getTime() - session.lastSeenAt.getTime() > SESSION_IDLE_MS
    ) {
      await this.revoke(session.id);
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, session.id));
    }
    return {
      session: {
        id: session.id,
        expiresAt: session.expiresAt,
        reauthenticatedAt: session.reauthenticatedAt,
      },
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isInstanceAdmin: user.isInstanceAdmin,
      },
    };
  }

  async revoke(id: string): Promise<void> {
    await this.db.db.delete(sessions).where(eq(sessions.id, id));
  }

  /** Returns true when the session existed and belonged to the user. */
  async revokeOwned(userId: string, id: string): Promise<boolean> {
    const deleted = await this.db.db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      .returning({ id: sessions.id });
    return deleted.length > 0;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async markReauthenticated(id: string): Promise<void> {
    await this.db.db
      .update(sessions)
      .set({ reauthenticatedAt: this.now() })
      .where(eq(sessions.id, id));
  }

  async list(userId: string, currentId: string): Promise<SessionSummary[]> {
    const rows = await this.db.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.lastSeenAt));
    return rows.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.id === currentId,
    }));
  }
}
