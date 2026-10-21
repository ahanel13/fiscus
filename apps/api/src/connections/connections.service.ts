// SPDX-License-Identifier: AGPL-3.0-or-later
import { accounts, connections, householdMembers, institutions } from '@fiscus/db';
import type { Connection, ConnectionProvider, ConnectionStatus } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

/**
 * Bank connections (#78, the bank connections walkthrough §7). Row-level security decides who sees
 * one (ACC-02: its owner, or anyone who sees one of its accounts; a connection being set up, only
 * its owner). Secrets stay in connection_secrets: nothing here reads them.
 */
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
        })
        .from(connections)
        .leftJoin(institutions, eq(institutions.id, connections.institutionId))
        .leftJoin(householdMembers, eq(householdMembers.id, connections.ownerMemberId))
        .where(
          and(eq(connections.householdId, ctx.householdId), ne(connections.status, 'disconnected')),
        )
        .orderBy(asc(connections.createdAt), asc(connections.id));
      // Only the accounts you can see count (row-level security), so hidden ones aren't revealed.
      const counts = rows.length
        ? await tx
            .select({ id: accounts.connectionId, n: count() })
            .from(accounts)
            .where(
              inArray(
                accounts.connectionId,
                rows.map((r) => r.id),
              ),
            )
            .groupBy(accounts.connectionId)
        : [];
      const accountCount = new Map(counts.map((c) => [c.id, c.n]));
      return rows.map((r) => ({
        id: r.id,
        provider: r.provider as ConnectionProvider,
        status: r.status as ConnectionStatus,
        institutionName: r.institutionName,
        owner: { memberId: r.ownerMemberId, name: r.ownerName ?? '' },
        accountCount: accountCount.get(r.id) ?? 0,
        lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
        nextSyncAt: r.nextSyncAt?.toISOString() ?? null,
      }));
    });
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
