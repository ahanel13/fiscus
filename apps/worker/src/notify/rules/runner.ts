// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Database,
  householdMembers,
  households,
  systemContext,
  users,
  withContext,
} from '@fiscus/db';
import { describeError } from '@fiscus/env';
import { Logger } from '@nestjs/common';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { type MemberRun, memberRun } from './member.js';
import { weeklyRecap } from './recap.js';
import { bigTransactions, DAILY_RULES, review } from './rules.js';

// When the rules run (#127, D20): each household's on its own clock. Once each local hour, a
// household's members are looked at; the daily rules run once a day from DAILY_HOUR, transactions
// to review from each member's hour, and the weekly recap from theirs. New transactions are
// looked at every check, for big ones. What's been sent is in the notifications' keys, so a
// restart repeats the work, never the notifications.

export interface RulesOptions {
  /** The local hour the daily rules run from: bills, statements, balances, budgets (D20). */
  dailyHour: number;
  /** How often the rules are looked at: households at most once a local hour, new transactions each time. */
  checkEveryMs: number;
  /** How far back the first look for big transactions goes, after a start. */
  firstLookBackMs: number;
  /** Sends the weekly recap (#128); on unless turned off. */
  recap: boolean;
  /** The server's address, for the recap email's links. */
  publicUrl: string | null;
  now?: () => Date;
}

export const DEFAULT_RULES_OPTIONS: RulesOptions = {
  dailyHour: 8,
  checkEveryMs: 60_000,
  firstLookBackMs: 24 * 60 * 60_000,
  recap: true,
  publicUrl: null,
};

/** The household's date, hour and weekday at `now`. */
export function localTime(timeZone: string, now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'long',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: String(parts.weekday).toLowerCase(),
  };
}

export type LocalTime = ReturnType<typeof localTime>;

export class NotificationRules {
  readonly #db: Database;
  readonly #options: RulesOptions;
  readonly #logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  readonly #lastHour = new Map<string, string>();
  readonly #lastDaily = new Map<string, string>();
  #lastCheck = 0;
  #since: Date;

  constructor(
    db: Database,
    options: Partial<RulesOptions> = {},
    logger?: Pick<Logger, 'log' | 'warn' | 'error'>,
  ) {
    this.#db = db;
    this.#options = { ...DEFAULT_RULES_OPTIONS, ...options };
    this.#logger = logger ?? new Logger('NotificationRules');
    this.#since = new Date(this.#now().getTime() - this.#options.firstLookBackMs);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  /** Runs what's due, at most every `checkEveryMs`. */
  async maybePass(): Promise<void> {
    const now = this.#now().getTime();
    if (now - this.#lastCheck < this.#options.checkEveryMs) return;
    this.#lastCheck = now;
    await this.pass();
  }

  /** One look: each household once per local hour, and new transactions everywhere. */
  async pass(): Promise<void> {
    const now = this.#now();
    const { rows } = await this.#db.execute<{ household_id: string; timezone: string }>(
      sql`SELECT household_id, timezone FROM fiscus_notification_households()`,
    );
    const zones = new Map(rows.map((r) => [r.household_id, r.timezone]));
    for (const [householdId, timeZone] of zones) {
      const local = localTime(timeZone, now);
      const slot = `${local.date}T${local.hour}`;
      if (this.#lastHour.get(householdId) === slot) continue;
      this.#lastHour.set(householdId, slot);
      const daily =
        local.hour >= this.#options.dailyHour && this.#lastDaily.get(householdId) !== local.date;
      try {
        await this.runHousehold(householdId, local, { daily });
        if (daily) this.#lastDaily.set(householdId, local.date);
      } catch (error) {
        this.#lastHour.delete(householdId);
        this.#logger.error(`Rules for ${householdId} failed: ${describeError(error)}`);
      }
    }
    // A little overlap with the last look: the keys keep it from sending twice.
    const since = new Date(this.#since.getTime() - 60_000);
    this.#since = now;
    const { rows: fresh } = await this.#db.execute<{ household_id: string }>(
      sql`SELECT household_id FROM fiscus_households_with_new_transactions(${since.toISOString()}::timestamptz)`,
    );
    for (const { household_id: householdId } of fresh) {
      const timeZone = zones.get(householdId);
      if (!timeZone) continue;
      try {
        await this.runBigTransactions(householdId, localTime(timeZone, now), since);
      } catch (error) {
        this.#logger.error(`Big transactions for ${householdId} failed: ${describeError(error)}`);
      }
    }
  }

  /** The household's current members who can sign in, and its currency. */
  async #members(householdId: string) {
    return withContext(this.#db, systemContext(householdId), async (tx) => {
      const [h] = await tx
        .select({ currency: households.baseCurrency, weekStart: households.weekStart })
        .from(households)
        .where(eq(households.id, householdId));
      const members = await tx
        .select({
          memberId: householdMembers.id,
          userId: householdMembers.userId,
          role: householdMembers.role,
        })
        .from(householdMembers)
        .innerJoin(users, eq(users.id, householdMembers.userId))
        .where(
          and(
            eq(householdMembers.householdId, householdId),
            isNull(householdMembers.leftAt),
            isNotNull(householdMembers.userId),
            isNull(users.disabledAt),
          ),
        );
      return { currency: h?.currency ?? 'USD', weekStartDay: h?.weekStart ?? 1, members };
    });
  }

  /** Runs `fn` for each member, in their own database context: what they see, and no more. */
  async #eachMember(
    householdId: string,
    local: LocalTime,
    fn: (m: MemberRun) => Promise<number>,
  ): Promise<number> {
    const { currency, weekStartDay, members } = await this.#members(householdId);
    let sent = 0;
    for (const member of members) {
      try {
        sent += await withContext(
          this.#db,
          { householdId, memberId: member.memberId, userId: member.userId, system: false },
          async (tx) =>
            fn(
              await memberRun(tx, {
                householdId,
                memberId: member.memberId,
                role: member.role,
                today: local.date,
                hour: local.hour,
                currency,
                weekStartDay,
              }),
            ),
        );
      } catch (error) {
        this.#logger.error(`Rules for member ${member.memberId} failed: ${describeError(error)}`);
      }
    }
    return sent;
  }

  /** The household's scheduled rules at its local time: the daily ones when `daily`. */
  async runHousehold(
    householdId: string,
    local: LocalTime,
    { daily }: { daily: boolean },
  ): Promise<number> {
    const sent = await this.#eachMember(householdId, local, async (m) => {
      let n = 0;
      if (daily) for (const rule of DAILY_RULES) n += await rule(m);
      n += await review(m);
      if (this.#options.recap) {
        n += await weeklyRecap(m, {
          weekday: local.weekday,
          publicUrl: this.#options.publicUrl,
        });
      }
      return n;
    });
    if (sent) this.#logger.log(`${householdId}: ${sent} notification${sent === 1 ? '' : 's'}`);
    return sent;
  }

  /** Big transactions written since `since`, for each member who sees them. */
  async runBigTransactions(householdId: string, local: LocalTime, since: Date): Promise<number> {
    return this.#eachMember(householdId, local, (m) => bigTransactions(m, since));
  }
}
