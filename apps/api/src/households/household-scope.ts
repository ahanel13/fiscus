// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import {
  appendActivity,
  auditEvents,
  type DbHandle,
  type Executor,
  systemContext,
  withContext,
} from '@fiscus/db';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB } from '../database/database.module.js';
import type { HouseholdContext } from './household-context.js';

type ActorKind = (typeof auditEvents.$inferInsert)['actorKind'];

export interface Actor {
  kind: ActorKind;
  userId: string | null;
  memberId: string | null;
}

export interface ActivityInput {
  action: string;
  targetType?: string;
  targetId?: string;
  /** IDs and field names only; values go in `changes`, which is encrypted. */
  metadata?: Record<string, unknown>;
  changes?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
  /** The account it concerns: members who can't see that account don't see the event. */
  accountId?: string;
  /** Household-visible by default (activity feed, HH-11/12). */
  visibleToHousehold?: boolean;
  /** Override the actor, e.g. a user who only becomes a member inside this transaction. */
  actorMemberId?: string;
  actorUserId?: string;
}

export class UnrecordedWriteError extends Error {
  constructor() {
    super('Household data was written without an activity record (ADR 0013)');
    this.name = 'UnrecordedWriteError';
  }
}

/** Records activity in the same transaction as the change it describes (ADR 0013 §1). */
export class HouseholdActivity {
  #count = 0;

  constructor(
    private readonly tx: Executor,
    private readonly householdId: string,
    private readonly actor: Actor,
    private readonly crypto: FieldCrypto,
  ) {}

  get count(): number {
    return this.#count;
  }

  async record(input: ActivityInput): Promise<void> {
    this.#count++;
    const { changes } = input;
    await appendActivity(
      this.tx,
      {
        actorKind: this.actor.kind,
        actorUserId: input.actorUserId ?? this.actor.userId,
        actorMemberId: input.actorMemberId ?? this.actor.memberId,
        householdId: this.householdId,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        accountId: input.accountId ?? null,
        visibleToHousehold: input.visibleToHousehold ?? true,
        metadata: input.metadata ?? {},
      },
      changes
        ? (rowId) =>
            this.crypto.encrypt(
              {
                householdId: this.householdId,
                table: 'audit_events',
                column: 'changes_enc',
                rowId,
              },
              JSON.stringify(changes),
            )
        : undefined,
    );
  }
}

/**
 * The only way household feature code reaches the database. Every query runs in a transaction
 * carrying the household context that row-level security enforces (#18/#19), and any transaction
 * that writes household data must record activity, or it rolls back (ADR 0013).
 * Enforced by architecture.test.ts.
 */
@Injectable()
export class HouseholdScope {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    private readonly crypto: FieldCrypto,
  ) {}

  run<T>(
    ctx: HouseholdContext,
    fn: (tx: Executor, activity: HouseholdActivity) => Promise<T>,
  ): Promise<T> {
    return withContext(
      this.db.db,
      { householdId: ctx.householdId, memberId: ctx.memberId, userId: ctx.userId, system: false },
      (tx) =>
        this.#guarded(
          tx,
          ctx.householdId,
          { kind: 'user', userId: ctx.userId, memberId: ctx.memberId },
          fn,
        ),
    );
  }

  /** For acting in a household before a membership exists (creating it, joining it). */
  asSystem<T>(
    householdId: string,
    actor: Actor,
    fn: (tx: Executor, activity: HouseholdActivity) => Promise<T>,
  ): Promise<T> {
    return withContext(this.db.db, systemContext(householdId), (tx) =>
      this.#guarded(tx, householdId, actor, fn),
    );
  }

  async #guarded<T>(
    tx: Executor,
    householdId: string,
    actor: Actor,
    fn: (tx: Executor, activity: HouseholdActivity) => Promise<T>,
  ): Promise<T> {
    const activity = new HouseholdActivity(tx, householdId, actor, this.crypto);
    const result = await fn(tx, activity);
    if (activity.count === 0 && (await rowsWritten(tx))) throw new UnrecordedWriteError();
    return result;
  }
}

/**
 * Whether this transaction changed any household row. A row trigger on every household table sets
 * a transaction-local flag (migration 0008), so row locks and no-op statements don't count.
 */
async function rowsWritten(tx: Executor): Promise<boolean> {
  const { rows } = await tx.execute<{ wrote: boolean }>(
    sql`SELECT coalesce(current_setting('fiscus.household_write', true), '') = 'on' AS wrote`,
  );
  return rows[0]?.wrote ?? false;
}
