// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto } from '@fiscus/crypto';
import {
  accounts,
  connections,
  type Database,
  type Executor,
  householdMembers,
  households,
  systemContext,
  transactions,
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
import { and, eq, isNotNull, max, min, sql } from 'drizzle-orm';
import { FAILURE, JobFailure } from '../runner/jobs.js';
import {
  advanceConnection,
  applyPage,
  mergePages,
  type PageResult,
  type SyncTarget,
} from './ingest.js';

// A sync (#80, #88): every page the provider has, fetched first and held in memory, then applied
// together in one transaction that also stores the cursor they lead to. A cursor stored part way
// through would skip what the rest of the pages say on the next run, and a pending transaction's
// removal and its posted version can come on different pages: they're reconciled together. A
// failure anywhere writes nothing, and the next run starts from the same cursor. Everything runs
// in the connection's household's system context.

/** Restarts after `mutation_during_pagination` before the sync fails with it. */
export const MAX_RESTARTS = 3;

export interface SyncState {
  ownerMemberId: string;
  /** The connection's owner has left the household: it isn't synced (D11). */
  ownerLeft: boolean;
  cursor: string | null;
  /** The earliest `sync_from` of its tracked accounts, for providers without a cursor (D6). */
  since: string | null;
  /**
   * The latest date of a transaction the provider sent for its accounts. A provider without a
   * cursor asks again from a fortnight before it, not the whole history every time (#91).
   */
  lastProviderDate: string | null;
  /** The household's time zone: providers reporting instants date transactions in it (#91). */
  timeZone: string;
}

/** How far before its latest transaction a provider without a cursor asks again (#91). */
export const WINDOW_OVERLAP_DAYS = 14;

/** Where a provider without a cursor starts: its accounts' `sync_from`, or a fortnight back. */
export function windowStart(state: Pick<SyncState, 'since' | 'lastProviderDate'>): string | null {
  if (!state.lastProviderDate) return state.since;
  const d = new Date(`${state.lastProviderDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - WINDOW_OVERLAP_DAYS);
  const recent = d.toISOString().slice(0, 10);
  return state.since && state.since > recent ? state.since : recent;
}

export interface SyncDeps {
  db: Database;
  crypto: FieldCrypto;
}

/** Thrown inside the sync's transaction when the connection was disconnected meanwhile. */
class SyncStopped extends Error {
  constructor() {
    super('Sync stopped: the connection was disconnected');
    this.name = 'SyncStopped';
  }
}

export interface SyncSummary extends Omit<PageResult, 'balances'> {
  /** The pages the provider sent, in the run that was applied. */
  pages: number;
  restarts: number;
  /** Disconnected meanwhile: nothing from this run is written. */
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
        timeZone: households.timezone,
      })
      .from(connections)
      .innerJoin(householdMembers, eq(householdMembers.id, connections.ownerMemberId))
      .innerJoin(households, eq(households.id, connections.householdId))
      .where(eq(connections.id, target.connectionId));
    if (!row) return null;
    const [since] = await tx
      .select({ since: min(accounts.syncFrom) })
      .from(accounts)
      .where(and(eq(accounts.connectionId, target.connectionId), isNotNull(accounts.syncFrom)));
    const [latest] = await tx
      .select({
        date: max(
          sql<string>`coalesce(${transactions.postedDate}, ${transactions.authorizedDate})`,
        ),
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          eq(accounts.connectionId, target.connectionId),
          isNotNull(transactions.providerTransactionId),
        ),
      );
    return {
      ownerMemberId: row.ownerMemberId,
      ownerLeft: row.leftAt !== null,
      cursor: row.cursor,
      since: since?.since ?? null,
      lastProviderDate: latest?.date ?? null,
      timeZone: row.timeZone,
    };
  });
}

/**
 * Syncs a connection: pages through `provider.sync` from its stored cursor until the provider has
 * no more, holding every page, then applies them as one in a single transaction that also stores
 * the last page's cursor. On `mutation_during_pagination` it drops what it holds and starts over
 * from the cursor it began with, up to MAX_RESTARTS times; nothing was written, so nothing is
 * undone. A provider without a cursor (`window` mode) sends one page. Then the card and loan
 * details, when the provider has them. Provider errors are thrown for the runner.
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
    held: 0,
    updated: 0,
    posted: 0,
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

  const pages = await fetchPages(provider, secret, state, summary);
  const page = mergePages(pages);
  summary.pages = pages.length;
  try {
    const result = await inHousehold(async (tx, activity) => {
      const [now] = await tx
        .select({ status: connections.status, cursor: connections.syncCursor })
        .from(connections)
        .where(eq(connections.id, target.connectionId))
        .for('update');
      if (!now || (now.status !== 'ok' && now.status !== 'error')) throw new SyncStopped();
      // Another run moved it (a lease that ran out): this one stops rather than interleave.
      if (now.cursor !== state.cursor) throw new JobFailure(FAILURE.syncConflict);
      const applied = await applyPage(tx, activity, target, page, {
        pendingLinks: provider.capabilities.pendingLinks,
        crypto: deps.crypto,
      });
      await advanceConnection(tx, target.connectionId, page);
      // The sync itself, as the system's bookkeeping: the cursor, the balances, and the counts.
      await activity.record({
        action: 'sync.applied',
        targetType: 'connection',
        targetId: target.connectionId,
        metadata: {
          mode: page.mode,
          pages: pages.length,
          restarts: summary.restarts,
          ...applied,
          ...(page.historicalComplete && { historicalComplete: true }),
        },
        visibleToHousehold: false,
      });
      return applied;
    });
    summary.added = result.added;
    summary.matched = result.matched;
    summary.held = result.held;
    summary.updated = result.updated;
    summary.posted = result.posted;
    summary.removed = result.removed;
    summary.skipped = result.skipped;
  } catch (error) {
    if (error instanceof SyncStopped) {
      summary.stopped = true;
      return summary;
    }
    throw error;
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

/**
 * Every page the provider has from the stored cursor, in order, until it says there are no more.
 * Nothing is written meanwhile. When the data changed under it (`mutation_during_pagination`), the
 * pages so far are dropped and it asks again from the cursor it started with.
 */
async function fetchPages(
  provider: AggregationProvider,
  secret: ProviderSecret,
  state: SyncState,
  summary: SyncSummary,
): Promise<SyncPage[]> {
  let pages: SyncPage[] = [];
  let cursor = state.cursor;
  for (;;) {
    let page: SyncPage;
    try {
      const since = provider.capabilities.cursorSync ? state.since : windowStart(state);
      page = await provider.sync(secret, {
        cursor,
        ...(since !== null && { since }),
        timeZone: state.timeZone,
      });
    } catch (error) {
      if (
        isProviderError(error) &&
        error.kind === 'mutation_during_pagination' &&
        summary.restarts < MAX_RESTARTS
      ) {
        summary.restarts++;
        pages = [];
        cursor = state.cursor;
        continue;
      }
      throw error;
    }
    pages.push(page);
    if (page.mode === 'window' || !page.hasMore || page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
}
