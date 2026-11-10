// SPDX-License-Identifier: AGPL-3.0-or-later

// The short-term cash-flow forecast (#166, ADR 0010 §1, planning walkthrough §1–§3): each cash
// account's and card's balance, day by day, from today's balance and what's known to come: the
// confirmed bills and paychecks (P1), card statements paid the way they usually are (P3), and
// everyday spending spread over the days (P2). A pure function: the api works it out when asked,
// and the worker each morning for warnings (P9).

/** `YYYY-MM-DD`. */
export type Day = string;

const DAY_MS = 86_400_000;
const time = (d: Day) => Date.parse(`${d}T00:00:00Z`);
const day = (t: number): Day => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: Day, n: number): Day => day(time(d) + n * DAY_MS);
const monthOf = (d: Day) => d.slice(0, 7);
const lastOfMonth = (d: Day): Day => day(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0));

export interface ForecastAccount {
  id: string;
  /** A card's balance is what it owes, as a negative; a cash account's, what it holds. */
  kind: 'cash' | 'card';
  /** Today's balance, from the bank, before anything below. */
  balanceMinor: number;
}

/** Something known to come: a bill, paycheck, subscription or transfer (P1). */
export interface ForecastEvent {
  accountId: string;
  date: Day;
  /** Signed as the account sees it: money in is positive. */
  amountMinor: number;
  kind: 'income' | 'bill' | 'subscription' | 'transfer';
  name: string;
  /** Why this amount, in words (P6): "like last December". */
  reason: string;
  /** A transfer between two accounts in the forecast: the other side, which gets the opposite. */
  toAccountId?: string | null;
  /** The series it comes from, for linking. */
  seriesId?: string | null;
}

/** How a card's statements are paid, by the last three (P3). */
export type PayStyle =
  { kind: 'full' } | { kind: 'minimum' } | { kind: 'fixed'; amountMinor: number };

/** A card, and how its statements come and are paid (P3). */
export interface ForecastCard {
  accountId: string;
  /** Where its statements are paid from; null when it isn't an account in the forecast. */
  payFromAccountId: string | null;
  payStyle: PayStyle;
  /** The statement the bank last sent, still to be paid, if any. */
  statement: {
    dueDate: Day;
    /** What it owed, positive. */
    balanceMinor: number;
    minimumMinor: number | null;
    /** What's gone into the card since it was sent. */
    paidSoFarMinor: number;
  } | null;
  /** When later statements close, and when each is due: the bank's last ones, a month apart. */
  later: readonly { closeDate: Day; dueDate: Day }[];
  /** A later statement's minimum, from what it owes (the bank's rule, or an estimate). */
  minimumOf: (owedMinor: number) => number;
}

/** Everyday spending from one account (P2): an amount over a run of days, spread evenly. */
export interface ForecastSpending {
  accountId: string;
  /** The first and last day it's spread over, both included. */
  from: Day;
  to: Day;
  /** Money out, positive: what's left of the budget, or the recent average. */
  totalMinor: number;
}

export interface ForecastInput {
  today: Day;
  /** How many days after today: 30, 60 or 90 (up to a year, ADR 0010 §1). */
  days: number;
  accounts: readonly ForecastAccount[];
  events: readonly ForecastEvent[];
  cards: readonly ForecastCard[];
  spending: readonly ForecastSpending[];
}

/** One thing on the list of what's ahead, with the balance after it (§1). */
export interface ForecastLine {
  accountId: string;
  date: Day;
  amountMinor: number;
  kind: ForecastEvent['kind'] | 'statement';
  name: string;
  reason: string;
  seriesId: string | null;
  /** The account's balance once this has happened. */
  balanceAfterMinor: number;
}

export interface AccountForecast {
  accountId: string;
  todayMinor: number;
  /** The balance at the end of each day, today first. */
  daily: { date: Day; balanceMinor: number }[];
  /** What's ahead, in order; everyday spending isn't listed (§1). */
  lines: ForecastLine[];
  lowest: { date: Day; balanceMinor: number };
  endMinor: number;
  /** Totals over the days: money in, money out (spending included), and the spending alone. */
  inMinor: number;
  outMinor: number;
  spendingMinor: number;
}

/**
 * `total` over `n` days in whole minor units that add up exactly: the odd cents go to the first
 * days, so a forecast never runs late on them.
 */
export function spreadEvenly(totalMinor: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.trunc(totalMinor / n);
  let left = totalMinor - base * n;
  const step = Math.sign(left);
  return Array.from({ length: n }, () => {
    if (left === 0) return base;
    left -= step;
    return base + step;
  });
}

type Move = Omit<ForecastLine, 'balanceAfterMinor'>;

export function forecast(input: ForecastInput): Map<string, AccountForecast> {
  const { today } = input;
  const end = addDays(today, input.days);
  const inRange = (d: Day) => d >= today && d <= end;

  const balance = new Map(input.accounts.map((a) => [a.id, a.balanceMinor]));
  const moves = new Map<Day, Move[]>();
  const add = (m: Move) => {
    if (!balance.has(m.accountId) || !inRange(m.date)) return;
    moves.set(m.date, [...(moves.get(m.date) ?? []), m]);
  };
  for (const e of input.events) {
    const line = {
      date: e.date,
      kind: e.kind,
      name: e.name,
      reason: e.reason,
      seriesId: e.seriesId ?? null,
    };
    add({ ...line, accountId: e.accountId, amountMinor: e.amountMinor });
    if (e.toAccountId) add({ ...line, accountId: e.toAccountId, amountMinor: -e.amountMinor });
  }

  // Everyday spending: so much a day, per account (P2).
  const spend = new Map<string, Map<Day, number>>();
  for (const s of input.spending) {
    if (!balance.has(s.accountId) || s.to < s.from) continue;
    const n = Math.round((time(s.to) - time(s.from)) / DAY_MS) + 1;
    const parts = spreadEvenly(s.totalMinor, n);
    const byDay = spend.get(s.accountId) ?? new Map<Day, number>();
    parts.forEach((p, i) => {
      const d = addDays(s.from, i);
      if (inRange(d)) byDay.set(d, (byDay.get(d) ?? 0) + p);
    });
    spend.set(s.accountId, byDay);
  }

  // Card statements (P3), worked out as the days go by: a later one is what the card owes when
  // it closes, so it depends on everything before it.
  const closes = new Map<Day, ForecastCard[]>();
  for (const c of input.cards) {
    if (!balance.has(c.accountId)) continue;
    for (const l of c.later) closes.set(l.closeDate, [...(closes.get(l.closeDate) ?? []), c]);
    const st = c.statement;
    if (st && st.dueDate >= today) {
      const left = Math.max(0, st.balanceMinor - st.paidSoFarMinor);
      const minimumLeft = Math.max(0, (st.minimumMinor ?? 0) - st.paidSoFarMinor);
      statementPayment(c, st.dueDate, left, minimumLeft, 'the statement from the bank');
    }
  }
  function statementPayment(
    c: ForecastCard,
    due: Day,
    owedMinor: number,
    minimumMinor: number,
    what: string,
  ) {
    const amount =
      c.payStyle.kind === 'full'
        ? owedMinor
        : c.payStyle.kind === 'minimum'
          ? minimumMinor
          : Math.min(owedMinor, Math.max(c.payStyle.amountMinor, minimumMinor));
    if (amount <= 0) return;
    const reason =
      c.payStyle.kind === 'full'
        ? `${what}, paid in full as the last 3 were`
        : c.payStyle.kind === 'minimum'
          ? `${what}'s minimum, as the last 3 were`
          : `${what}, the usual payment`;
    const line = { date: due, kind: 'statement' as const, name: 'Card statement', reason };
    add({ ...line, accountId: c.accountId, amountMinor: amount, seriesId: null });
    if (c.payFromAccountId)
      add({ ...line, accountId: c.payFromAccountId, amountMinor: -amount, seriesId: null });
  }

  const ids = input.accounts.map((a) => a.id);
  const out = new Map<string, AccountForecast>(
    input.accounts.map((a) => [
      a.id,
      {
        accountId: a.id,
        todayMinor: a.balanceMinor,
        daily: [],
        lines: [],
        lowest: { date: today, balanceMinor: a.balanceMinor },
        endMinor: a.balanceMinor,
        inMinor: 0,
        outMinor: 0,
        spendingMinor: 0,
      },
    ]),
  );
  for (let d = today; d <= end; d = addDays(d, 1)) {
    // Money out before money in on the same day: the lower balance is the one to warn about.
    const todays = (moves.get(d) ?? []).sort(
      (a, b) => a.amountMinor - b.amountMinor || a.name.localeCompare(b.name),
    );
    for (const m of todays) {
      const after = balance.get(m.accountId)! + m.amountMinor;
      balance.set(m.accountId, after);
      const f = out.get(m.accountId)!;
      f.lines.push({ ...m, balanceAfterMinor: after });
      if (m.amountMinor > 0) f.inMinor += m.amountMinor;
      else f.outMinor -= m.amountMinor;
    }
    for (const id of ids) {
      const s = spend.get(id)?.get(d) ?? 0;
      const f = out.get(id)!;
      if (s) {
        balance.set(id, balance.get(id)! - s);
        f.outMinor += s;
        f.spendingMinor += s;
      }
      const b = balance.get(id)!;
      f.daily.push({ date: d, balanceMinor: b });
      if (b < f.lowest.balanceMinor) f.lowest = { date: d, balanceMinor: b };
      f.endMinor = b;
    }
    // A statement closing tonight: what the card owes is due later (P3).
    for (const c of closes.get(d) ?? []) {
      const owed = Math.max(0, -balance.get(c.accountId)!);
      const l = c.later.find((x) => x.closeDate === d)!;
      if (owed > 0) statementPayment(c, l.dueDate, owed, c.minimumOf(owed), 'the next statement');
    }
  }
  return out;
}

/** A dip below someone's warning amount (P7): the first day under it, and how low it goes. */
export interface ForecastDip {
  accountId: string;
  /** The first day it ends below the amount. */
  from: Day;
  /** The lowest point of that dip. */
  lowest: { date: Day; balanceMinor: number };
  /** What takes it there: the money out since the last money in, up to its lowest, largest first. */
  causes: ForecastLine[];
}

/**
 * The first dip below `floorMinor` within `withinDays` of today, or null (P7). A balance already
 * below today counts from today.
 */
export function firstDip(
  f: AccountForecast,
  floorMinor: number,
  withinDays: number,
): ForecastDip | null {
  const last = f.daily[0] ? addDays(f.daily[0].date, withinDays) : null;
  const start = f.daily.findIndex((x) => x.balanceMinor < floorMinor);
  if (start < 0 || !last || f.daily[start]!.date > last) return null;
  let lowest = f.daily[start]!;
  for (let i = start; i < f.daily.length && f.daily[i]!.balanceMinor < floorMinor; i++)
    if (f.daily[i]!.balanceMinor < lowest.balanceMinor) lowest = f.daily[i]!;
  const from = f.daily[start]!.date;
  let after = -1;
  f.lines.forEach((l, i) => {
    if (l.amountMinor > 0 && l.date <= from) after = i;
  });
  const causes = f.lines
    .filter((l, i) => i > after && l.amountMinor < 0 && l.date <= lowest.date)
    .sort((a, b) => a.amountMinor - b.amountMinor);
  return {
    accountId: f.accountId,
    from,
    lowest: { date: lowest.date, balanceMinor: lowest.balanceMinor },
    causes,
  };
}

/**
 * Everyday spending for the forecast (P2): each category's budget left this month and its
 * budgets after, less the bills already forecast in it, spread from the accounts it's usually
 * paid from (their shares in basis points, adding to 10 000).
 */
export interface SpendingCategory {
  /** What's left to spend this month, positive; and each later month's budget. */
  leftThisMonthMinor: number;
  laterMonthsMinor: ReadonlyMap<string, number>;
  /** Bills in the forecast that this category's budget already includes, per month (`YYYY-MM`). */
  billsMinor: ReadonlyMap<string, number>;
  accounts: ReadonlyMap<string, number>;
}

export function everydaySpending(
  today: Day,
  days: number,
  categories: readonly SpendingCategory[],
): ForecastSpending[] {
  const end = addDays(today, days);
  const totals = new Map<string, number>(); // `${accountId}|${from}|${to}`
  for (const c of categories) {
    for (let start = today; start <= end; start = addDays(lastOfMonth(start), 1)) {
      const month = monthOf(start);
      const budget = start === today ? c.leftThisMonthMinor : (c.laterMonthsMinor.get(month) ?? 0);
      const left = Math.max(0, budget - (c.billsMinor.get(month) ?? 0));
      if (left === 0) continue;
      const to = lastOfMonth(start);
      const sum = [...c.accounts.values()].reduce((a, b) => a + b, 0);
      if (sum <= 0) continue;
      let given = 0;
      const entries = [...c.accounts.entries()];
      entries.forEach(([accountId, bps], i) => {
        const part = i === entries.length - 1 ? left - given : Math.round((left * bps) / sum);
        given += part;
        const key = `${accountId}|${start}|${to}`;
        totals.set(key, (totals.get(key) ?? 0) + part);
      });
    }
  }
  return [...totals].map(([key, totalMinor]) => {
    const [accountId, from, to] = key.split('|') as [string, Day, Day];
    return { accountId, from, to, totalMinor };
  });
}
