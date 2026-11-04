// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accounts,
  balanceSnapshots,
  budgets,
  categories,
  syncHolds,
  transactions,
} from '@fiscus/db';
import { computeBudgetMonth, STRATEGY_REGISTRY } from '@fiscus/domain';
import {
  accessLevels,
  budgetActivity,
  cardStatementsDue,
  loadBudgetDefinition,
  seriesOccurrences,
} from '@fiscus/ledger';
import { addDays } from '@fiscus/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { appLink, longDate, type MemberRun, money, weekOf, when } from './member.js';

// The rules (#127; bills walkthrough D18–D20). Each looks at one member's own view of the
// household (their database context: SYS-02) and writes what's due for them. Each notification's
// key names the occurrence and the rule, so running a rule again, or after a restart, sends
// nothing twice (D20). The weekly recap (#128) is in recap.ts.

/** How far back a late bill or paycheck is still worth saying. */
export const LATE_LOOKBACK_DAYS = 30;
/** How far ahead low balance looks (D19). */
export const LOW_BALANCE_DAYS = 14;
/** How old a big transaction can be and still be news: a big import of history isn't. */
export const BIG_TRANSACTION_MAX_AGE_DAYS = 7;

/**
 * A bill is due (D13, D18): its date is within the days before they asked for, on a bill or
 * subscription they look after, and nothing has paid it yet. One that's paid before its reminder
 * isn't reminded about (D20).
 */
export async function billDue(m: MemberRun): Promise<number> {
  if (!m.on('bill_due')) return 0;
  const { daysBefore } = m.settings('bill_due');
  const until = addDays(m.today, daysBefore);
  const all = await seriesOccurrences(m.tx, {
    start: m.today,
    end: until,
    lateFrom: m.today,
    today: m.today,
  });
  let sent = 0;
  for (const { series: s, occurrences } of all) {
    if (s.kind !== 'bill' && s.kind !== 'subscription') continue;
    const account = await accountName(m, s.accountId);
    for (const o of occurrences) {
      if (o.status !== 'due' || !o.memberIds.includes(m.memberId)) continue;
      const about = o.expectedMinor === null ? '' : `About ${money(o.expectedMinor, o.currency)}, `;
      if (
        await m.notify({
          kind: 'bill_due',
          dedupeKey: `bill_due:${s.id}:${o.due}`,
          title: `${s.name} is due ${when(o.due, m.today)}`,
          body: `${about}${about ? 'from' : 'From'} ${account}.`,
          summary: 'A bill is due soon.',
          link: appLink(m.householdId, 'recurring'),
        })
      ) {
        sent++;
      }
    }
  }
  return sent;
}

const accountName = async (m: MemberRun, id: string) =>
  (await m.tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, id)))[0]?.name ??
  'an account';

/**
 * A bill or paycheck is late (D12, D18): the days after they chose have gone by with nothing
 * paying it. A bill goes to whoever looks after it; a paycheck to whoever it's for.
 */
export async function late(m: MemberRun): Promise<number> {
  if (!m.on('late')) return 0;
  const { daysAfter } = m.settings('late');
  const from = addDays(m.today, -LATE_LOOKBACK_DAYS);
  const all = await seriesOccurrences(m.tx, {
    start: from,
    end: m.today,
    lateFrom: from,
    today: m.today,
  });
  let sent = 0;
  for (const { series: s, occurrences } of all) {
    if (s.kind === 'transfer') continue;
    const account = await accountName(m, s.accountId);
    for (const o of occurrences) {
      if (o.status === 'paid' || o.status === 'skipped') continue;
      if (!o.memberIds.includes(m.memberId) || addDays(o.due, daysAfter) > m.today) continue;
      const paycheck = s.kind === 'income';
      const about =
        o.expectedMinor === null ? '' : ` (about ${money(o.expectedMinor, o.currency)})`;
      if (
        await m.notify({
          kind: 'late',
          dedupeKey: `late:${s.id}:${o.due}`,
          title: paycheck ? `${s.name} hasn’t come in` : `${s.name} hasn’t been paid`,
          body: paycheck
            ? `It was expected ${longDate(o.due)}${about}, into ${account}.`
            : `It was due ${longDate(o.due)}${about}, from ${account}. If it was paid another way, mark it paid in Fiscus.`,
          summary: paycheck ? 'A paycheck is late.' : 'A bill is late.',
          link: appLink(m.householdId, 'recurring'),
        })
      ) {
        sent++;
      }
    }
  }
  return sent;
}

/** A card statement is due (D9, D18): on cards they own, not paid in full, within their days. */
export async function statementDue(m: MemberRun): Promise<number> {
  if (!m.on('statement_due')) return 0;
  const { daysBefore } = m.settings('statement_due');
  let sent = 0;
  for (const st of await cardStatementsDue(m.tx, {
    memberId: m.memberId,
    today: m.today,
    withinDays: daysBefore,
  })) {
    const minimum =
      st.minimumMinor !== null && st.minimumMinor > 0
        ? `, ${money(st.minimumMinor, st.currency)} at least`
        : '';
    if (
      await m.notify({
        kind: 'statement_due',
        dedupeKey: `statement_due:${st.accountId}:${st.due}`,
        title: `${st.accountName} statement is due ${when(st.due, m.today)}`,
        body: `${money(st.owedMinor - st.paidSoFarMinor, st.currency)} to pay${minimum}.`,
        summary: 'A card statement is due soon.',
        link: appLink(m.householdId, 'recurring'),
      })
    ) {
      sent++;
    }
  }
  return sent;
}

/**
 * Low balance (D18, D19): an account they picked is under their amount now, or could be in the
 * next 2 weeks, from today's balance and the confirmed bills and paychecks due on it before then.
 * Once a week at most for each account, while it stays low.
 */
export async function lowBalance(m: MemberRun): Promise<number> {
  if (!m.on('low_balance')) return 0;
  const { accountIds, underMinor } = m.settings('low_balance');
  if (accountIds.length === 0) return 0;
  const levels = await accessLevels(m.tx);
  const seen = accountIds.filter((id) => levels.has(id));
  if (seen.length === 0) return 0;
  const rows = await m.tx
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(inArray(accounts.id, seen));
  const until = addDays(m.today, LOW_BALANCE_DAYS);
  // What's coming: the confirmed series they can see, as they're expected.
  const coming = (
    await seriesOccurrences(m.tx, {
      start: addDays(m.today, 1),
      end: until,
      lateFrom: addDays(m.today, 1),
      today: m.today,
    })
  ).flatMap((d) => d.occurrences);
  let sent = 0;
  for (const a of rows) {
    const [snap] = await m.tx
      .select({ balanceMinor: balanceSnapshots.balanceMinor })
      .from(balanceSnapshots)
      .where(and(eq(balanceSnapshots.accountId, a.id), lte(balanceSnapshots.asOf, m.today)))
      .orderBy(desc(balanceSnapshots.asOf))
      .limit(1);
    if (!snap) continue;
    const flows = coming
      .filter((o) => o.accountId === a.id && o.status === 'due' && o.expectedMinor !== null)
      .sort((x, y) => x.due.localeCompare(y.due));
    let balance = snap.balanceMinor;
    let lowest = { minor: balance, due: m.today };
    for (const f of flows) {
      balance += f.expectedMinor!;
      if (balance < lowest.minor) lowest = { minor: balance, due: f.due };
    }
    const now = snap.balanceMinor < underMinor;
    if (!now && lowest.minor >= underMinor) continue;
    const under = money(underMinor, a.currency);
    if (
      await m.notify({
        kind: 'low_balance',
        dedupeKey: `low_balance:${a.id}:${weekOf(m.today)}`,
        title: now ? `${a.name} is under ${under}` : `${a.name} could go under ${under}`,
        body: now
          ? `It’s at ${money(snap.balanceMinor, a.currency)}${snap.balanceMinor < 0 ? ' overdrawn' : ''}.`
          : `With the bills and paychecks you’ve confirmed, it could be at ${money(lowest.minor, a.currency)}${lowest.minor < 0 ? ' overdrawn' : ''} on ${longDate(lowest.due)}.`,
        summary: 'An account’s balance is low.',
        link: appLink(m.householdId, `accounts/${a.id}`),
      })
    ) {
      sent++;
    }
  }
  return sent;
}

/**
 * A budget category is nearly spent (D18): in their budgets (the household's, and their own),
 * once a category reaches their percentage of what it has this month. Once a month for each.
 */
export async function budgetNearlySpent(m: MemberRun): Promise<number> {
  if (!m.on('budget_nearly_spent')) return 0;
  const { percent } = m.settings('budget_nearly_spent');
  const month = m.today.slice(0, 7);
  const rows = await m.tx.select().from(budgets);
  const names = new Map(
    (await m.tx.select({ id: categories.id, name: categories.name }).from(categories)).map((c) => [
      c.id,
      c.name,
    ]),
  );
  let sent = 0;
  for (const row of rows) {
    if (row.memberId !== null && row.memberId !== m.memberId) continue;
    const startsMonth = row.startsMonth.slice(0, 7);
    if (month < startsMonth) continue;
    const scope = row.memberId ? 'mine' : 'household';
    const definition = await loadBudgetDefinition(m.tx, row);
    const activity = await budgetActivity(
      m.tx,
      { householdId: m.householdId, memberId: m.memberId },
      scope,
      startsMonth,
      month,
    );
    const out = computeBudgetMonth(definition, month, activity, STRATEGY_REGISTRY);
    const limits: { key: string; name: string; spent: number; has: number }[] = [];
    if (out.kind === 'flex') {
      const v = out.view as {
        fixed: { categoryId: string; budgetedMinor: number; spentMinor: number }[];
        flexible: { budgetedMinor: number; spentMinor: number };
      };
      for (const r of v.fixed) {
        limits.push({
          key: r.categoryId,
          name: names.get(r.categoryId) ?? 'A category',
          spent: r.spentMinor,
          has: r.budgetedMinor,
        });
      }
      limits.push({
        key: 'flexible',
        name: 'Flexible spending',
        spent: v.flexible.spentMinor,
        has: v.flexible.budgetedMinor,
      });
    } else {
      const v = out.view as {
        rows: {
          categoryId: string;
          budgetedMinor: number;
          rolledInMinor: number;
          movedMinor?: number;
          spentMinor: number;
        }[];
      };
      // Category limits and zero-based alike: what the category had to spend this month.
      for (const r of v.rows) {
        limits.push({
          key: r.categoryId,
          name: names.get(r.categoryId) ?? 'A category',
          spent: r.spentMinor,
          has: r.budgetedMinor + r.rolledInMinor + (r.movedMinor ?? 0),
        });
      }
    }
    for (const l of limits) {
      if (l.has <= 0 || l.spent * 100 < l.has * percent) continue;
      const share = Math.round((l.spent / l.has) * 100);
      const whose = scope === 'mine' ? 'your budget' : 'the household’s budget';
      if (
        await m.notify({
          kind: 'budget_nearly_spent',
          dedupeKey: `budget_nearly_spent:${row.id}:${l.key}:${month}`,
          title:
            share >= 100 ? `${l.name} is over budget` : `${l.name} is at ${share}% of its budget`,
          body: `${money(l.spent, m.currency)} of ${money(l.has, m.currency)} spent this month, in ${whose}.`,
          summary: 'A budget category is nearly spent.',
          link: appLink(m.householdId, 'budget'),
        })
      ) {
        sent++;
      }
    }
  }
  return sent;
}

/**
 * Transactions to review (D18): once a day at the hour they chose, if any are waiting in
 * accounts they can review (owner or full access, as the review queue counts them).
 */
export async function review(m: MemberRun): Promise<number> {
  if (!m.on('review') || m.role === 'viewer') return 0;
  const { hour } = m.settings('review');
  if (m.hour < hour) return 0;
  const levels = await accessLevels(m.tx);
  const reviewable = [...levels].filter(([, l]) => l === 'owner' || l === 'full').map(([id]) => id);
  if (reviewable.length === 0) return 0;
  const [row] = await m.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.reviewStatus, 'needs_review'),
        isNull(transactions.deletedAt),
        eq(transactions.hasSplits, false),
        inArray(transactions.accountId, reviewable),
      ),
    );
  // Possible duplicates from a bank (#80): row-level security shows only yours.
  const [held] = await m.tx.select({ n: sql<number>`count(*)::int` }).from(syncHolds);
  const n = (row?.n ?? 0) + (held?.n ?? 0);
  if (n === 0) return 0;
  const sent = await m.notify({
    kind: 'review',
    dedupeKey: `review:${m.today}`,
    title: n === 1 ? '1 transaction to review' : `${n} transactions to review`,
    body: 'They’re waiting in Review.',
    summary: 'Transactions are waiting for review.',
    link: appLink(m.householdId, 'review'),
  });
  return sent ? 1 : 0;
}

/**
 * A big transaction (D18): money out over their amount, in the household's currency, on accounts
 * whose transactions they see, written since `since` (by a sync, an import, or by hand). Not
 * pending ones (the posted one follows), transfers between accounts, or ones more than a week old.
 */
export async function bigTransactions(m: MemberRun, since: Date): Promise<number> {
  if (!m.on('big_transaction')) return 0;
  const { overMinor } = m.settings('big_transaction');
  const rows = await m.tx
    .select({
      id: transactions.id,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      name: transactions.displayName,
      date: transactions.effectiveDate,
      account: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        gt(transactions.createdAt, since),
        isNull(transactions.deletedAt),
        isNull(transactions.parentId),
        isNull(transactions.transferGroupId),
        eq(transactions.pending, false),
        eq(transactions.excluded, false),
        eq(transactions.isSettlement, false),
        eq(transactions.currency, m.currency),
        lte(transactions.amountMinor, -overMinor),
        gte(transactions.effectiveDate, addDays(m.today, -BIG_TRANSACTION_MAX_AGE_DAYS)),
      ),
    )
    .orderBy(asc(transactions.createdAt))
    .limit(50);
  let sent = 0;
  for (const t of rows) {
    if (
      await m.notify({
        kind: 'big_transaction',
        dedupeKey: `big_transaction:${t.id}`,
        title: `${money(t.amountMinor, t.currency)} at ${t.name}`,
        body: `On ${t.account}, ${longDate(t.date!)}.`,
        summary: 'A big purchase was made on one of your accounts.',
        link: appLink(m.householdId, 'transactions'),
      })
    ) {
      sent++;
    }
  }
  return sent;
}

/** The daily rules, in the order they run. */
/**
 * A new subscription, or a price went up (D14, D18): once per change, to everyone who sees the
 * series (row-level security: their own context). A price rise is keyed by the payment it started
 * with, so a second rise later is news again; a new subscription, once.
 */
export async function subscriptionChange(m: MemberRun): Promise<number> {
  if (!m.on('subscription_change')) return 0;
  let sent = 0;
  for (const { series: s, changes, currency, estimate } of await seriesOccurrences(m.tx, {
    start: m.today,
    end: m.today,
    lateFrom: m.today,
    today: m.today,
  })) {
    if (s.endedOn !== null && s.endedOn < m.today) continue;
    if (changes.priceUp) {
      const { changeMinor, since } = changes.priceUp;
      if (
        await m.notify({
          kind: 'subscription_change',
          dedupeKey: `subscription_change:price:${s.id}:${since}`,
          title: `${s.name} went up ${money(changeMinor, currency)}`,
          body: `Since ${longDate(since)}${estimate === null ? '' : `, it’s about ${money(Math.abs(estimate), currency)} now`}.`,
          summary: 'A price went up.',
          link: appLink(m.householdId, 'recurring'),
        })
      ) {
        sent++;
      }
    }
    if (changes.isNew) {
      if (
        await m.notify({
          kind: 'subscription_change',
          dedupeKey: `subscription_change:new:${s.id}`,
          title: `${s.name} looks like a new subscription`,
          body:
            estimate === null
              ? 'Fiscus will say when it’s next due.'
              : `About ${money(Math.abs(estimate), currency)} each time.`,
          summary: 'A new subscription.',
          link: appLink(m.householdId, 'recurring'),
        })
      ) {
        sent++;
      }
    }
  }
  return sent;
}

export const DAILY_RULES = [
  billDue,
  late,
  statementDue,
  lowBalance,
  budgetNearlySpent,
  subscriptionChange,
] as const;
