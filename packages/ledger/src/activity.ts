// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto } from '@fiscus/crypto';
import { activityTransactions, appendActivity, auditEvents, type Executor } from '@fiscus/db';
import { sql } from 'drizzle-orm';

type ActorKind = (typeof auditEvents.$inferInsert)['actorKind'];

/** Who a change is recorded as: a person ('user'), or the instance itself ('system', e.g. sync). */
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
  /**
   * The transactions it touched, which makes it part of each one's history (#46). Every change to
   * a transaction passes them, bulk ones included.
   */
  transactionIds?: readonly string[];
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
    const { seq } = await appendActivity(
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
    const ids = [...new Set(input.transactionIds ?? [])];
    for (let i = 0; i < ids.length; i += LINK_CHUNK) {
      await this.tx.insert(activityTransactions).values(
        ids.slice(i, i + LINK_CHUNK).map((transactionId) => ({
          householdId: this.householdId,
          seq,
          transactionId,
        })),
      );
    }
  }
}

/** Links per statement: well under Postgres's 65 535 parameters at three a row. */
const LINK_CHUNK = 5000;

/**
 * The activity gate (ADR 0013): runs `fn` in the caller's household transaction with an activity
 * recorder for `actor`, and throws (rolling the transaction back) if it wrote household data
 * without recording any activity. The caller sets up the transaction and its household context.
 */
export async function guardActivity<T>(
  tx: Executor,
  householdId: string,
  actor: Actor,
  crypto: FieldCrypto,
  fn: (tx: Executor, activity: HouseholdActivity) => Promise<T>,
): Promise<T> {
  const activity = new HouseholdActivity(tx, householdId, actor, crypto);
  const result = await fn(tx, activity);
  if (activity.count === 0 && (await rowsWritten(tx))) throw new UnrecordedWriteError();
  return result;
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
