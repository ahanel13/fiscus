// SPDX-License-Identifier: AGPL-3.0-or-later
import { notifications } from '@fiscus/db';
import { buildWeeklyRecap, lastWeekStart } from '@fiscus/ledger';
import { DETAIL_LEVELS, renderWeeklyRecapEmail, WEEKDAYS, weekLabel } from '@fiscus/shared';
import { and, eq } from 'drizzle-orm';
import { appLink, type MemberRun, money } from './member.js';

// The weekly recap (#128; bills walkthrough §8, D21): at each member's day and hour, in the
// household's time zone, their recap of last week, built in their own context (it refuses any
// other, SYS-02). One notification a week: a short entry in Fiscus and on push channels, and the
// full recap by email, rendered at each detail level (D17). A quiet week still sends.

export interface RecapOptions {
  /** The weekday and hour there now. */
  weekday: string;
  /** The server's address, for the email's "Open Fiscus"; null without one. */
  publicUrl: string | null;
}

/** Sends the member's recap of last week once they've reached their day and hour; 1 if it did. */
export async function weeklyRecap(m: MemberRun, o: RecapOptions): Promise<number> {
  if (!m.on('weekly_recap')) return 0;
  const { day, hour } = m.settings('weekly_recap');
  if (!WEEKDAYS.includes(day) || o.weekday !== day || m.hour < hour) return 0;
  const weekStart = lastWeekStart(m.today, m.weekStartDay);
  const dedupeKey = `weekly_recap:${weekStart}`;
  const [already] = await m.tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.memberId, m.memberId), eq(notifications.dedupeKey, dedupeKey)));
  if (already) return 0;
  const recap = await buildWeeklyRecap(m.tx, {
    memberId: m.memberId,
    weekStart,
    today: m.today,
  });
  const link = appLink(m.householdId);
  const url = o.publicUrl ? new URL(link, o.publicUrl).toString() : undefined;
  const email = Object.fromEntries(
    DETAIL_LEVELS.map((detail) => [
      detail,
      renderWeeklyRecapEmail(recap, { detail, ...(url ? { url } : {}) }),
    ]),
  ) as Record<(typeof DETAIL_LEVELS)[number], ReturnType<typeof renderWeeklyRecapEmail>>;
  const review = recap.toReview
    ? `, ${recap.toReview} transaction${recap.toReview === 1 ? '' : 's'} to review`
    : '';
  const sent = await m.notify({
    kind: 'weekly_recap',
    dedupeKey,
    title: `Your week, ${weekLabel(recap.weekStart, recap.weekEnd)}`,
    body: recap.quiet
      ? 'A quiet week: nothing spent, nothing coming up. The recap is on your dashboard.'
      : `${money(recap.spending.spentMinor, recap.currency)} spent${review}. The recap is on your dashboard.`,
    summary: 'Your weekly recap is ready.',
    link,
    email,
  });
  return sent ? 1 : 0;
}
