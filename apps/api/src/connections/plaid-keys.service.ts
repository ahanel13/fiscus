// SPDX-License-Identifier: AGPL-3.0-or-later
import { PlaidClient } from '@fiscus/aggregation';
import { isProviderError } from '@fiscus/domain';
import { FieldCrypto } from '@fiscus/crypto';
import {
  accounts,
  activePlaidKeySet,
  connections,
  householdMembers,
  institutions,
  plaidKeySetUses,
  revokePlaidKeySet,
  savePlaidKeySet,
} from '@fiscus/db';
import type { HouseholdPlaidKeys, PlaidKeysInput } from '@fiscus/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { InstanceSettingsService } from '../admin/instance-settings.service.js';
import { Problem, problems } from '../common/problem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import { LINK_COUNTRY_CODES, plaidProblem } from './plaid.js';

/**
 * A household's own Plaid keys (#83, ADR 0008 §Credentials 2–5): household owners only (HH-08,
 * the routes' guard), write-only, checked with Plaid before they're saved. Replacing them keeps
 * the connections made with the old ones syncing on those until each is connected again (D15);
 * removing keys that connections still use is refused. The secret is never returned, logged, or
 * recorded: activity says only which environment.
 */
@Injectable()
export class PlaidKeysService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
    private readonly settings: InstanceSettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async get(ctx: HouseholdContext): Promise<HouseholdPlaidKeys> {
    const allowed = await this.settings.get('plaid.allowHouseholdKeys');
    return this.scope.run(ctx, async (tx) => {
      const active = await activePlaidKeySet(tx, ctx.householdId);
      // Connections you can see (row-level security), with how many of their accounts you see.
      const rows = await tx
        .select({
          id: connections.id,
          institutionName: institutions.name,
          ownerMemberId: connections.ownerMemberId,
          ownerName: householdMembers.displayName,
          credentialSetId: connections.credentialSetId,
        })
        .from(connections)
        .leftJoin(institutions, eq(institutions.id, connections.institutionId))
        .leftJoin(householdMembers, eq(householdMembers.id, connections.ownerMemberId))
        .where(
          and(
            eq(connections.householdId, ctx.householdId),
            eq(connections.provider, 'plaid'),
            ne(connections.status, 'disconnected'),
          ),
        )
        .orderBy(asc(connections.createdAt), asc(connections.id));
      const counts = rows.length
        ? await tx
            .select({ connectionId: accounts.connectionId, n: sql<number>`count(*)::int` })
            .from(accounts)
            .where(
              inArray(
                accounts.connectionId,
                rows.map((r) => r.id),
              ),
            )
            .groupBy(accounts.connectionId)
        : [];
      return {
        allowed,
        serverKeys: Boolean(this.config.plaid),
        keys: active
          ? {
              clientIdEnding: active.clientId.slice(-4),
              env: active.env as 'sandbox' | 'production',
              addedAt: active.createdAt.toISOString(),
            }
          : null,
        connections: rows.map((r) => ({
          id: r.id,
          institutionName: r.institutionName,
          owner: { memberId: r.ownerMemberId, name: r.ownerName ?? '' },
          accountCount: counts.find((c) => c.connectionId === r.id)?.n ?? 0,
          keys:
            r.credentialSetId === null
              ? ('server' as const)
              : r.credentialSetId === active?.id
                ? ('current' as const)
                : ('previous' as const),
        })),
      };
    });
  }

  /** Adds or replaces the household's keys, once Plaid accepts them. */
  async put(ctx: HouseholdContext, input: PlaidKeysInput): Promise<HouseholdPlaidKeys> {
    if (!(await this.settings.get('plaid.allowHouseholdKeys'))) {
      throw new Problem(
        403,
        'household_keys_off',
        'This server doesn’t allow households’ own Plaid keys',
        'Its admin can turn them on in Server → Bank connections.',
      );
    }
    await this.#check(input);
    await this.scope.run(ctx, async (tx, activity) => {
      // Two owners saving at once: one after the other, so there's only ever one active set.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('fiscus_plaid_keys'), hashtext(${ctx.householdId}))`,
      );
      const before = await activePlaidKeySet(tx, ctx.householdId);
      if (before) {
        // Its connections keep syncing on it until each is connected again (D15).
        await revokePlaidKeySet(tx, before.id, (await plaidKeySetUses(tx, before.id)) === 0);
      }
      const id = uuidv7();
      await savePlaidKeySet(tx, this.crypto, {
        id,
        householdId: ctx.householdId,
        createdByMemberId: ctx.memberId,
        ...input,
      });
      await activity.record({
        action: before ? 'household.plaid_keys_replaced' : 'household.plaid_keys_added',
        targetType: 'household',
        targetId: ctx.householdId,
        metadata: { env: input.env },
      });
    });
    return this.get(ctx);
  }

  /** Removes the household's keys; refused while connections still use them. */
  async remove(ctx: HouseholdContext): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('fiscus_plaid_keys'), hashtext(${ctx.householdId}))`,
      );
      const active = await activePlaidKeySet(tx, ctx.householdId);
      if (!active) throw problems.notFound();
      const uses = await plaidKeySetUses(tx, active.id);
      if (uses > 0) {
        throw new Problem(
          409,
          'keys_in_use',
          'These keys still connect banks',
          `${uses} ${uses === 1 ? 'connection uses' : 'connections use'} them. Connect each bank again with the server’s keys, or disconnect it, first.`,
        );
      }
      await revokePlaidKeySet(tx, active.id, true);
      await activity.record({
        action: 'household.plaid_keys_removed',
        targetType: 'household',
        targetId: ctx.householdId,
        metadata: { env: active.env },
      });
    });
  }

  /** A free call with the keys (no Item): Plaid answers, or says they're wrong. */
  async #check(input: PlaidKeysInput): Promise<void> {
    const client = new PlaidClient({
      ...input,
      // The test-only fake Plaid, as for the server's sandbox keys; never for production.
      ...(input.env === 'sandbox' && this.config.plaid?.apiBaseUrl
        ? { apiBaseUrl: this.config.plaid.apiBaseUrl }
        : {}),
    });
    try {
      await client.institutionsGet(LINK_COUNTRY_CODES);
    } catch (err) {
      if (isProviderError(err) && err.kind === 'invalid_credentials') {
        throw new Problem(
          422,
          'plaid_keys_rejected',
          'Plaid didn’t accept these keys',
          `Check the client id, and that the secret is the ${input.env} one, in Plaid’s dashboard (Developers → Keys).`,
        );
      }
      plaidProblem(err);
    }
  }
}
