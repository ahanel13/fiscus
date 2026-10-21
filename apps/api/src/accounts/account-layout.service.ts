// SPDX-License-Identifier: AGPL-3.0-or-later
import { accountGroups, accountPlacements, type Executor } from '@fiscus/db';
import { accessLevels } from '@fiscus/ledger';
import type { AccountLayout, AccountLayoutInput } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { asc, eq, inArray, notInArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { Problem } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

/** Same answer for an account that doesn't exist and one you can't see (permissions §3). */
const unknownAccount = () =>
  new Problem(422, 'unknown_account', 'No such account', 'Arrange only accounts you can see.');
const unknownGroup = () => new Problem(422, 'unknown_group', 'No such group');

/**
 * A member's arrangement of their accounts list (ACC-12, #48). Row-level security keeps it theirs:
 * these queries only ever see the caller's own groups and placements. Only accounts they can see
 * now are shown or changed; placements of ones hidden from them are kept, so an account that
 * comes back returns where they put it.
 */
@Injectable()
export class AccountLayoutService {
  constructor(private readonly scope: HouseholdScope) {}

  async get(ctx: HouseholdContext): Promise<AccountLayout> {
    return this.scope.run(ctx, async (tx) => this.#read(tx, [...(await accessLevels(tx)).keys()]));
  }

  async set(ctx: HouseholdContext, input: AccountLayoutInput): Promise<AccountLayout> {
    return this.scope.run(ctx, async (tx, activity) => {
      const visible = [...(await accessLevels(tx)).keys()];
      const seen = new Set(visible);
      const placed = [...input.groups.flatMap((g) => g.accountIds), ...input.ungrouped];
      if (placed.some((id) => !seen.has(id))) throw unknownAccount();

      const mine = new Set(
        (await tx.select({ id: accountGroups.id }).from(accountGroups)).map((g) => g.id),
      );
      const kept = input.groups.flatMap((g) => (g.id ? [g.id] : []));
      if (kept.some((id) => !mine.has(id))) throw unknownGroup();

      // Groups left out are deleted; their hidden accounts go back to their type's section.
      await tx
        .delete(accountGroups)
        .where(kept.length ? notInArray(accountGroups.id, kept) : undefined);
      if (visible.length) {
        await tx.delete(accountPlacements).where(inArray(accountPlacements.accountId, visible));
      }

      const owner = { householdId: ctx.householdId, memberId: ctx.memberId };
      const rows: (typeof accountPlacements.$inferInsert)[] = [];
      for (const [order, g] of input.groups.entries()) {
        const groupId = g.id ?? uuidv7();
        if (g.id) {
          await tx
            .update(accountGroups)
            .set({ name: g.name, sortOrder: order })
            .where(eq(accountGroups.id, groupId));
        } else {
          await tx
            .insert(accountGroups)
            .values({ ...owner, id: groupId, name: g.name, sortOrder: order });
        }
        g.accountIds.forEach((accountId, i) =>
          rows.push({ ...owner, accountId, groupId, sortOrder: i }),
        );
      }
      input.ungrouped.forEach((accountId, i) =>
        rows.push({ ...owner, accountId, groupId: null, sortOrder: i }),
      );
      if (rows.length) await tx.insert(accountPlacements).values(rows);

      await activity.record({
        action: 'account_layout.set',
        metadata: { groups: input.groups.length, placed: rows.length },
        visibleToHousehold: false,
      });
      return this.#read(tx, visible);
    });
  }

  async #read(tx: Executor, visible: string[]): Promise<AccountLayout> {
    const groups = await tx
      .select({ id: accountGroups.id, name: accountGroups.name })
      .from(accountGroups)
      .orderBy(asc(accountGroups.sortOrder), asc(accountGroups.id));
    const placements = visible.length
      ? await tx
          .select({ accountId: accountPlacements.accountId, groupId: accountPlacements.groupId })
          .from(accountPlacements)
          .where(inArray(accountPlacements.accountId, visible))
          .orderBy(asc(accountPlacements.sortOrder), asc(accountPlacements.accountId))
      : [];
    return {
      groups: groups.map((g) => ({
        ...g,
        accountIds: placements.filter((p) => p.groupId === g.id).map((p) => p.accountId),
      })),
      ungrouped: placements.filter((p) => p.groupId === null).map((p) => p.accountId),
    };
  }
}
