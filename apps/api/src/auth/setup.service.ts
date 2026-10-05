// SPDX-License-Identifier: AGPL-3.0-or-later
import { timingSafeEqual } from 'node:crypto';
import { type DbHandle, instanceSetup, users } from '@fiscus/db';
import type { CurrentUser } from '@fiscus/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { count, sql } from 'drizzle-orm';
import { Problem } from '../common/problem.js';
import { DB } from '../database/database.module.js';
import { hashPassword } from './password.js';
import { randomToken, sha256 } from './tokens.js';

// Serializes concurrent setup attempts (two browsers racing to claim the instance).
const SETUP_LOCK = 4_217_002;
const RETRY_MS = 5_000;

/**
 * First-run setup. On an instance with no users, the api logs a one-time token; whoever has
 * access to the server logs uses it to create the first (instance-admin) account. Without it, the
 * first visitor to a freshly exposed instance could claim it.
 */
@Injectable()
export class SetupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Setup');
  #retry: NodeJS.Timeout | undefined;

  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** Never blocks startup: if the database isn't reachable yet, keeps retrying in the background. */
  onApplicationBootstrap(): void {
    void this.#announceIfRequired();
  }

  onApplicationShutdown(): void {
    clearTimeout(this.#retry);
  }

  async #announceIfRequired(): Promise<void> {
    try {
      if (!(await this.isSetupRequired())) return;
      const token = await this.issueToken();
      this.logger.warn(
        `First-run setup: open the app and use this one-time setup token: ${token} ` +
          '(a new token is issued on every restart until setup completes)',
      );
    } catch {
      this.logger.warn(
        `Database unavailable; checking first-run setup again in ${RETRY_MS / 1000}s`,
      );
      this.#retry = setTimeout(() => void this.#announceIfRequired(), RETRY_MS);
      this.#retry.unref();
    }
  }

  async isSetupRequired(): Promise<boolean> {
    const [row] = await this.db.db.select({ n: count() }).from(users);
    return (row?.n ?? 0) === 0;
  }

  /** Replaces any previous token. Exposed for tests and the startup log. */
  async issueToken(): Promise<string> {
    const token = randomToken();
    await this.db.db
      .insert(instanceSetup)
      .values({ id: 1, tokenHash: sha256(token) })
      .onConflictDoUpdate({
        target: instanceSetup.id,
        set: { tokenHash: sha256(token), createdAt: new Date() },
      });
    return token;
  }

  async complete(
    token: string,
    input: { email: string; password: string; displayName: string },
  ): Promise<CurrentUser> {
    const passwordHash = await hashPassword(input.password);
    return this.db.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK})`);
      const [existing] = await tx.select({ n: count() }).from(users);
      if ((existing?.n ?? 0) > 0) {
        throw new Problem(409, 'setup_complete', 'This instance is already set up');
      }
      const [row] = await tx.select().from(instanceSetup).limit(1);
      const given = sha256(token);
      if (!row || !timingSafeEqual(row.tokenHash, given)) {
        throw new Problem(403, 'invalid_setup_token', 'The setup token is not valid');
      }
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          displayName: input.displayName,
          passwordHash,
          isInstanceAdmin: true,
        })
        .returning();
      await tx.delete(instanceSetup);
      return {
        id: user!.id,
        email: user!.email,
        displayName: user!.displayName,
        isInstanceAdmin: true,
      };
    });
  }
}
