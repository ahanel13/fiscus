// SPDX-License-Identifier: AGPL-3.0-or-later
import { accounts, connections, type Executor, householdMembers, institutions } from '@fiscus/db';
import {
  type Connection,
  type ConnectionProvider,
  type ConnectionStatus,
  NOT_WORKING_AFTER_MS,
  REFRESH_LIMIT_MS,
  REPORTS_HISTORY,
  type RefreshTooSoon,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

/**
 * Bank connections (#78, the bank connections walkthrough §7). Row-level security decides who sees
 * one (ACC-02: its owner, or anyone who sees one of its accounts; a connection being set up, only
 * its owner). Secrets stay in connection_secrets: nothing here reads them.
 */
const notSyncing = (status: string) =>
  new Problem(
    409,
    status === 'setup' ? 'connection_in_setup' : 'connection_disconnected',
    status === 'setup'
      ? 'Choose this connection’s accounts first'
      : 'This connection is disconnected',
  );

/** When "Refresh now" works again after one at `requestedAt`, or null when it already does. */
function refreshAvailableAt(
  provider: ConnectionProvider,
  requestedAt: Date | null,
  now: number,
): string | null {
  if (!requestedAt) return null;
  const at = requestedAt.getTime() + REFRESH_LIMIT_MS[provider];
  return at > now ? new Date(at).toISOString() : null;
}

@Injectable()
export class ConnectionsService {
  constructor(private readonly scope: HouseholdScope) {}

  /** The connections behind accounts you can see, and your own; not disconnected ones. */
  list(ctx: HouseholdContext): Promise<Connection[]> {
    return this.scope.run(ctx, async (tx) => {
      const rows = await tx
        .select({
          id: connections.id,
          provider: connections.provider,
          status: connections.status,
          institutionName: institutions.name,
          ownerMemberId: connections.ownerMemberId,
          ownerName: householdMembers.displayName,
          lastSyncedAt: connections.lastSyncedAt,
          nextSyncAt: connections.nextSyncAt,
          firstFailedAt: connections.firstFailedAt,
          refreshRequestedAt: connections.refreshRequestedAt,
          historicalComplete: connections.historicalComplete,
        })
        .from(connections)
        .leftJoin(institutions, eq(institutions.id, connections.institutionId))
        .leftJoin(householdMembers, eq(householdMembers.id, connections.ownerMemberId))
        .where(
          and(eq(connections.householdId, ctx.householdId), ne(connections.status, 'disconnected')),
        )
        .orderBy(asc(connections.createdAt), asc(connections.id));
      // Only the accounts you can see count (row-level security), so hidden ones aren't revealed.
      const visible = rows.length
        ? await tx
            .select({ id: accounts.id, connectionId: accounts.connectionId })
            .from(accounts)
            .where(
              inArray(
                accounts.connectionId,
                rows.map((r) => r.id),
              ),
            )
            .orderBy(asc(accounts.sortOrder), asc(accounts.id))
        : [];
      const now = Date.now();
      return rows.map((r): Connection => {
        const provider = r.provider as ConnectionProvider;
        const status = r.status as ConnectionStatus;
        const accountIds = visible.filter((a) => a.connectionId === r.id).map((a) => a.id);
        const failing = (status === 'error' || status === 'login_required') && r.firstFailedAt;
        return {
          id: r.id,
          provider,
          status,
          institutionName: r.institutionName,
          owner: { memberId: r.ownerMemberId, name: r.ownerName ?? '' },
          accountCount: accountIds.length,
          accountIds,
          lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
          nextSyncAt: r.nextSyncAt?.toISOString() ?? null,
          failingSince: failing ? r.firstFailedAt!.toISOString() : null,
          notWorking: failing ? now - r.firstFailedAt!.getTime() >= NOT_WORKING_AFTER_MS : false,
          refreshAvailableAt: refreshAvailableAt(provider, r.refreshRequestedAt, now),
          importingHistory:
            REPORTS_HISTORY[provider] && status !== 'setup' && !r.historicalComplete,
        };
      });
    });
  }

  /**
   * "Refresh now" (D10, ACC-03): its owner asks for a sync, which the worker starts on its next
   * pass. At most once per the provider's limit; sooner is 429 with when it works again. Not
   * while it needs signing in again (that's the fix) or is still being set up.
   */
  async refresh(ctx: HouseholdContext, id: string): Promise<Connection> {
    await this.scope.run(ctx, async (tx, activity) => {
      const c = await this.#own(tx, ctx, id);
      if (c.status === 'login_required') {
        throw new Problem(
          409,
          'login_required',
          'The bank needs you to sign in again first',
          'Sign in again, and it syncs right away.',
        );
      }
      if (c.status !== 'ok' && c.status !== 'error') throw notSyncing(c.status);
      const now = Date.now();
      const availableAt = refreshAvailableAt(c.provider, c.refreshRequestedAt, now);
      if (availableAt) {
        const seconds = Math.ceil((Date.parse(availableAt) - now) / 1000);
        const extensions: RefreshTooSoon = { availableAt };
        throw new Problem(
          429,
          'refresh_too_soon',
          'It was refreshed a moment ago',
          c.provider === 'simplefin'
            ? 'SimpleFIN updates about once a day, so a refresh is allowed every 6 hours.'
            : 'A refresh is allowed every 15 minutes.',
          undefined,
          { 'retry-after': String(seconds) },
          { ...extensions },
        );
      }
      await tx
        .update(connections)
        .set({ refreshRequestedAt: sql`now()`, nextSyncAt: sql`now()`, updatedAt: new Date() })
        .where(eq(connections.id, id));
      await activity.record({
        action: 'connection.refresh_requested',
        targetType: 'connection',
        targetId: id,
        metadata: { provider: c.provider },
        visibleToHousehold: false,
      });
    });
    return this.#one(ctx, id);
  }

  /**
   * Signed in again through the provider (Plaid Link's update mode, D11): its owner says so, and
   * it syncs right away, which is what shows whether it's fixed. If it isn't, the sync puts it
   * back as it was.
   */
  async reauthed(ctx: HouseholdContext, id: string): Promise<Connection> {
    await this.scope.run(ctx, async (tx, activity) => {
      const c = await this.#own(tx, ctx, id);
      if (c.status !== 'ok' && c.status !== 'error' && c.status !== 'login_required') {
        throw notSyncing(c.status);
      }
      await tx
        .update(connections)
        .set({
          status: 'ok',
          lastErrorCode: null,
          firstFailedAt: null,
          consecutiveFailures: 0,
          nextSyncAt: sql`now()`,
          updatedAt: new Date(),
        })
        .where(eq(connections.id, id));
      // Seen by whoever sees its accounts: they saw it break too (D11).
      await activity.record({
        action: 'connection.signed_in_again',
        targetType: 'connection',
        targetId: id,
        metadata: { provider: c.provider },
      });
    });
    return this.#one(ctx, id);
  }

  /** The caller's own connection (ACC-03); someone else's is 403, one they can't see 404. */
  async #own(tx: Executor, ctx: HouseholdContext, id: string) {
    const [c] = await tx
      .select({
        ownerMemberId: connections.ownerMemberId,
        status: connections.status,
        provider: connections.provider,
        refreshRequestedAt: connections.refreshRequestedAt,
      })
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.householdId, ctx.householdId)));
    if (!c) throw problems.notFound();
    if (c.ownerMemberId !== ctx.memberId) {
      throw problems.forbidden('Only the person who connected it can do this.');
    }
    // Locked once it's known to be theirs (locking needs the update policy, which only its owner
    // passes), so two presses at once can't both get past the limit.
    const [locked] = await tx
      .select({ status: connections.status, refreshRequestedAt: connections.refreshRequestedAt })
      .from(connections)
      .where(eq(connections.id, id))
      .for('update');
    return { ...c, ...locked!, provider: c.provider as ConnectionProvider };
  }

  async #one(ctx: HouseholdContext, id: string): Promise<Connection> {
    const found = (await this.list(ctx)).find((c) => c.id === id);
    if (!found) throw problems.notFound();
    return found;
  }

  /**
   * Disconnects (D14, ACC-03): its owner may, or a household owner once its owner has left. It
   * stops syncing and its accounts let go of it, keeping their history (and provider_account_id,
   * so reconnecting can suggest linking them back). Ending it at the provider and deleting its
   * secret are the worker's (disconnect_requested), since that's where providers are called.
   */
  disconnect(ctx: HouseholdContext, id: string): Promise<void> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [c] = await tx
        .select({
          ownerMemberId: connections.ownerMemberId,
          status: connections.status,
          provider: connections.provider,
          ownerLeftAt: householdMembers.leftAt,
        })
        .from(connections)
        .leftJoin(householdMembers, eq(householdMembers.id, connections.ownerMemberId))
        .where(and(eq(connections.id, id), eq(connections.householdId, ctx.householdId)));
      if (!c) throw problems.notFound();
      const ownerLeft = c.ownerLeftAt !== null;
      if (c.ownerMemberId !== ctx.memberId && !(ownerLeft && ctx.role === 'owner')) {
        throw problems.forbidden(
          ownerLeft
            ? 'Its owner has left, so a household owner can disconnect it.'
            : 'Only the person who connected it can disconnect it.',
        );
      }
      if (c.status === 'disconnected') return;
      // A definer function (migration 0037): it lets go of accounts the caller may not own.
      const { rows } = await tx.execute<{ accounts: string[] }>(
        sql`SELECT fiscus_disconnect_connection(${id}) AS accounts`,
      );
      const released = rows[0]?.accounts ?? [];
      // One event per account, so each is seen by exactly those who see that account.
      for (const accountId of released) {
        await activity.record({
          action: 'connection.disconnected',
          targetType: 'connection',
          targetId: id,
          accountId,
          metadata: { provider: c.provider },
        });
      }
      if (released.length === 0) {
        await activity.record({
          action: 'connection.disconnected',
          targetType: 'connection',
          targetId: id,
          metadata: { provider: c.provider },
          visibleToHousehold: false,
        });
      }
    });
  }
}
