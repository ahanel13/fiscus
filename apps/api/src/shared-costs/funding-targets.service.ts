// SPDX-License-Identifier: AGPL-3.0-or-later
import { accountOwners, accounts, type Executor, fundingTargets } from '@fiscus/db';
import { defaultFundingStart, fundingProgress } from '@fiscus/domain';
import { accessLevels, householdRanges, memberContributions } from '@fiscus/ledger';
import type {
  FundingAccount,
  FundingTarget,
  FundingTargets,
  SetFundingTarget,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type Row = typeof fundingTargets.$inferSelect;

/** Levels that see an account's transactions, and so the money a target tracks. */
const SEES_TRANSACTIONS = new Set(['owner', 'full', 'view_only']);

/**
 * Joint-account funding targets (#113, ADR 0006 §7.3): what each owner moves into a joint
 * account per period, against the transfers in from their own accounts. Whoever sees the
 * account's transactions sees its targets; only its owners set, change or remove them, for any of
 * its owners, and each change is in the activity of those who see the account. Only fixed amounts
 * for now: a share of income waits for consent (#110, F4).
 */
@Injectable()
export class FundingTargetsService {
  constructor(private readonly scope: HouseholdScope) {}

  async list(ctx: HouseholdContext): Promise<FundingTargets> {
    return this.scope.run(ctx, async (tx) => {
      const { today, dateBasis } = await householdRanges(tx, ctx.householdId);
      const levels = await accessLevels(tx);
      const joint = await jointAccounts(
        tx,
        [...levels].filter(([, l]) => SEES_TRANSACTIONS.has(l)).map(([id]) => id),
      );
      const rows = joint.length
        ? await tx
            .select()
            .from(fundingTargets)
            .where(
              inArray(
                fundingTargets.accountId,
                joint.map((a) => a.id),
              ),
            )
        : [];
      // Accounts you own, and others' joint accounts once they have a target.
      const shown = joint.filter(
        (a) => levels.get(a.id) === 'owner' || rows.some((r) => r.accountId === a.id),
      );
      const fixed = rows.filter((r) => r.method === 'fixed');
      const earliest = fixed.reduce<string | null>(
        (min, r) => (min === null || r.startsOn < min ? r.startsOn : min),
        null,
      );
      const money = earliest
        ? await memberContributions(
            tx,
            [...new Set(fixed.map((r) => r.accountId))],
            earliest,
            dateBasis,
          )
        : [];
      const status = (r: Row): FundingTarget =>
        toTarget(
          r,
          today,
          money.filter((m) => m.accountId === r.accountId && m.memberId === r.memberId),
        );
      return {
        today,
        accounts: shown.map((a): FundingAccount => ({
          accountId: a.id,
          accountName: a.name,
          currency: a.currency,
          ownerIds: a.ownerIds,
          targets: fixed
            .filter((r) => r.accountId === a.id)
            .sort((x, y) => a.ownerIds.indexOf(x.memberId) - a.ownerIds.indexOf(y.memberId))
            .map(status),
        })),
      };
    });
  }

  /** Sets a member's target for a joint account you own (SHR-08). */
  async set(
    ctx: HouseholdContext,
    accountId: string,
    memberId: string,
    input: SetFundingTarget,
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const account = await ownedJoint(tx, accountId);
      if (!account.ownerIds.includes(memberId)) {
        throw new Problem(
          422,
          'funding_not_an_owner',
          'A funding target is for one of the account’s owners',
          'Add them as an owner of the account first.',
        );
      }
      const { today } = await householdRanges(tx, ctx.householdId);
      const startsOn = input.startsOn ?? defaultFundingStart(input.cadence, today);
      const [before] = await tx
        .select()
        .from(fundingTargets)
        .where(and(eq(fundingTargets.accountId, accountId), eq(fundingTargets.memberId, memberId)));
      const values = {
        method: input.method,
        amountMinor: input.amountMinor,
        percentBps: null,
        cadence: input.cadence,
        startsOn,
        createdByMemberId: ctx.memberId,
      };
      const [row] = await tx
        .insert(fundingTargets)
        .values({ householdId: ctx.householdId, accountId, memberId, ...values })
        .onConflictDoUpdate({
          target: [fundingTargets.accountId, fundingTargets.memberId],
          set: { ...values, updatedAt: sql`now()` },
        })
        .returning();
      await activity.record({
        action: 'funding_target.set',
        targetType: 'funding_target',
        targetId: row!.id,
        accountId,
        metadata: { memberId, cadence: input.cadence },
        changes: {
          ...(before ? { before: summary(before) } : {}),
          after: summary(row!),
        },
      });
    });
  }

  /** Removes a member's target (SHR-08). Nothing else changes: the transfers stay as they are. */
  async remove(ctx: HouseholdContext, accountId: string, memberId: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      await ownedJoint(tx, accountId);
      const [row] = await tx
        .delete(fundingTargets)
        .where(and(eq(fundingTargets.accountId, accountId), eq(fundingTargets.memberId, memberId)))
        .returning();
      if (!row) throw problems.notFound();
      await activity.record({
        action: 'funding_target.removed',
        targetType: 'funding_target',
        targetId: row.id,
        accountId,
        metadata: { memberId },
        changes: { before: summary(row) },
      });
    });
  }
}

interface JointAccount {
  id: string;
  name: string;
  currency: string;
  ownerIds: string[];
}

/** Which of `ids` are joint today (two or more owners) and open, by name. */
async function jointAccounts(tx: Executor, ids: string[]): Promise<JointAccount[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      memberId: accountOwners.memberId,
    })
    .from(accounts)
    .innerJoin(accountOwners, eq(accountOwners.accountId, accounts.id))
    .where(and(inArray(accounts.id, ids), isNull(accounts.closedAt)));
  const byId = new Map<string, JointAccount>();
  for (const r of rows) {
    const a = byId.get(r.id) ?? { id: r.id, name: r.name, currency: r.currency, ownerIds: [] };
    a.ownerIds.push(r.memberId);
    byId.set(r.id, a);
  }
  return [...byId.values()]
    .filter((a) => a.ownerIds.length >= 2)
    .map((a) => ({ ...a, ownerIds: a.ownerIds.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A joint account the caller owns; 404 if they can't see it, 403 if they only see it. */
async function ownedJoint(tx: Executor, accountId: string): Promise<JointAccount> {
  const level = (await accessLevels(tx)).get(accountId);
  if (!level) throw problems.notFound();
  if (level !== 'owner') {
    throw new Problem(
      403,
      'funding_owners_only',
      'Only the account’s owners set its funding targets',
    );
  }
  const [account] = await jointAccounts(tx, [accountId]);
  if (!account) {
    throw new Problem(
      422,
      'funding_not_joint',
      'Funding targets are for joint accounts',
      'Add another owner to the account first.',
    );
  }
  return account;
}

const summary = (r: Row) => ({
  method: r.method,
  amountMinor: r.amountMinor,
  cadence: r.cadence,
  startsOn: r.startsOn,
});

function toTarget(
  r: Row,
  today: string,
  contributions: { date: string; amountMinor: number }[],
): FundingTarget {
  const p = fundingProgress({
    amountMinor: r.amountMinor!,
    cadence: r.cadence,
    startsOn: r.startsOn,
    today,
    contributions,
  });
  return {
    id: r.id,
    accountId: r.accountId,
    memberId: r.memberId,
    method: 'fixed',
    amountMinor: r.amountMinor!,
    cadence: r.cadence,
    startsOn: r.startsOn,
    status: p.status,
    contributedMinor: p.contributedMinor,
    differenceMinor: p.differenceMinor,
    leftThisPeriodMinor: p.leftThisPeriodMinor,
    current: p.current,
    recent: p.recent,
    setByMemberId: r.createdByMemberId,
  };
}
