// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto, HouseholdFieldContext } from '@fiscus/crypto';
import {
  type Database,
  enqueueNotification,
  type Executor,
  type MemberMoveBalance,
  type MaintenanceSession,
  memberMoves,
  newId,
  startMaintenance,
} from '@fiscus/db';
import { matchCategories, moveRule, type MoveOutPlan } from '@fiscus/domain';
import { describeError } from '@fiscus/env';
import { HouseholdActivity, planMemberMoveOut, replaceOwners } from '@fiscus/ledger';
import { MEMBER_MOVE_STEPS } from '@fiscus/shared';
import { Logger } from '@nestjs/common';
import { appLink } from '../notify/rules/member.js';
import { eq, sql, type SQL } from 'drizzle-orm';

// Moving out (#253, ADR 0012 step 3 and §Mechanism, budgeting walkthrough D37). The api has made
// the new household and a `member_moves` row in it; this does the rest, as fiscus_maintenance
// (BYPASSRLS, the only way across households), one step per transaction:
//
// 1. plan: what moves, worked out as the preview did (@fiscus/domain planMoveOut), and kept with
//    the move, ids and all, so a restart moves exactly the same;
// 2. copy: the categories, groups and tags their data uses, into the new household, matched to its
//    own where they're the same;
// 3. move: their accounts and everything under them, their bank connections made with the
//    server's keys, their budget, goals and rules, with their ids. Encrypted values are decrypted
//    with the old household's key and encrypted with the new one's. One transaction: what points
//    from one row to another (a goal's claims on an account, a pay-down goal's debt) is never half
//    moved. Foreign keys are checked at its commit (migration 0122);
// 4. joint accounts stay, without them: their share passes to the other owners;
// 5. they leave the household (`left_at`), and both households' activity records it. The owners
//    are told.
//
// Each step records that it's done in the same transaction, so a crash carries on after the last
// one, and every write checks where its rows are, so no step does anything twice.

/** What the move works from, kept in `member_moves.plan`. */
export interface StoredPlan {
  fromHouseholdId: string;
  fromMemberId: string;
  householdId: string;
  memberId: string;
  userId: string;
  /** Today where they're leaving: joint accounts' owners change from today. */
  today: string;
  accounts: string[];
  connections: string[];
  relinkConnections: string[];
  joint: MoveOutPlan['jointAccounts'];
  budgetId: string | null;
  goals: string[];
  claimsEnding: MoveOutPlan['claimsEnding'];
  rules: string[];
  /** Old category id to the new household's, and the ones to copy (with their new group). */
  categories: Record<string, string>;
  copyCategories: { from: string; id: string; groupId: string }[];
  copyGroups: { from: string; id: string }[];
  tags: Record<string, string>;
}

export interface MemberMoveOptions {
  pollMs: number;
  leaseMs: number;
  now?: () => Date;
}

export const DEFAULT_MEMBER_MOVE_OPTIONS: MemberMoveOptions = { pollMs: 15_000, leaseMs: 600_000 };

/** A move that can't go ahead: recorded on it as its code. */
class MoveRefused extends Error {
  constructor(readonly code: string) {
    super(`Move refused: ${code}`);
  }
}

const uuids = (list: readonly string[]) =>
  list.length === 0
    ? sql`ARRAY[]::uuid[]`
    : sql`ARRAY[${sql.join(
        list.map((v) => sql`${v}`),
        sql`, `,
      )}]::uuid[]`;

const exec = (tx: Executor, query: SQL) => tx.execute(query);
const rows = async <T extends Record<string, unknown>>(tx: Executor, query: SQL) =>
  (await tx.execute<T>(query)).rows;

const todayIn = (timeZone: string, now: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(now);

const noteContext = (
  householdId: string,
  transactionId: string,
  author: string | null,
): HouseholdFieldContext => ({
  householdId,
  table: 'transaction_notes',
  column: 'body_enc',
  rowId: `${transactionId}:${author ?? 'shared'}`,
});
const accountContext = (
  householdId: string,
  accountId: string,
  column: 'notes_enc' | 'account_number_enc',
): HouseholdFieldContext => ({ householdId, table: 'accounts', column, rowId: accountId });
const secretContext = (householdId: string, connectionId: string): HouseholdFieldContext => ({
  householdId,
  table: 'connection_secrets',
  column: 'secret_enc',
  rowId: connectionId,
});

export class MemberMoves {
  readonly #db: Database;
  readonly #crypto: FieldCrypto;
  readonly #options: MemberMoveOptions;
  readonly #logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #stopped = true;

  constructor(
    db: Database,
    crypto: FieldCrypto,
    options: Partial<MemberMoveOptions> = {},
    logger?: Pick<Logger, 'log' | 'warn' | 'error'>,
  ) {
    this.#db = db;
    this.#crypto = crypto;
    this.#options = { ...DEFAULT_MEMBER_MOVE_OPTIONS, ...options };
    this.#logger = logger ?? new Logger('MemberMoves');
  }

  start(): void {
    this.#stopped = false;
    const tick = () => {
      if (this.#stopped) return;
      this.#running = this.pass()
        .then(() => undefined)
        .catch((error: unknown) => this.#logger.error(`Moves failed: ${describeError(error)}`))
        .finally(() => {
          this.#running = null;
          if (!this.#stopped) this.#timer = setTimeout(tick, this.#options.pollMs);
        });
    };
    this.#timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }

  /** Carries on with every move that's due. Returns how many it finished. */
  async pass(): Promise<number> {
    const { rows: due } = await this.#db.execute<{ move_id: string; household_id: string }>(
      sql`SELECT move_id, household_id FROM fiscus_claim_member_moves(5,
            ${`${Math.round(this.#options.leaseMs / 1000)} seconds`}::interval)`,
    );
    let done = 0;
    for (const { move_id: id } of due) {
      try {
        if (await this.run(id)) done++;
      } catch (error) {
        this.#logger.error(`Move ${id} stopped: ${describeError(error)}`);
      }
    }
    return done;
  }

  /** Runs one move's remaining steps. True once it's done. */
  async run(moveId: string, options: { stopAfter?: number } = {}): Promise<boolean> {
    const session = await startMaintenance(this.#db, {
      job: 'member-move',
      reason: 'a member moving out to a household of their own',
    });
    const move = await session.transaction(async (tx) => {
      const [m] = await tx.select().from(memberMoves).where(eq(memberMoves.id, moveId));
      return m;
    });
    if (!move || move.status === 'done' || move.status === 'failed') return false;
    let step = move.step;
    try {
      while (step < MEMBER_MOVE_STEPS) {
        if (options.stopAfter !== undefined && step >= options.stopAfter) return false;
        const next = step + 1;
        await session.transaction(async (tx) => {
          await exec(tx, sql`SET CONSTRAINTS ALL DEFERRED`);
          // The row decides: another worker that took over a lapsed lease may be further on.
          const [current] = await tx
            .select()
            .from(memberMoves)
            .where(eq(memberMoves.id, moveId))
            .for('update');
          if (!current || current.step !== step) throw new Error('The move changed under it');
          if (next === 1) {
            await this.#plan(tx, current);
          } else {
            const plan = current.plan as unknown as StoredPlan;
            if (next === 2) await this.#copy(tx, plan);
            if (next === 3) await this.#move(tx, plan);
            if (next === 4) await this.#joint(tx, plan);
            if (next === 5) await this.#leave(tx, plan, current.id, current.finalBalances);
          }
          await tx
            .update(memberMoves)
            .set({
              step: next,
              status: next === MEMBER_MOVE_STEPS ? 'done' : 'moving',
              finishedAt: next === MEMBER_MOVE_STEPS ? new Date() : null,
              leaseUntil: next === MEMBER_MOVE_STEPS ? null : current.leaseUntil,
              updatedAt: new Date(),
            })
            .where(eq(memberMoves.id, moveId));
        });
        step = next;
      }
      this.#logger.log(`Move ${moveId} done`);
      return true;
    } catch (error) {
      await this.#failed(session, moveId, step, error);
      throw error;
    }
  }

  /** Before anything moved, a refusal ends it; otherwise it's tried again later. */
  async #failed(session: MaintenanceSession, moveId: string, step: number, error: unknown) {
    const refused = error instanceof MoveRefused && step === 0 ? error.code : null;
    await session.transaction(async (tx) => {
      const [m] = await tx.select().from(memberMoves).where(eq(memberMoves.id, moveId));
      if (!m) return;
      const attempts = m.attempts + 1;
      await tx
        .update(memberMoves)
        .set(
          refused
            ? {
                status: 'failed',
                errorCode: refused,
                finishedAt: new Date(),
                leaseUntil: null,
                attempts,
              }
            : {
                attempts,
                // Backs off: a minute, then longer, up to an hour.
                leaseUntil: new Date(
                  Date.now() + Math.min(60, 2 ** Math.min(attempts - 1, 6)) * 60_000,
                ),
              },
        )
        .where(eq(memberMoves.id, moveId));
      if (refused) {
        await new HouseholdActivity(tx, m.householdId, this.#actor(m), this.#crypto).record({
          action: 'member_move.failed',
          targetType: 'member_move',
          targetId: m.id,
          metadata: { code: refused },
        });
      }
    });
  }

  #actor(m: { memberId: string }, userId: string | null = null) {
    return { kind: 'user' as const, userId, memberId: m.memberId };
  }

  /** Step 1: what moves, kept with the move. */
  async #plan(tx: Executor, move: typeof memberMoves.$inferSelect): Promise<void> {
    const [from] = await rows<{
      user_id: string | null;
      left_at: Date | null;
      status: string;
      timezone: string;
    }>(
      tx,
      sql`SELECT m.user_id, m.left_at, h.status, h.timezone FROM household_members m
          JOIN households h ON h.id = m.household_id
          WHERE m.id = ${move.fromMemberId} AND m.household_id = ${move.fromHouseholdId}
          FOR UPDATE OF m`,
    );
    const [to] = await rows<{ user_id: string | null }>(
      tx,
      sql`SELECT user_id FROM household_members
          WHERE id = ${move.memberId} AND household_id = ${move.householdId} AND left_at IS NULL`,
    );
    if (!from || from.left_at || from.status !== 'active') throw new MoveRefused('left');
    if (!to || !from.user_id || to.user_id !== from.user_id) throw new MoveRefused('not_theirs');
    const { plan } = await planMemberMoveOut(tx, move.fromHouseholdId, move.fromMemberId);
    if (plan.blockers.length > 0) throw new MoveRefused(plan.blockers[0]!);

    // The new household's own categories (its defaults) take the place of matching ones.
    const existing = await rows<{
      id: string;
      name: string;
      group_id: string;
      group_name: string;
      system_key: string | null;
    }>(
      tx,
      sql`SELECT c.id, c.name, c.group_id, g.name AS group_name, c.system_key
          FROM categories c JOIN category_groups g ON g.id = c.group_id
          WHERE c.household_id = ${move.householdId}`,
    );
    const matched = matchCategories(
      plan.categories,
      existing.map((c) => ({
        id: c.id,
        name: c.name,
        groupId: c.group_id,
        groupName: c.group_name,
        systemKey: c.system_key,
      })),
    );
    const categories: Record<string, string> = {};
    const copyCategories: StoredPlan['copyCategories'] = [];
    const copyGroups = new Map<string, string>();
    for (const c of plan.categories) {
      const m = matched.get(c.id)!;
      if (m.categoryId) {
        categories[c.id] = m.categoryId;
        continue;
      }
      let groupId = m.groupId;
      if (!groupId) {
        groupId = copyGroups.get(c.groupId) ?? newId();
        copyGroups.set(c.groupId, groupId);
      }
      const id = newId();
      categories[c.id] = id;
      copyCategories.push({ from: c.id, id, groupId });
    }
    const stored: StoredPlan = {
      fromHouseholdId: move.fromHouseholdId,
      fromMemberId: move.fromMemberId,
      householdId: move.householdId,
      memberId: move.memberId,
      userId: from.user_id,
      today: todayIn(from.timezone, new Date()),
      accounts: plan.accounts.map((a) => a.id),
      connections: plan.connections.filter((c) => c.outcome === 'moves').map((c) => c.id),
      relinkConnections: plan.connections.filter((c) => c.outcome === 'relink').map((c) => c.id),
      joint: plan.jointAccounts,
      budgetId: plan.budgetId,
      goals: plan.goals.map((g) => g.id),
      claimsEnding: plan.claimsEnding,
      rules: plan.rules.map((r) => r.id),
      categories,
      copyCategories,
      copyGroups: [...copyGroups].map(([groupFrom, id]) => ({ from: groupFrom, id })),
      tags: Object.fromEntries(plan.tags.map((t) => [t.id, newId()])),
    };
    await tx
      .update(memberMoves)
      .set({ plan: stored as unknown as Record<string, unknown> })
      .where(eq(memberMoves.id, move.id));
    await this.#record(tx, stored, 'new', {
      action: 'member_move.planned',
      targetType: 'member_move',
      targetId: move.id,
      metadata: {
        accounts: stored.accounts.length,
        connections: stored.connections.length,
        goals: stored.goals.length,
        rules: stored.rules.length,
      },
    });
  }

  /** Step 2: categories, their groups, and tags, into the new household. */
  async #copy(tx: Executor, p: StoredPlan): Promise<void> {
    for (const g of p.copyGroups) {
      await exec(
        tx,
        sql`INSERT INTO category_groups (id, household_id, name, kind, sort_order)
            SELECT ${g.id}, ${p.householdId}, name, kind, sort_order + 1000 FROM category_groups
            WHERE id = ${g.from} AND household_id = ${p.fromHouseholdId}
            ON CONFLICT (id) DO NOTHING`,
      );
    }
    for (const c of p.copyCategories) {
      await exec(
        tx,
        sql`INSERT INTO categories (id, household_id, group_id, name, icon, one_sided, archived_at,
                                    sort_order)
            SELECT ${c.id}, ${p.householdId}, ${c.groupId}, name, icon, one_sided, archived_at,
                   sort_order
            FROM categories WHERE id = ${c.from} AND household_id = ${p.fromHouseholdId}
            ON CONFLICT (id) DO NOTHING`,
      );
    }
    for (const [from, id] of Object.entries(p.tags)) {
      await exec(
        tx,
        sql`INSERT INTO tags (id, household_id, name, color)
            SELECT ${id}, ${p.householdId}, name, color FROM tags
            WHERE id = ${from} AND household_id = ${p.fromHouseholdId}
            ON CONFLICT (id) DO NOTHING`,
      );
    }
    await this.#record(tx, p, 'new', {
      action: 'member_move.copied',
      targetType: 'household',
      targetId: p.householdId,
      metadata: {
        categories: Object.keys(p.categories).length,
        copiedCategories: p.copyCategories.length,
        tags: Object.keys(p.tags).length,
      },
    });
  }

  /** Step 3: everything that's theirs, in one transaction. */
  async #move(tx: Executor, p: StoredPlan): Promise<void> {
    const H = p.fromHouseholdId;
    const N = p.householdId;
    const A = uuids(p.accounts);
    const catMap = JSON.stringify(p.categories);
    const tagMap = JSON.stringify(p.tags);
    const cat = (column: SQL) =>
      sql`CASE WHEN ${column} IS NULL THEN NULL ELSE (${catMap}::jsonb ->> ${column}::text)::uuid END`;

    // Bank connections: none mid-sync, so the worker's sync never writes under it.
    const busy = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM connections WHERE id = ANY (${uuids([...p.connections, ...p.relinkConnections])})
          AND household_id = ${H} AND lease_until > now() FOR UPDATE`,
    );
    if (busy.length > 0) throw new Error('A bank connection is syncing; trying again later');

    // Household-key connections can't change Plaid accounts (ADR 0008): ended here, as
    // disconnecting does (the worker then removes the Item and its secret); re-linked there.
    await exec(
      tx,
      sql`UPDATE connections SET status = 'disconnected', disconnect_requested = true,
            next_sync_at = now(), updated_at = now()
          WHERE id = ANY (${uuids(p.relinkConnections)}) AND household_id = ${H}`,
    );
    // Accounts that stay let go of a connection that moves (their bank login goes with them);
    // accounts that move let go of one that doesn't.
    await exec(
      tx,
      sql`UPDATE accounts SET connection_id = NULL, updated_at = now()
          WHERE household_id = ${H} AND (
            (connection_id = ANY (${uuids(p.connections)}) AND NOT (id = ANY (${A})))
            OR (connection_id = ANY (${uuids(p.relinkConnections)}))
            OR (id = ANY (${A}) AND connection_id IS NOT NULL
                AND NOT (connection_id = ANY (${uuids(p.connections)}))))`,
    );
    await exec(
      tx,
      sql`DELETE FROM sync_holds WHERE household_id = ${H} AND (
            (connection_id = ANY (${uuids(p.connections)}) AND NOT (account_id = ANY (${A})))
            OR (account_id = ANY (${A}) AND NOT (connection_id = ANY (${uuids(p.connections)}))))`,
    );
    for (const c of await rows<{ connection_id: string; secret_enc: Buffer }>(
      tx,
      sql`SELECT connection_id, secret_enc FROM connection_secrets
          WHERE connection_id = ANY (${uuids(p.connections)}) AND household_id = ${H}`,
    )) {
      const secret = await this.#crypto.decrypt(secretContext(H, c.connection_id), c.secret_enc);
      const secretEnc = await this.#crypto.encrypt(secretContext(N, c.connection_id), secret);
      await exec(
        tx,
        sql`UPDATE connection_secrets SET household_id = ${N}, secret_enc = ${secretEnc},
              updated_at = now()
            WHERE connection_id = ${c.connection_id}`,
      );
    }
    await exec(
      tx,
      sql`UPDATE connections SET household_id = ${N}, owner_member_id = ${p.memberId},
            replaces_connection_id = CASE WHEN replaces_connection_id = ANY (${uuids(p.connections)})
                                          THEN replaces_connection_id END,
            updated_at = now()
          WHERE id = ANY (${uuids(p.connections)}) AND household_id = ${H}`,
    );

    // What links the moving transactions to ones that stay: unlinked, on both sides.
    const moving = sql`SELECT id FROM transactions WHERE household_id = ${H} AND account_id = ANY (${A})`;
    await exec(
      tx,
      sql`WITH crossing AS (
            SELECT DISTINCT t.transfer_group_id AS g FROM transactions t
            WHERE t.household_id = ${H} AND t.account_id = ANY (${A}) AND t.transfer_group_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM transactions o WHERE o.transfer_group_id = t.transfer_group_id
                          AND NOT (o.account_id = ANY (${A})))
          )
          UPDATE transactions SET transfer_group_id = NULL, transfer_external = true, updated_at = now()
          WHERE transfer_group_id IN (SELECT g FROM crossing)`,
    );
    await exec(
      tx,
      sql`UPDATE transactions SET transfer_expected_account_id = NULL, transfer_expected_days = NULL
          WHERE household_id = ${H} AND transfer_expected_account_id IS NOT NULL AND (
            (account_id = ANY (${A}) AND NOT (transfer_expected_account_id = ANY (${A})))
            OR (NOT (account_id = ANY (${A})) AND transfer_expected_account_id = ANY (${A})))`,
    );
    // Imports: a transaction moved between accounts keeps the import it came from (TXN-12).
    await exec(
      tx,
      sql`UPDATE transactions SET import_batch_id = NULL
          WHERE household_id = ${H} AND import_batch_id IS NOT NULL
            AND (account_id = ANY (${A})) <> (import_batch_id IN (
              SELECT id FROM import_batches WHERE household_id = ${H} AND account_id = ANY (${A})))`,
    );
    await exec(
      tx,
      sql`UPDATE balance_snapshots SET import_batch_id = NULL
          WHERE household_id = ${H} AND import_batch_id IS NOT NULL
            AND (account_id = ANY (${A})) <> (import_batch_id IN (
              SELECT id FROM import_batches WHERE household_id = ${H} AND account_id = ANY (${A})))`,
    );
    // A settle-up paid with a transfer that moves stays, as paid another way: it's between members
    // of the household they leave.
    await exec(
      tx,
      sql`UPDATE settlements SET kind = 'paid', transaction_id = NULL
          WHERE household_id = ${H} AND transaction_id IN (${moving})`,
    );
    // Who a purchase is for: the new household has only them, and no attribution is the account's
    // owner. Flags on it are between members of the household they leave.
    await exec(
      tx,
      sql`DELETE FROM transaction_attributions WHERE household_id = ${H} AND transaction_id IN (${moving})`,
    );
    await exec(
      tx,
      sql`DELETE FROM attribution_flags WHERE household_id = ${H} AND transaction_id IN (${moving})`,
    );
    // Notes: the shared one and theirs move, re-encrypted. Someone else's private note goes.
    await exec(
      tx,
      sql`DELETE FROM transaction_notes WHERE household_id = ${H} AND transaction_id IN (${moving})
            AND author_member_id IS NOT NULL AND author_member_id <> ${p.fromMemberId}`,
    );
    for (const n of await rows<{
      id: string;
      transaction_id: string;
      author_member_id: string | null;
      body_enc: Buffer;
    }>(
      tx,
      sql`SELECT id, transaction_id, author_member_id, body_enc FROM transaction_notes
          WHERE household_id = ${H} AND transaction_id IN (${moving})`,
    )) {
      const author = n.author_member_id ? p.memberId : null;
      const body = await this.#crypto.decrypt(
        noteContext(H, n.transaction_id, n.author_member_id),
        n.body_enc,
      );
      const bodyEnc = await this.#crypto.encrypt(noteContext(N, n.transaction_id, author), body);
      await exec(
        tx,
        sql`UPDATE transaction_notes SET household_id = ${N}, author_member_id = ${author},
              updated_by_member_id = ${p.memberId}, body_enc = ${bodyEnc}
            WHERE id = ${n.id}`,
      );
    }
    await exec(
      tx,
      sql`UPDATE transaction_tags SET household_id = ${N},
            tag_id = (${tagMap}::jsonb ->> tag_id::text)::uuid
          WHERE household_id = ${H} AND transaction_id IN (${moving})`,
    );

    // Goals: claims that end are recorded on the goal, then go.
    for (const c of p.claimsEnding) {
      await exec(
        tx,
        sql`INSERT INTO goal_claim_events (id, household_id, goal_id, account_id, reason,
              amount_before_minor, percent_before_bps)
            SELECT ${newId()}, household_id, goal_id, account_id, 'ended', amount_minor, percent_bps
            FROM goal_claims WHERE goal_id = ${c.goalId} AND account_id = ${c.accountId}
              AND household_id = ${H}`,
      );
      await exec(
        tx,
        sql`DELETE FROM goal_claims WHERE goal_id = ${c.goalId} AND account_id = ${c.accountId}
            AND household_id = ${H}`,
      );
    }

    // The accounts, and what's under them.
    await exec(
      tx,
      sql`DELETE FROM account_owner_periods WHERE household_id = ${H} AND account_id = ANY (${A})`,
    );
    await exec(
      tx,
      sql`DELETE FROM account_owners WHERE household_id = ${H} AND account_id = ANY (${A})`,
    );
    await exec(
      tx,
      sql`INSERT INTO account_owners (account_id, member_id, household_id, share_bps)
          SELECT id, ${p.memberId}, ${N}, 10000 FROM unnest(${A}) AS id
          ON CONFLICT DO NOTHING`,
    );
    await exec(
      tx,
      sql`DELETE FROM account_placements WHERE household_id = ${H} AND account_id = ANY (${A})`,
    );
    await exec(
      tx,
      sql`DELETE FROM funding_targets WHERE household_id = ${H} AND account_id = ANY (${A})`,
    );
    for (const table of ['balance_snapshots', 'account_liabilities', 'sync_holds']) {
      await exec(
        tx,
        sql`UPDATE ${sql.identifier(table)} SET household_id = ${N}
            WHERE household_id = ${H} AND account_id = ANY (${A})`,
      );
    }
    await exec(
      tx,
      sql`UPDATE recurring_series SET household_id = ${N}, created_by_member_id = ${p.memberId},
            responsible_member_id = NULL
          WHERE household_id = ${H} AND account_id = ANY (${A})`,
    );
    await exec(
      tx,
      sql`UPDATE recurring_marks SET household_id = ${N}, created_by_member_id = ${p.memberId}
          WHERE household_id = ${H} AND series_id IN (
            SELECT id FROM recurring_series WHERE household_id = ${N} AND account_id = ANY (${A}))`,
    );
    await exec(
      tx,
      sql`UPDATE recurring_dismissals SET household_id = ${N}, created_by_member_id = ${p.memberId}
          WHERE household_id = ${H} AND account_id = ANY (${A})`,
    );
    await exec(
      tx,
      sql`UPDATE import_batches SET household_id = ${N}, member_id = ${p.memberId}, profile_id = NULL,
            reverted_by_member_id = CASE WHEN reverted_by_member_id IS NULL THEN NULL ELSE ${p.memberId}::uuid END
          WHERE household_id = ${H} AND account_id = ANY (${A})`,
    );
    await exec(
      tx,
      sql`UPDATE transactions SET household_id = ${N}, category_id = ${cat(sql`category_id`)},
            transfer_previous_category_id = ${cat(sql`transfer_previous_category_id`)}
          WHERE household_id = ${H} AND account_id = ANY (${A})`,
    );
    for (const a of await rows<{
      id: string;
      notes_enc: Buffer | null;
      account_number_enc: Buffer | null;
    }>(
      tx,
      sql`SELECT id, notes_enc, account_number_enc FROM accounts
          WHERE household_id = ${H} AND id = ANY (${A})`,
    )) {
      const again = async (column: 'notes_enc' | 'account_number_enc', value: Buffer | null) =>
        value
          ? this.#crypto.encrypt(
              accountContext(N, a.id, column),
              await this.#crypto.decrypt(accountContext(H, a.id, column), value),
            )
          : null;
      await exec(
        tx,
        sql`UPDATE accounts SET household_id = ${N}, reviewer_member_id = NULL,
              notes_enc = ${await again('notes_enc', a.notes_enc)},
              account_number_enc = ${await again('account_number_enc', a.account_number_enc)},
              updated_at = now()
            WHERE id = ${a.id}`,
      );
      // Not tied to the account: it's in the other household now, so nobody here could see the
      // event, the worker's own checks of the chain included. Nor is it in the feed.
      await this.#record(tx, p, 'old', {
        action: 'account.moved_out',
        targetType: 'account',
        targetId: a.id,
        visibleToHousehold: false,
      });
      await this.#record(tx, p, 'new', {
        action: 'account.moved_in',
        targetType: 'account',
        targetId: a.id,
        accountId: a.id,
      });
    }

    // Their budget (Mine).
    if (p.budgetId) {
      const B = p.budgetId;
      await exec(
        tx,
        sql`UPDATE budgets SET household_id = ${N}, member_id = ${p.memberId}
            WHERE id = ${B} AND household_id = ${H}`,
      );
      await exec(
        tx,
        sql`UPDATE budget_strategies SET household_id = ${N} WHERE budget_id = ${B} AND household_id = ${H}`,
      );
      await exec(
        tx,
        sql`UPDATE budget_amounts SET household_id = ${N}, category_id = ${cat(sql`category_id`)}
            WHERE budget_id = ${B} AND household_id = ${H}`,
      );
      await exec(
        tx,
        sql`UPDATE budget_categories SET household_id = ${N}, category_id = ${cat(sql`category_id`)}
            WHERE budget_id = ${B} AND household_id = ${H}`,
      );
      // Moves to or from a goal that stays go: the line isn't in this budget any more.
      await exec(
        tx,
        sql`DELETE FROM budget_moves WHERE budget_id = ${B} AND household_id = ${H} AND (
              (from_goal_id IS NOT NULL AND NOT (from_goal_id = ANY (${uuids(p.goals)})))
              OR (to_goal_id IS NOT NULL AND NOT (to_goal_id = ANY (${uuids(p.goals)}))))`,
      );
      await exec(
        tx,
        sql`UPDATE budget_moves SET household_id = ${N},
              from_category_id = ${cat(sql`from_category_id`)}, to_category_id = ${cat(sql`to_category_id`)}
            WHERE budget_id = ${B} AND household_id = ${H}`,
      );
      // A template's amounts are by category id.
      await exec(
        tx,
        sql`UPDATE budget_templates SET household_id = ${N}, amounts = coalesce((
              SELECT jsonb_object_agg(${catMap}::jsonb ->> k, v) FROM jsonb_each(amounts) AS e(k, v)
              WHERE ${catMap}::jsonb ? k), '{}'::jsonb)
            WHERE budget_id = ${B} AND household_id = ${H}`,
      );
      await this.#record(tx, p, 'new', {
        action: 'budget.moved_in',
        targetType: 'budget',
        targetId: B,
      });
    }

    // Their goals, and the household's pay-down goals on a debt that moved: theirs now.
    const G = uuids(p.goals);
    await exec(
      tx,
      sql`UPDATE goals SET household_id = ${N}, member_id = ${p.memberId}
          WHERE id = ANY (${G}) AND household_id = ${H}`,
    );
    for (const table of ['goal_claims', 'goal_plans']) {
      await exec(
        tx,
        sql`UPDATE ${sql.identifier(table)} SET household_id = ${N}
            WHERE goal_id = ANY (${G}) AND household_id = ${H}`,
      );
    }
    await exec(
      tx,
      sql`UPDATE goal_claim_events SET household_id = ${N},
            member_id = CASE WHEN member_id IS NULL THEN NULL ELSE ${p.memberId}::uuid END
          WHERE goal_id = ANY (${G}) AND household_id = ${H}`,
    );

    // Their rules, as they apply in the new household.
    const ruleRows = await rows<{
      id: string;
      conditions: Record<string, unknown>;
      actions: Record<string, unknown>;
    }>(
      tx,
      sql`SELECT id, conditions, actions FROM rules
          WHERE id = ANY (${uuids(p.rules)}) AND household_id = ${H}`,
    );
    const maps = {
      accounts: new Set(p.accounts),
      categories: new Map(Object.entries(p.categories)),
      tags: new Map(Object.entries(p.tags)),
    };
    for (const r of ruleRows) {
      const moved = moveRule(r, maps);
      if (!moved) continue;
      await exec(
        tx,
        sql`UPDATE rules SET household_id = ${N}, member_id = ${p.memberId},
              author_member_id = ${p.memberId},
              conditions = ${JSON.stringify(moved.conditions)}::jsonb,
              actions = ${JSON.stringify(moved.actions)}::jsonb
            WHERE id = ${r.id}`,
      );
    }
    await this.#record(tx, p, 'new', {
      action: 'member_move.moved',
      targetType: 'household',
      targetId: N,
      metadata: {
        accounts: p.accounts.length,
        connections: p.connections.length,
        goals: p.goals.length,
        rules: ruleRows.length,
      },
    });
  }

  /** Step 4: joint accounts stay, and their share goes to the other owners, from today. */
  async #joint(tx: Executor, p: StoredPlan): Promise<void> {
    const H = p.fromHouseholdId;
    for (const a of p.joint) {
      const before = await rows<{ member_id: string; share_bps: number }>(
        tx,
        sql`SELECT member_id, share_bps FROM account_owners WHERE account_id = ${a.id} AND household_id = ${H}`,
      );
      if (!before.some((o) => o.member_id === p.fromMemberId)) continue;
      await replaceOwners(tx, {
        householdId: H,
        accountId: a.id,
        before: before.map((o) => ({ memberId: o.member_id, shareBps: o.share_bps })),
        after: a.owners,
        from: 'today',
        today: p.today,
      });
      // What they'd agreed to put in, and their own arrangement of it, go with them.
      await exec(
        tx,
        sql`DELETE FROM funding_targets WHERE account_id = ${a.id} AND member_id = ${p.fromMemberId}`,
      );
      await this.#record(tx, p, 'old', {
        action: 'account.owners_changed',
        targetType: 'account',
        targetId: a.id,
        accountId: a.id,
        metadata: { reason: 'member_moved_out' },
        changes: {
          before: { owners: before.map((o) => ({ memberId: o.member_id, shareBps: o.share_bps })) },
          after: { owners: a.owners },
        },
      });
    }
    if (p.joint.length === 0) {
      await this.#record(tx, p, 'new', {
        action: 'member_move.joint_accounts',
        targetType: 'household',
        targetId: p.householdId,
        metadata: { accounts: 0 },
      });
    }
  }

  /** Step 5: they leave, both households record it, and the owners are told. */
  async #leave(
    tx: Executor,
    p: StoredPlan,
    moveId: string,
    balances: MemberMoveBalance[],
  ): Promise<void> {
    const H = p.fromHouseholdId;
    const changes = { after: { finalSettleUp: balances } };
    await this.#record(tx, p, 'old', {
      action: 'member.moved_out',
      targetType: 'household_member',
      targetId: p.fromMemberId,
      metadata: { accounts: p.accounts.length, jointAccounts: p.joint.length },
      changes,
    });
    await exec(
      tx,
      sql`UPDATE household_members SET left_at = now() WHERE id = ${p.fromMemberId} AND household_id = ${H}
            AND left_at IS NULL`,
    );
    await this.#record(tx, p, 'new', {
      action: 'member_move.done',
      targetType: 'member_move',
      targetId: moveId,
      changes,
    });
    const [who] = await rows<{ display_name: string; name: string }>(
      tx,
      sql`SELECT m.display_name, h.name FROM household_members m JOIN households h ON h.id = m.household_id
          WHERE m.id = ${p.fromMemberId}`,
    );
    const owners = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM household_members WHERE household_id = ${H} AND role = 'owner'
            AND left_at IS NULL AND user_id IS NOT NULL`,
    );
    const name = who?.display_name ?? 'A member';
    for (const o of owners) {
      await enqueueNotification(tx, {
        householdId: H,
        memberId: o.id,
        kind: 'member_moved_out',
        dedupeKey: `member_moved_out:${moveId}`,
        title: `${name} moved out of ${who?.name ?? 'your household'}`,
        body: `${name} moved to a household of their own and took the accounts they owned alone. Joint accounts stay, with their share passed to the other owners. It’s in the household’s activity.`,
        summary: 'Someone moved out of your household.',
        link: appLink(H, 'settings/members'),
      });
    }
  }

  /** Records activity in the household left (`old`) or the new one, as the person moving. */
  async #record(
    tx: Executor,
    p: StoredPlan,
    where: 'old' | 'new',
    input: Parameters<HouseholdActivity['record']>[0],
  ): Promise<void> {
    const householdId = where === 'old' ? p.fromHouseholdId : p.householdId;
    const memberId = where === 'old' ? p.fromMemberId : p.memberId;
    await new HouseholdActivity(
      tx,
      householdId,
      { kind: 'user', userId: p.userId, memberId },
      this.#crypto,
    ).record(input);
  }
}
