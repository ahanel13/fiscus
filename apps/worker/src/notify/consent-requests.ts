// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto } from '@fiscus/crypto';
import {
  consentRequests,
  type Database,
  enqueueNotification,
  householdMembers,
  households,
  systemContext,
  withContext,
} from '@fiscus/db';
import { describeError } from '@fiscus/env';
import { type Actor, guardActivity } from '@fiscus/ledger';
import { Logger } from '@nestjs/common';
import { and, eq, gt, lte, or, sql } from 'drizzle-orm';
import { appLink, longDate } from './rules/member.js';
import { localTime } from './rules/runner.js';

// Consent requests (#265, ADR 0012 §Departures item 5, D34). The worker ends those whose 14 days
// are over, as expired: nobody chose it, so it's recorded as the system's doing. And it tells the
// people involved: whoever was asked, once; whoever asked, once it's answered or has ended. Each
// notification's key names the request, so a restart sends nothing twice.

const SYSTEM: Actor = { kind: 'system', userId: null, memberId: null };

export interface ConsentRequestOptions {
  /** How often it looks: every request is at most this late to expire or be told about. */
  checkEveryMs: number;
  /** How far back the first look goes for requests that ended, after a start. */
  firstLookBackMs: number;
  now?: () => Date;
}

export const DEFAULT_CONSENT_REQUEST_OPTIONS: ConsentRequestOptions = {
  checkEveryMs: 60_000,
  firstLookBackMs: 14 * 24 * 60 * 60_000,
};

type Row = typeof consentRequests.$inferSelect;

/** What each person is told, at full and summary detail (D17). */
export function consentRequestText(
  event: 'asked' | 'accepted' | 'declined' | 'expired',
  r: { kind: Row['kind']; asker: string; asked: string; endsOn: string },
) {
  // The one kind so far: a split by income (D19).
  switch (event) {
    case 'asked':
      return {
        title: `${r.asker} asks you to agree to a split by income`,
        body: `Shared costs you’re part of can be split by income once you agree. The others see only the split, never your income. The request ends on ${longDate(r.endsOn)}.`,
        summary: 'Someone in your household asks for your agreement.',
      };
    case 'accepted':
      return {
        title: `${r.asked} agreed to a split by income`,
        body: 'A split by income counts for a shared cost once everyone it’s for has agreed.',
        summary: 'Someone answered your request.',
      };
    case 'declined':
      return {
        title: `${r.asked} declined a split by income`,
        body: `Shared costs ${r.asked} is part of keep the household default.`,
        summary: 'Someone answered your request.',
      };
    case 'expired':
      return {
        title: `Your request to ${r.asked} has ended`,
        body: `${r.asked} didn’t answer within 14 days, so shared costs they’re part of keep the household default. You can ask again.`,
        summary: 'A request of yours has ended without an answer.',
      };
  }
}

export class ConsentRequestNotices {
  readonly #db: Database;
  readonly #crypto: FieldCrypto;
  readonly #options: ConsentRequestOptions;
  readonly #logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  #lastCheck = 0;
  #since: Date;

  constructor(
    db: Database,
    crypto: FieldCrypto,
    options: Partial<ConsentRequestOptions> = {},
    logger?: Pick<Logger, 'log' | 'warn' | 'error'>,
  ) {
    this.#db = db;
    this.#crypto = crypto;
    this.#options = { ...DEFAULT_CONSENT_REQUEST_OPTIONS, ...options };
    this.#logger = logger ?? new Logger('ConsentRequests');
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

  /** Each household with a request open, or one that ended since the last look. */
  async pass(): Promise<void> {
    const now = this.#now();
    // A little overlap with the last look: the keys keep it from sending twice.
    const since = new Date(this.#since.getTime() - 60_000);
    const { rows } = await this.#db.execute<{ household_id: string }>(
      sql`SELECT household_id FROM fiscus_consent_request_households(${since.toISOString()}::timestamptz)`,
    );
    let failed = false;
    for (const { household_id: householdId } of rows) {
      try {
        await this.runHousehold(householdId, since);
      } catch (error) {
        failed = true;
        this.#logger.error(`Consent requests for ${householdId} failed: ${describeError(error)}`);
      }
    }
    // After a failure, the next look goes back as far again.
    if (!failed) this.#since = now;
  }

  /** Expires what's due, then tells people what's new. Returns how many notifications it wrote. */
  async runHousehold(householdId: string, since: Date): Promise<number> {
    await withContext(this.#db, systemContext(householdId), (tx) =>
      guardActivity(tx, householdId, SYSTEM, this.#crypto, async (tx, activity) => {
        const expired = await tx
          .update(consentRequests)
          .set({ status: 'expired', closedAt: sql`now()` })
          .where(
            and(eq(consentRequests.status, 'pending'), lte(consentRequests.expiresAt, sql`now()`)),
          )
          .returning();
        for (const row of expired) {
          await activity.record({
            action: 'consent_request.expired',
            targetType: 'consent_request',
            targetId: row.id,
            metadata: { kind: row.kind, memberId: row.memberId },
          });
        }
      }),
    );
    // Notifications aren't activity: they're written outside the activity gate.
    return withContext(this.#db, systemContext(householdId), async (tx) => {
      const [h] = await tx
        .select({ timezone: households.timezone })
        .from(households)
        .where(eq(households.id, householdId));
      const people = new Map(
        (
          await tx
            .select({
              id: householdMembers.id,
              name: householdMembers.displayName,
              leftAt: householdMembers.leftAt,
              userId: householdMembers.userId,
            })
            .from(householdMembers)
            .where(eq(householdMembers.householdId, householdId))
        ).map((m) => [m.id, m]),
      );
      const requests = await tx
        .select()
        .from(consentRequests)
        .where(or(eq(consentRequests.status, 'pending'), gt(consentRequests.closedAt, since)));
      let sent = 0;
      for (const r of requests) {
        const asker = people.get(r.requestedByMemberId);
        const asked = people.get(r.memberId);
        if (!asker || !asked) continue;
        const text = (event: Parameters<typeof consentRequestText>[0]) =>
          consentRequestText(event, {
            kind: r.kind,
            asker: asker.name,
            asked: asked.name,
            endsOn: localTime(h?.timezone ?? 'UTC', r.expiresAt).date,
          });
        const link = appLink(householdId, 'settings/shared-costs');
        // Only someone still here, who can sign in, is told.
        const told = (m: typeof asker) => !m.leftAt && m.userId !== null;
        if (r.status === 'pending') {
          if (!told(asked)) continue;
          const written = await enqueueNotification(tx, {
            householdId,
            memberId: r.memberId,
            kind: 'consent_request',
            dedupeKey: `consent_request:${r.id}`,
            ...text('asked'),
            link,
          });
          if (written) sent++;
        } else if (r.status !== 'withdrawn' && told(asker)) {
          const written = await enqueueNotification(tx, {
            householdId,
            memberId: r.requestedByMemberId,
            kind: 'consent_request',
            dedupeKey: `consent_request:${r.id}:${r.status}`,
            ...text(r.status),
            link,
          });
          if (written) sent++;
        }
      }
      return sent;
    });
  }
}
