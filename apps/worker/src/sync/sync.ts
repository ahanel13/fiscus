// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto } from '@fiscus/crypto';
import {
  accounts,
  connections,
  type Database,
  type Executor,
  householdMembers,
  systemContext,
  withContext,
} from '@fiscus/db';
import {
  type AggregationProvider,
  isProviderError,
  type ProviderSecret,
  type SyncPage,
} from '@fiscus/domain';
import {
  type Actor,
  guardActivity,
  type HouseholdActivity,
  writeProviderLiabilities,
} from '@fiscus/ledger';
import { and, eq, isNotNull, min } from 'drizzle-orm';
import { FAILURE, JobFailure } from '../runner/jobs.js';
import { advanceConnection, applyPage, type PageResult, type SyncTarget } from './ingest.js';

// A sync (#80): pages from the provider, each applied in its own short transaction with the
// cursor it leads to, so the cursor only moves past what's committed and a failure part way
// keeps what came before it. Everything runs in the connection's household's system context.

/** Restarts after `mutation_during_pagination` before the sync fails with it. */
export const MAX_RESTARTS = 3;

export interface SyncState {
  ownerMemberId: string;
  /** The connection's owner has left the household: it isn't synced (D11). */
  ownerLeft: boolean;
  cursor: string | null;
  /** The earliest `sync_from` of its tracked accounts, for providers without a cursor (D6). */
  since: string | null;
}

export interface SyncDeps {
  db: Database;
  crypto: FieldCrypto;
}

/** Thrown inside a page's transaction when the connection was disconnected meanwhile. */
class SyncStopped extends Error {
  constructor() {
    super('Sync stopped: the connection was disconnected');
    this.name = 'SyncStopped';
  }
}

export interface SyncSummary extends Omit<PageResult, 'balances'> {
  pages: number;
  restarts: number;
  /** Disconnected meanwhile: what came before is kept, and nothing more is asked for. */
  stopped: boolean;
}

export async function readSyncState(
  deps: SyncDeps,
  target: Pick<SyncTarget, 'householdId' | 'connectionId'>,
): Promise<SyncState | null> {
  return withContext(deps.db, systemContext(target.householdId), async (tx) => {
    const [row] = await tx
      .select({
        ownerMemberId: connections.ownerMemberId,
        leftAt: householdMembers.leftAt,
        cursor: connections.syncCursor,
      })
      .from(connections)
      .innerJoin(householdMembers, eq(householdMembers.id, connections.ownerMemberId))
      .where(eq(connections.id, target.connectionId));
    if (!row) return null;
    const [since] = await tx
      .select({ since: min(accounts.syncFrom) })
      .from(accounts)
      .where(and(eq(accounts.connectionId, target.connectionId), isNotNull(accounts.syncFrom)));
    return {
      ownerMemberId: row.ownerMemberId,
      ownerLeft: row.leftAt !== null,
      cursor: row.cursor,
      since: since?.since ?? null,
    };
  });
}

/**
 * Syncs a connection: pages through `provider.sync` from its stored cursor, applying each. On
 * `mutation_during_pagination` it starts over from the cursor this run began with, up to
 * MAX_RESTARTS times: what was applied already is applied again, which changes nothing. Then the
 * card and loan details, when the provider has them. Provider errors are thrown for the runner.
 */
export async function syncConnection(
  deps: SyncDeps,
  provider: AggregationProvider,
  secret: ProviderSecret,
  target: SyncTarget,
  state: SyncState,
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    added: 0,
    matched: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    pages: 0,
    restarts: 0,
    stopped: false,
  };
  const actor: Actor = { kind: 'system', userId: null, memberId: target.ownerMemberId };
  const inHousehold = <T>(fn: (tx: Executor, activity: HouseholdActivity) => Promise<T>) =>
    withContext(deps.db, systemContext(target.householdId), (tx) =>
      guardActivity(tx, target.householdId, actor, deps.crypto, fn),
    );

  /** The cursor as committed: each page's transaction checks it's still the one it follows. */
  let committed = state.cursor;
  let cursor = state.cursor;
  for (;;) {
    let page: SyncPage;
    try {
      page = await provider.sync(secret, {
        cursor,
        ...(state.since !== null && { since: state.since }),
      });
    } catch (error) {
      if (
        isProviderError(error) &&
        error.kind === 'mutation_during_pagination' &&
        summary.restarts < MAX_RESTARTS
      ) {
        summary.restarts++;
        cursor = state.cursor;
        continue;
      }
      throw error;
    }
    try {
      const result = await inHousehold(async (tx, activity) => {
        const [now] = await tx
          .select({ status: connections.status, cursor: connections.syncCursor })
          .from(connections)
          .where(eq(connections.id, target.connectionId))
          .for('update');
        if (!now || (now.status !== 'ok' && now.status !== 'error')) {
          throw new SyncStopped();
        }
        // Another run moved it (a lease that ran out): this one stops rather than interleave.
        if (now.cursor !== committed) throw new JobFailure(FAILURE.syncConflict);
        const applied = await applyPage(tx, activity, target, page);
        await advanceConnection(tx, target.connectionId, page);
        // The page itself, as the system's bookkeeping: the cursor, the balances, and the counts.
        await activity.record({
          action: 'sync.page_applied',
          targetType: 'connection',
          targetId: target.connectionId,
          metadata: {
            mode: page.mode,
            ...applied,
            ...(page.historicalComplete && { historicalComplete: true }),
          },
          visibleToHousehold: false,
        });
        return applied;
      });
      summary.pages++;
      summary.added += result.added;
      summary.matched += result.matched;
      summary.updated += result.updated;
      summary.removed += result.removed;
      summary.skipped += result.skipped;
    } catch (error) {
      if (error instanceof SyncStopped) {
        summary.stopped = true;
        return summary;
      }
      throw error;
    }
    if (page.mode === 'delta' && page.nextCursor !== null) committed = page.nextCursor;
    if (page.mode === 'window' || !page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  if (provider.capabilities.liabilities && provider.liabilities) {
    const liabilities = await provider.liabilities(secret);
    if (liabilities.length) {
      await inHousehold(async (tx, activity) => {
        const written = await writeProviderLiabilities(tx, target.connectionId, liabilities);
        if (written.written) {
          await activity.record({
            action: 'sync.liabilities_updated',
            targetType: 'connection',
            targetId: target.connectionId,
            metadata: { ...written },
            visibleToHousehold: false,
          });
        }
      });
    }
  }
  return summary;
}
