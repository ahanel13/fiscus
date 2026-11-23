// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto } from '@fiscus/crypto';
import {
  type Database,
  type Executor,
  enqueueNotification,
  householdMembers,
  households,
  ownershipClaims,
  systemContext,
  users,
  withContext,
} from '@fiscus/db';
import { describeError } from '@fiscus/env';
import { type Actor, guardActivity, type HouseholdActivity } from '@fiscus/ledger';
import { CLAIM_NOTICE_DAYS, CLAIM_REMINDER_DAYS } from '@fiscus/shared';
import { Logger } from '@nestjs/common';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { appLink, longDate } from './rules/member.js';
import { localTime } from './rules/runner.js';

// Ownership claims (#267, ADR 0012 §Departures item 7, D35). Each look, for each household with a
// claim open or one that ended since the last look, the worker:
// 1. cancels an open claim when an owner has used Fiscus since it started, or the claimant can no
//    longer claim (they left, or aren't a member any more); otherwise grants it once its 30 days
//    are over, making the claimant an owner too. Nobody chose these, so they're the system's;
// 2. tells the owners about an open claim when it starts, a week before it ends and the day
//    before; and the people involved how it ended.
// Every step, each notice included, is in the household's activity. A notice's key names the claim
// and the step, so a restart sends nothing twice.

const SYSTEM: Actor = { kind: 'system', userId: null, memberId: null };
const DAY_MS = 24 * 60 * 60_000;

export interface OwnershipClaimOptions {
  /** How often it looks: an owner coming back ends a claim at most this late. */
  checkEveryMs: number;
  /** How far back the first look goes for claims that ended, after a start. */
  firstLookBackMs: number;
  now?: () => Date;
}

export const DEFAULT_OWNERSHIP_CLAIM_OPTIONS: OwnershipClaimOptions = {
  checkEveryMs: 60_000,
  firstLookBackMs: CLAIM_NOTICE_DAYS * DAY_MS,
};

export type ClaimNotice =
  | 'started'
  | 'reminder'
  | 'final'
  | 'granted'
  | 'granted_to_you'
  | 'rejected'
  | 'withdrawn'
  | 'owner_returned'
  | 'claimant_ineligible';

/** What each person is told, at full and summary detail (D17). */
export function ownershipClaimText(
  notice: ClaimNotice,
  c: { claimant: string; household: string; endsOn: string; by?: string },
) {
  const unless = `Unless an owner rejects it, or uses Fiscus, by ${longDate(c.endsOn)}, ${c.claimant} becomes an owner too. Nobody stops being an owner.`;
  const answer = 'Open Fiscus to reject it: using Fiscus at all also ends it.';
  switch (notice) {
    case 'started':
      return {
        title: `${c.claimant} asked to become an owner of ${c.household}`,
        body: `No owner has used Fiscus for ${CLAIM_NOTICE_DAYS} days, so ${c.claimant} has claimed ownership. ${unless} ${answer}`,
        summary: 'Someone in your household asked to become an owner.',
      };
    case 'reminder':
      return {
        title: `${c.claimant} becomes an owner of ${c.household} in ${CLAIM_REMINDER_DAYS[0]} days`,
        body: `${unless} ${answer}`,
        summary: 'Someone in your household becomes an owner soon.',
      };
    case 'final':
      return {
        title: `${c.claimant} becomes an owner of ${c.household} tomorrow`,
        body: `${unless} ${answer}`,
        summary: 'Someone in your household becomes an owner tomorrow.',
      };
    case 'granted':
      return {
        title: `${c.claimant} is now an owner of ${c.household} too`,
        body: `No owner answered ${c.claimant}’s claim within ${CLAIM_NOTICE_DAYS} days, so they became an owner alongside you. You’re still an owner. It’s in the household’s activity.`,
        summary: 'Someone in your household is now an owner too.',
      };
    case 'granted_to_you':
      return {
        title: `You’re now an owner of ${c.household}`,
        body: `No owner answered your claim within ${CLAIM_NOTICE_DAYS} days. You can now do what owners do, such as invite people and change the household’s settings.`,
        summary: 'Your ownership claim went through.',
      };
    case 'rejected':
      return {
        title: `${c.by ?? 'An owner'} rejected your ownership claim`,
        body: `${c.household} stays as it is. Talk to ${c.by ?? 'them'} about what you need.`,
        summary: 'An owner answered your ownership claim.',
      };
    case 'withdrawn':
      return {
        title: `${c.claimant} withdrew their ownership claim`,
        body: `Nothing changes in ${c.household}.`,
        summary: 'An ownership claim in your household has ended.',
      };
    case 'owner_returned':
      return {
        title: 'Your ownership claim has ended',
        body: `An owner used Fiscus again, so your claim to ${c.household} has ended. You can ask them directly.`,
        summary: 'Your ownership claim has ended.',
      };
    case 'claimant_ineligible':
      return {
        title: `${c.claimant}’s ownership claim has ended`,
        body: `${c.claimant} is no longer a member who can claim ownership of ${c.household}, so nothing changes.`,
        summary: 'An ownership claim in your household has ended.',
      };
  }
}

/** Which notice an open claim's owners are due: the latest step it has reached. */
export function openNotice(endsAt: Date, now: Date): 'started' | 'reminder' | 'final' {
  const left = endsAt.getTime() - now.getTime();
  if (left <= CLAIM_REMINDER_DAYS[1] * DAY_MS) return 'final';
  if (left <= CLAIM_REMINDER_DAYS[0] * DAY_MS) return 'reminder';
  return 'started';
}

export class OwnershipClaimNotices {
  readonly #db: Database;
  readonly #crypto: FieldCrypto;
  readonly #options: OwnershipClaimOptions;
  readonly #logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  #lastCheck = 0;
  #since: Date;

  constructor(
    db: Database,
    crypto: FieldCrypto,
    options: Partial<OwnershipClaimOptions> = {},
    logger?: Pick<Logger, 'log' | 'warn' | 'error'>,
  ) {
    this.#db = db;
    this.#crypto = crypto;
    this.#options = { ...DEFAULT_OWNERSHIP_CLAIM_OPTIONS, ...options };
    this.#logger = logger ?? new Logger('OwnershipClaims');
    this.#since = new Date(this.#now().getTime() - this.#options.firstLookBackMs);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  /** Looks, at most every `checkEveryMs`. */
  async maybePass(): Promise<void> {
    const now = this.#now().getTime();
    if (now - this.#lastCheck < this.#options.checkEveryMs) return;
    this.#lastCheck = now;
    await this.pass();
  }

  /** Each household with a claim open, or one that ended since the last look. */
  async pass(): Promise<void> {
    const now = this.#now();
    // A little overlap with the last look: the keys keep it from sending twice.
    const since = new Date(this.#since.getTime() - 60_000);
    const { rows } = await this.#db.execute<{ household_id: string }>(
      sql`SELECT household_id FROM fiscus_ownership_claim_households(${since.toISOString()}::timestamptz)`,
    );
    let failed = false;
    for (const { household_id: householdId } of rows) {
      try {
        await this.runHousehold(householdId, since);
      } catch (error) {
        failed = true;
        this.#logger.error(`Ownership claims for ${householdId} failed: ${describeError(error)}`);
      }
    }
    // After a failure, the next look goes back as far again.
    if (!failed) this.#since = now;
  }

  /** Ends or grants what's due, then tells people. Returns how many notifications it wrote. */
  async runHousehold(householdId: string, since: Date): Promise<number> {
    return withContext(this.#db, systemContext(householdId), (tx) =>
      guardActivity(tx, householdId, SYSTEM, this.#crypto, async (tx, activity) => {
        await this.#decide(tx, activity, householdId);
        return this.#tell(tx, activity, householdId, since);
      }),
    );
  }

  async #decide(tx: Executor, activity: HouseholdActivity, householdId: string): Promise<void> {
    const [open] = await tx
      .select({
        claim: ownershipClaims,
        role: householdMembers.role,
        leftAt: householdMembers.leftAt,
        userId: householdMembers.userId,
      })
      .from(ownershipClaims)
      .innerJoin(householdMembers, eq(householdMembers.id, ownershipClaims.claimantMemberId))
      .where(and(eq(ownershipClaims.householdId, householdId), eq(ownershipClaims.status, 'open')))
      .for('update', { of: ownershipClaims });
    if (!open) return;
    const { claim } = open;
    const [returned] = await tx
      .select({ id: householdMembers.id })
      .from(householdMembers)
      .innerJoin(users, eq(users.id, householdMembers.userId))
      .where(
        and(
          eq(householdMembers.householdId, householdId),
          eq(householdMembers.role, 'owner'),
          isNull(householdMembers.leftAt),
          gt(users.lastActiveAt, claim.createdAt),
        ),
      )
      .limit(1);
    const reason =
      open.leftAt || open.role !== 'member' || !open.userId
        ? 'claimant_ineligible'
        : returned
          ? 'owner_returned'
          : null;
    if (reason) {
      await tx
        .update(ownershipClaims)
        .set({ status: 'cancelled', cancelReason: reason })
        .where(eq(ownershipClaims.id, claim.id));
      await activity.record({
        action: 'ownership_claim.cancelled',
        targetType: 'ownership_claim',
        targetId: claim.id,
        metadata: { claimantMemberId: claim.claimantMemberId, reason },
      });
      return;
    }
    const granted = await tx
      .update(ownershipClaims)
      .set({ status: 'granted' })
      .where(and(eq(ownershipClaims.id, claim.id), lte(ownershipClaims.endsAt, sql`now()`)))
      .returning({ id: ownershipClaims.id });
    if (granted.length === 0) return;
    await tx
      .update(householdMembers)
      .set({ role: 'owner' })
      .where(eq(householdMembers.id, claim.claimantMemberId));
    await activity.record({
      action: 'ownership_claim.granted',
      targetType: 'ownership_claim',
      targetId: claim.id,
      metadata: { claimantMemberId: claim.claimantMemberId },
    });
    await activity.record({
      action: 'member.role_changed',
      targetType: 'household_member',
      targetId: claim.claimantMemberId,
      metadata: { from: 'member', to: 'owner', ownershipClaimId: claim.id },
    });
  }

  async #tell(
    tx: Executor,
    activity: HouseholdActivity,
    householdId: string,
    since: Date,
  ): Promise<number> {
    const now = this.#now();
    const [h] = await tx
      .select({ name: households.name, timezone: households.timezone })
      .from(households)
      .where(eq(households.id, householdId));
    const people = await tx
      .select({
        id: householdMembers.id,
        name: householdMembers.displayName,
        role: householdMembers.role,
        leftAt: householdMembers.leftAt,
        userId: householdMembers.userId,
      })
      .from(householdMembers)
      .where(eq(householdMembers.householdId, householdId));
    const byId = new Map(people.map((p) => [p.id, p]));
    // Only someone still here, who can sign in, is told.
    const here = (p: (typeof people)[number] | undefined) => !!p && !p.leftAt && p.userId !== null;
    const claims = await tx
      .select()
      .from(ownershipClaims)
      .where(
        and(
          eq(ownershipClaims.householdId, householdId),
          or(eq(ownershipClaims.status, 'open'), gt(ownershipClaims.closedAt, since)),
        ),
      );
    const link = appLink(householdId, 'settings/members');
    let sent = 0;
    for (const c of claims) {
      const claimant = byId.get(c.claimantMemberId);
      if (!claimant) continue;
      const owners = people.filter((p) => here(p) && p.role === 'owner' && p.id !== claimant.id);
      const text = (notice: ClaimNotice) =>
        ownershipClaimText(notice, {
          claimant: claimant.name,
          household: h?.name ?? 'your household',
          endsOn: localTime(h?.timezone ?? 'UTC', c.endsAt).date,
          ...(c.closedByMemberId ? { by: byId.get(c.closedByMemberId)?.name ?? 'An owner' } : {}),
        });
      const sends: { to: string[]; notice: ClaimNotice }[] = [];
      const toClaimant = here(claimant) ? [claimant.id] : [];
      const toOwners = owners.map((o) => o.id);
      switch (c.status) {
        case 'open':
          sends.push({ to: toOwners, notice: openNotice(c.endsAt, now) });
          break;
        case 'granted':
          sends.push(
            { to: toClaimant, notice: 'granted_to_you' },
            { to: toOwners, notice: 'granted' },
          );
          break;
        case 'rejected':
          sends.push({ to: toClaimant, notice: 'rejected' });
          break;
        case 'withdrawn':
          sends.push({ to: toOwners, notice: 'withdrawn' });
          break;
        case 'cancelled':
          sends.push(
            c.cancelReason === 'owner_returned'
              ? { to: toClaimant, notice: 'owner_returned' }
              : { to: toOwners, notice: 'claimant_ineligible' },
          );
          break;
      }
      for (const { to, notice } of sends) {
        let written = 0;
        for (const memberId of to) {
          const id = await enqueueNotification(tx, {
            householdId,
            memberId,
            kind: 'ownership_claim',
            dedupeKey: `ownership_claim:${c.id}:${notice}`,
            ...text(notice),
            link,
          });
          if (id) written++;
        }
        if (written === 0) continue;
        sent += written;
        await activity.record({
          action: 'ownership_claim.notified',
          targetType: 'ownership_claim',
          targetId: c.id,
          metadata: { notice, recipients: written },
        });
      }
    }
    return sent;
  }
}
