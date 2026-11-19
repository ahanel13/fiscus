// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, incomeSplitConsents } from '@fiscus/db';
import type { IncomeShares } from '@fiscus/domain';
import { householdRanges } from '@fiscus/ledger';
import type { IncomeSplit, IncomeSplitConsent } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { desc, sql } from 'drizzle-orm';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

/**
 * Consent to a split by income (F4, #110, walkthrough D19). Each member agrees for themselves,
 * choosing the income it uses, from today on; anyone can change it or withdraw, also from today,
 * so nothing before moves. A member's income and choice stay theirs: row-level security shows
 * their consent to them alone, and everyone else gets only who has agreed and the split it makes,
 * from definer functions that never return an income (migration 0100).
 *
 * Consent here is given, not asked for. Asking someone, with an expiry (#265), builds on it: a
 * request is answered by agreeing here.
 */
@Injectable()
export class IncomeSplitService {
  constructor(private readonly scope: HouseholdScope) {}

  async get(ctx: HouseholdContext): Promise<IncomeSplit> {
    return this.scope.run(ctx, (tx) => this.#state(tx, ctx));
  }

  async consent(ctx: HouseholdContext, input: IncomeSplitConsent): Promise<IncomeSplit> {
    return this.scope.run(ctx, async (tx, activity) => {
      const { today } = await householdRanges(tx, ctx.householdId);
      const before = await current(tx);
      await write(tx, ctx, today, input);
      if (before) {
        // Only they see that they changed it, and never what to (no values recorded).
        await activity.record({
          action: 'income_split.income_changed',
          targetType: 'member',
          targetId: ctx.memberId,
          metadata: { effectiveFrom: today },
          visibleToHousehold: false,
        });
      } else {
        await activity.record({
          action: 'income_split.consented',
          targetType: 'member',
          targetId: ctx.memberId,
          metadata: { effectiveFrom: today },
        });
      }
      return this.#state(tx, ctx);
    });
  }

  /** Withdraws from today: a split by income stops counting for expenses you're part of. */
  async withdraw(ctx: HouseholdContext): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const { today } = await householdRanges(tx, ctx.householdId);
      if (!(await current(tx))) return;
      await write(tx, ctx, today, null);
      await activity.record({
        action: 'income_split.withdrawn',
        targetType: 'member',
        targetId: ctx.memberId,
        metadata: { effectiveFrom: today },
      });
    });
  }

  async #state(tx: Executor, ctx: HouseholdContext): Promise<IncomeSplit> {
    const { today } = await householdRanges(tx, ctx.householdId);
    const { rows: status } = await tx.execute<{ member_id: string; consented: boolean }>(
      sql`SELECT member_id, consented FROM fiscus_income_split_status(${today}::date)`,
    );
    const shares = (await incomeShares(tx, [today]))(today) ?? [];
    return {
      today,
      members: status.map((s) => ({ memberId: s.member_id, consented: s.consented })),
      shares: [...shares],
      yours: await current(tx),
    };
  }
}

/** Your consent as it stands: the latest row (row-level security shows only yours). */
async function current(tx: Executor): Promise<IncomeSplitConsent | null> {
  const [row] = await tx
    .select()
    .from(incomeSplitConsents)
    .orderBy(desc(incomeSplitConsents.effectiveFrom))
    .limit(1);
  if (!row?.basis) return null;
  return row.basis === 'declared'
    ? { basis: 'declared', declaredMonthlyMinor: row.declaredMonthlyMinor! }
    : { basis: 'actual' };
}

/** From `today`: a change made the same day replaces that day's. */
async function write(
  tx: Executor,
  ctx: HouseholdContext,
  today: string,
  input: IncomeSplitConsent | null,
): Promise<void> {
  const values = {
    basis: input?.basis ?? null,
    declaredMonthlyMinor: input?.basis === 'declared' ? input.declaredMonthlyMinor : null,
  };
  await tx
    .insert(incomeSplitConsents)
    .values({
      householdId: ctx.householdId,
      memberId: ctx.memberId,
      effectiveFrom: today,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        incomeSplitConsents.householdId,
        incomeSplitConsents.memberId,
        incomeSplitConsents.effectiveFrom,
      ],
      set: { ...values, createdAt: sql`now()` },
    });
}

/**
 * The split by income on each of `dates`, between those who had agreed by then (F4): shares in
 * basis points from fiscus_income_split_shares(), never an income.
 */
export async function incomeShares(tx: Executor, dates: readonly string[]): Promise<IncomeShares> {
  const days = [...new Set(dates)];
  const byDay = new Map<string, { memberId: string; shareBps: number }[]>();
  if (days.length > 0) {
    const { rows } = await tx.execute<{ day: string; member_id: string; share_bps: number }>(
      sql`SELECT day::text AS day, member_id, share_bps
          FROM fiscus_income_split_shares(${`{${days.join(',')}}`}::date[])
          ORDER BY member_id`,
    );
    for (const r of rows) {
      byDay.set(r.day, [
        ...(byDay.get(r.day) ?? []),
        { memberId: r.member_id, shareBps: r.share_bps },
      ]);
    }
  }
  return (date) => byDay.get(date) ?? null;
}
