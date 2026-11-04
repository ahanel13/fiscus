// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BudgetStrategy, Carry } from './budget.js';

// Zero-based (#100, budgeting walkthrough §3.2): every dollar that comes in gets a job. Ready to
// assign is what's come in, plus what was left unassigned, less what's assigned (D8). Every line
// keeps what's left (D9); overspending still uncovered at the end of a month comes out of the
// next month's Ready to assign, and the line starts again at zero.
//
// A month assigns afresh: amounts don't repeat from the month before, as they do for limits,
// because assigning money that hasn't arrived is how zero-based budgets go wrong (D8).
// "Assign like last month" copies them on purpose.

export interface ZeroBasedRow {
  categoryId: string;
  /** Assigned this month. */
  budgetedMinor: number;
  /** Moved in (positive) or out by Move money and Cover this month. */
  movedMinor: number;
  /** Carried from last month: what was left, never less than zero (D9). */
  rolledInMinor: number;
  spentMinor: number;
  /** Available: `rolledIn + budgeted + moved − spent`; negative is overspent. */
  leftMinor: number;
  rollover: true;
}

/**
 * A goal's line (goals and budgets G5): assigned like a category, and "spent" by moving money to
 * the goal. What's assigned but not moved yet stays, as **to move**.
 */
export interface ZeroBasedGoalRow {
  goalId: string;
  budgetedMinor: number;
  movedMinor: number;
  rolledInMinor: number;
  /** What reached the goal this month. */
  sentMinor: number;
  /** To move: `rolledIn + budgeted + moved − sent`. */
  leftMinor: number;
}

export interface ZeroBasedView {
  rows: ZeroBasedRow[];
  goals: ZeroBasedGoalRow[];
  /** Income categories with money in this month. */
  income: { categoryId: string; receivedMinor: number }[];
  incomeMinor: number;
  contributionsMinor: number;
  ready: {
    /** Left unassigned last month; negative when more was assigned than came in. */
    carriedMinor: number;
    /**
     * Came in this month: income, plus contributions for the household's budget, less them for
     * your own, where they're money leaving for the household's (D2).
     */
    cameInMinor: number;
    /** Last month's overspending nobody covered, taken from this month (D9). */
    overspentMinor: number;
    assignedMinor: number;
    /** `carried + cameIn − overspent − assigned`: below zero is assigned more than there is. */
    readyMinor: number;
  };
  /** Whether this month has amounts of its own; without them nothing's assigned yet. */
  assigned: boolean;
  totals: {
    assignedMinor: number;
    spentMinor: number;
    /** What every line has left, overspent ones counting against it. */
    availableMinor: number;
    overCount: number;
    /** What overspent lines are short by, together. */
    overspentMinor: number;
  };
}

export type ZeroBasedSettings = Record<string, never>;

export const zeroBased: BudgetStrategy<ZeroBasedSettings, ZeroBasedView> = {
  kind: 'zero_based',
  settings: () => ({}),
  month({ scope, categories, goals, amounts, ownAmounts, moves, activity, carry }) {
    const assignedOf = (id: string) => (ownAmounts ? (amounts.get(id) ?? 0) : 0);
    // Last month's lines: what's left carries; what's overspent comes out of Ready to assign.
    let overspent = 0;
    const rolledIn = (id: string) => {
      const b = carry.balances.get(id) ?? 0;
      if (b < 0) overspent -= b;
      return Math.max(b, 0);
    };
    const balances = new Map<string, number>();
    const rows: ZeroBasedRow[] = [];
    const income: ZeroBasedView['income'] = [];
    for (const c of categories) {
      if (c.kind === 'transfer') continue;
      if (c.kind === 'income') {
        const received = activity.incomeByCategory.get(c.id) ?? 0;
        if (received !== 0) income.push({ categoryId: c.id, receivedMinor: received });
        continue;
      }
      const inFromLast = rolledIn(c.id);
      const budgeted = assignedOf(c.id);
      const moved = moves.get(c.id) ?? 0;
      const spent = activity.spentMinor.get(c.id) ?? 0;
      const left = inFromLast + budgeted + moved - spent;
      if (inFromLast === 0 && budgeted === 0 && moved === 0 && spent === 0) continue;
      rows.push({
        categoryId: c.id,
        budgetedMinor: budgeted,
        movedMinor: moved,
        rolledInMinor: inFromLast,
        spentMinor: spent,
        leftMinor: left,
        rollover: true,
      });
      if (left !== 0) balances.set(c.id, left);
    }
    const goalRows: ZeroBasedGoalRow[] = [];
    for (const g of goals) {
      const inFromLast = rolledIn(g.id);
      const budgeted = assignedOf(g.id);
      const moved = moves.get(g.id) ?? 0;
      const sent = activity.goalMovedMinor?.get(g.id) ?? 0;
      const left = inFromLast + budgeted + moved - sent;
      goalRows.push({
        goalId: g.id,
        budgetedMinor: budgeted,
        movedMinor: moved,
        rolledInMinor: inFromLast,
        sentMinor: sent,
        leftMinor: left,
      });
      if (left !== 0) balances.set(g.id, left);
    }
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const assigned =
      sum(rows.map((r) => r.budgetedMinor)) + sum(goalRows.map((g) => g.budgetedMinor));
    const cameIn =
      activity.incomeMinor +
      (scope === 'mine' ? -activity.contributionsMinor : activity.contributionsMinor);
    const ready = carry.unassignedMinor + cameIn - overspent - assigned;
    const lines = [...rows, ...goalRows];
    const out: Carry = { balances, unassignedMinor: ready };
    return {
      view: {
        rows,
        goals: goalRows,
        income,
        incomeMinor: activity.incomeMinor,
        contributionsMinor: activity.contributionsMinor,
        ready: {
          carriedMinor: carry.unassignedMinor,
          cameInMinor: cameIn,
          overspentMinor: overspent,
          assignedMinor: assigned,
          readyMinor: ready,
        },
        assigned: ownAmounts,
        totals: {
          assignedMinor: assigned,
          spentMinor: sum(rows.map((r) => r.spentMinor)),
          availableMinor: sum(lines.map((r) => r.leftMinor)),
          overCount: lines.filter((r) => r.leftMinor < 0).length,
          overspentMinor: sum(lines.map((r) => Math.max(0, -r.leftMinor))),
        },
      },
      carry: out,
    };
  },
};
