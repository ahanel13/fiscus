// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Executor,
  enqueueNotification,
  type NewNotification,
  notificationPreferences,
} from '@fiscus/db';
import {
  addDays,
  formatMoney,
  minorUnitExponent,
  type NotificationChannelKind,
  type NotificationKind,
  type NotificationSettings,
  ruleSettings,
} from '@fiscus/shared';
import { eq } from 'drizzle-orm';

// One member's run of the rules (#127): who they are, their day in the household's time zone, and
// their settings. Every rule reads in the member's own database context, so row-level security
// limits what it can mention to what they can see (D15, SYS-02), and writes their notifications
// there too.

export interface MemberRun {
  tx: Executor;
  householdId: string;
  memberId: string;
  role: 'owner' | 'member' | 'viewer';
  /** The household's today, and its hour now (D20). */
  today: string;
  hour: number;
  currency: string;
  /** A rule's settings: theirs over D18's defaults. */
  settings<K extends NotificationKind>(kind: K): NotificationSettings<K>;
  /** Whether a rule goes anywhere: off when they've unticked every channel. */
  on(kind: NotificationKind): boolean;
  /** Writes a notification for them; false when it was already written (D20). */
  notify(n: Omit<NewNotification, 'householdId' | 'memberId'>): Promise<boolean>;
}

export async function memberRun(
  tx: Executor,
  m: Pick<MemberRun, 'householdId' | 'memberId' | 'role' | 'today' | 'hour' | 'currency'>,
): Promise<MemberRun> {
  const prefs = new Map(
    (
      await tx
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.memberId, m.memberId))
    ).map((p) => [p.kind, p]),
  );
  return {
    ...m,
    tx,
    settings: (kind) => ruleSettings(kind, prefs.get(kind)?.settings),
    on: (kind) => {
      const channels = prefs.get(kind)?.channels as NotificationChannelKind[] | null | undefined;
      return channels === null || channels === undefined || channels.length > 0;
    },
    notify: async (n) =>
      (await enqueueNotification(tx, {
        ...n,
        householdId: m.householdId,
        memberId: m.memberId,
      })) !== null,
  };
}

// ── Wording ─────────────────────────────────────────────────────────────────────────────────

/** "$142", or "$142.18". */
export const money = (minor: number, currency: string) =>
  formatMoney(Math.abs(minor), currency, {
    whole: Math.abs(minor) % 10 ** minorUnitExponent(currency) === 0,
  });

/** "Thursday, November 12". */
export const longDate = (date: string) =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));

/** "today", "tomorrow", "on Thursday, November 12". */
export function when(date: string, today: string): string {
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  return `on ${longDate(date)}`;
}

/** The Monday of `date`'s week: a week's key for once-a-week notifications. */
export function weekOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

export const appLink = (householdId: string, path = '') =>
  `/h/${householdId}${path ? `/${path}` : ''}`;
