// SPDX-License-Identifier: AGPL-3.0-or-later
import { householdMembers } from '@fiscus/db';
import { addMonths } from '@fiscus/domain';
import { buildSharedCosts } from '@fiscus/ledger';
import { type SharedCosts, type SharedExpenseLine, WEEKDAYS } from '@fiscus/shared';
import { isNull } from 'drizzle-orm';
import { appLink, type MemberRun, money, weekOf } from './member.js';

// Settle-up reminders and the monthly summary (#116). Each is built from the member's own Shared
// costs (buildSharedCosts, in their own context), so it says only what that page shows them: their
// balance with one other person, from the expenses they're part of (ADR 0006 F1, SYS-02). It goes
// to the two people in a pair, each from their side; nobody else hears about it. One per pair:
// a reminder once a week, a summary once a month, named in its key (D20).

/** How far into a month its summary of the month before is still sent, after a restart. */
export const SUMMARY_DAYS = 7;

/** The other current members, by id: their names. Someone who has left isn't settled with here. */
async function others(m: MemberRun): Promise<Map<string, string>> {
  const rows = await m.tx
    .select({ id: householdMembers.id, name: householdMembers.displayName })
    .from(householdMembers)
    .where(isNull(householdMembers.leftAt));
  return new Map(rows.filter((r) => r.id !== m.memberId).map((r) => [r.id, r.name]));
}

const balanceWith = (costs: SharedCosts, memberId: string) =>
  costs.balances.find((b) => b.memberId === memberId)?.amountMinor ?? 0;

/** "Sam owes you $42.10", "you owe Sam $42.10", "you’re square". */
function standing(name: string, balanceMinor: number, currency: string): string {
  if (balanceMinor > 0) return `${name} owes you ${money(balanceMinor, currency)}`;
  if (balanceMinor < 0) return `you owe ${name} ${money(balanceMinor, currency)}`;
  return 'you’re square';
}

const capitalized = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

/**
 * A settle-up reminder: on their day, from the daily hour, to each of the two people whose
 * balance is at least their amount, from their side. Once a week for each pair, while it stays.
 */
export async function settleUpReminder(m: MemberRun): Promise<number> {
  if (!m.settlesUp || !m.on('settle_up_reminder')) return 0;
  const { day, overMinor } = m.settings('settle_up_reminder');
  if (!WEEKDAYS.includes(day) || m.weekday !== day) return 0;
  const names = await others(m);
  const costs = await buildSharedCosts(m.tx, {
    memberId: m.memberId,
    month: m.today.slice(0, 7),
  });
  let sent = 0;
  for (const [other, name] of names) {
    const balance = balanceWith(costs, other);
    if (Math.abs(balance) < overMinor) continue;
    if (
      await m.notify({
        kind: 'settle_up_reminder',
        dedupeKey: `settle_up_reminder:${other}:${weekOf(m.today)}`,
        title: capitalized(standing(name, balance, costs.currency)),
        body:
          balance < 0
            ? 'Once you’ve paid, record it in Shared costs.'
            : `Once ${name} has paid you, record it in Shared costs.`,
        summary: 'You’re not square with someone you share costs with.',
        link: appLink(m.householdId, 'shared'),
      })
    ) {
      sent++;
    }
  }
  return sent;
}

/**
 * The monthly summary: early in a month, for the month before, to each of the two people whose
 * shared expenses moved money between them, who settled up, or who ended it owing. One for each
 * pair, from their side.
 */
export async function settleUpSummary(m: MemberRun): Promise<number> {
  if (!m.settlesUp || !m.on('settle_up_summary')) return 0;
  if (Number(m.today.slice(8, 10)) > SUMMARY_DAYS) return 0;
  const month = addMonths(m.today.slice(0, 7), -1);
  const names = await others(m);
  if (names.size === 0) return 0;
  const costs = await buildSharedCosts(m.tx, { memberId: m.memberId, month });
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
  const c = costs.currency;
  let sent = 0;
  for (const [other, name] of names) {
    const balance = balanceWith(costs, other);
    // What moved money between the two of them: not what evened out, or was between others.
    const between = (e: SharedExpenseLine) => e.effect.some((x) => x.memberId === other);
    const lines = costs.expenses.filter(between);
    const settled = costs.settlements.filter(
      (s) =>
        (s.fromMemberId === other && s.toMemberId === m.memberId) ||
        (s.fromMemberId === m.memberId && s.toMemberId === other),
    );
    const flagged = costs.disputed.filter(between);
    if (lines.length === 0 && settled.length === 0 && balance === 0) continue;
    const parts: string[] = [];
    if (lines.length > 0) {
      const total = lines.reduce((s, l) => s + l.costMinor, 0);
      parts.push(
        `${lines.length} shared expense${lines.length === 1 ? '' : 's'}, ${money(total, c)} in all.`,
      );
    } else {
      parts.push('No shared expenses.');
    }
    if (settled.length > 0) {
      const paid = settled.filter((s) => s.kind !== 'adjustment');
      const adjusted = settled.length - paid.length;
      if (paid.length > 0) {
        parts.push(
          `${money(
            paid.reduce((s, x) => s + x.amountMinor, 0),
            c,
          )} settled up.`,
        );
      }
      if (adjusted > 0) parts.push(`${adjusted} adjustment${adjusted === 1 ? '' : 's'}.`);
    }
    if (flagged.length > 0) {
      parts.push(
        `${flagged.length} flagged, left out until ${flagged.length === 1 ? 'it’s' : 'they’re'} sorted out.`,
      );
    }
    if (
      await m.notify({
        kind: 'settle_up_summary',
        dedupeKey: `settle_up_summary:${other}:${month}`,
        title: `${monthName} with ${name}: ${standing(name, balance, c)}`,
        body: parts.join(' '),
        summary: 'Your monthly shared costs summary is ready.',
        link: appLink(m.householdId, `shared?month=${month}`),
      })
    ) {
      sent++;
    }
  }
  return sent;
}
