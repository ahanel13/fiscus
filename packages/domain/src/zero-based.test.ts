// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { type BudgetCategory, type BudgetDefinition, computeBudgetMonth } from './budget.js';
import { STRATEGY_REGISTRY } from './strategies.js';
import type { ZeroBasedView } from './zero-based.js';

const cat = (id: string, kind: BudgetCategory['kind'], rollover = false) => ({
  id,
  kind,
  rollover,
  bucket: null,
  yearlyMinor: null,
});
const map = (o: Record<string, number>) => new Map(Object.entries(o));
const month = (spent: Record<string, number>, incomeMinor = 0, contributionsMinor = 0) => ({
  spentMinor: map(spent),
  incomeMinor,
  incomeByCategory: map(incomeMinor ? { paychecks: incomeMinor } : {}),
  contributionsMinor,
});

// The walkthrough's zero-based screen (§3.2), smaller: contributions are Ours' money in.
const budget: BudgetDefinition = {
  startsMonth: '2026-09',
  periods: [{ fromMonth: '2026-09', kind: 'zero_based', settings: {} }],
  categories: [
    cat('rent', 'fixed'),
    cat('groceries', 'flexible'),
    cat('restaurants', 'flexible'),
    cat('pets', 'flexible'),
    cat('paychecks', 'income'),
    cat('transfer', 'transfer'),
  ],
  amounts: new Map([
    ['2026-09', map({ rent: 215000, groceries: 70000, restaurants: 25000 })],
    ['2026-10', map({ rent: 215000, groceries: 70000, restaurants: 25000, pets: 9000 })],
  ]),
};
const ledger = new Map([
  ['2026-09', month({ rent: 215000, groceries: 65000, restaurants: 20000 }, 0, 320000)],
  [
    '2026-10',
    month({ rent: 215000, groceries: 61248, restaurants: 29130, pets: 13162 }, 0, 320000),
  ],
]);
const view = (m: string, b = budget, l = ledger) =>
  computeBudgetMonth(b, m, l, STRATEGY_REGISTRY).view as ZeroBasedView;

describe('zero-based', () => {
  it('gives every dollar that came in a job: ready to assign is what’s left', () => {
    const v = view('2026-09');
    expect(v.ready).toEqual({
      carriedMinor: 0,
      cameInMinor: 320000,
      overspentMinor: 0,
      assignedMinor: 310000,
      readyMinor: 10000,
    });
    expect(v.rows.find((r) => r.categoryId === 'groceries')).toMatchObject({
      budgetedMinor: 70000,
      spentMinor: 65000,
      leftMinor: 5000,
    });
  });

  it('rolls every envelope over, and carries what wasn’t assigned (D9)', () => {
    const v = view('2026-10');
    // Groceries kept $50 from September; restaurants $50 too.
    expect(v.rows.find((r) => r.categoryId === 'groceries')).toMatchObject({
      rolledInMinor: 5000,
      leftMinor: 5000 + 70000 - 61248,
    });
    expect(v.ready.carriedMinor).toBe(10000);
    expect(v.ready.readyMinor).toBe(10000 + 320000 - 319000);
    // Restaurants used what it kept; pets is over.
    expect(v.rows.find((r) => r.categoryId === 'restaurants')?.leftMinor).toBe(870);
    expect(v.totals.overCount).toBe(1);
    expect(v.totals.overspentMinor).toBe(13162 - 9000);
  });

  it('takes overspending nobody covered out of next month, and starts the envelope at zero', () => {
    const next = new Map([...ledger, ['2026-11', month({}, 0, 320000)]]);
    const v = view('2026-11', budget, next);
    const october = view('2026-10');
    expect(v.ready.overspentMinor).toBe(october.totals.overspentMinor);
    expect(v.rows.find((r) => r.categoryId === 'pets')).toBeUndefined();
    expect(v.rows.find((r) => r.categoryId === 'groceries')?.rolledInMinor).toBe(
      october.rows.find((r) => r.categoryId === 'groceries')!.leftMinor,
    );
  });

  it('assigns afresh each month: nothing repeats until it’s assigned', () => {
    const next = new Map([...ledger, ['2026-11', month({ groceries: 2000 }, 0, 320000)]]);
    const v = view('2026-11', budget, next);
    expect(v.assigned).toBe(false);
    expect(v.ready.assignedMinor).toBe(0);
    expect(v.rows.find((r) => r.categoryId === 'groceries')?.budgetedMinor).toBe(0);
  });

  it('covers an overspent category by moving money from another', () => {
    const moved: BudgetDefinition = {
      ...budget,
      moves: new Map([['2026-10', map({ groceries: -4162, pets: 4162 })]]),
    };
    const v = view('2026-10', moved);
    expect(v.rows.find((r) => r.categoryId === 'pets')).toMatchObject({
      movedMinor: 4162,
      leftMinor: 0,
    });
    // Moving doesn't change what's ready to assign.
    expect(v.ready.readyMinor).toBe(view('2026-10').ready.readyMinor);
  });

  it('takes contributions out of your own budget: they go to the household’s (D2)', () => {
    const mine: BudgetDefinition = { ...budget, scope: 'mine' };
    const own = new Map([['2026-09', month({}, 500000, 260000)]]);
    expect(view('2026-09', mine, own).ready.cameInMinor).toBe(240000);
  });

  it('assigns to a goal’s line, and keeps what’s not moved yet (G5)', () => {
    const withGoal: BudgetDefinition = {
      ...budget,
      goals: [
        {
          id: 'japan',
          kind: 'save',
          plans: map({ '2026-09': 45000 }),
          fromMonth: '2026-09',
          untilMonth: null,
        },
      ],
      amounts: new Map([['2026-09', map({ rent: 215000 })]]),
    };
    const l = new Map([
      ['2026-09', { ...month({ rent: 215000 }, 0, 320000), goalMovedMinor: map({ japan: 30000 }) }],
    ]);
    const v = view('2026-09', withGoal, l);
    expect(v.goals).toEqual([
      {
        goalId: 'japan',
        budgetedMinor: 45000,
        movedMinor: 0,
        rolledInMinor: 0,
        sentMinor: 30000,
        leftMinor: 15000,
      },
    ]);
    expect(v.ready.assignedMinor).toBe(260000);
    // Its to-move balance rolls over.
    const october = view('2026-10', withGoal, l);
    expect(october.goals[0]?.rolledInMinor).toBe(15000);
  });

  it('starts from what category limits carried, after a switch (D14)', () => {
    const switched: BudgetDefinition = {
      ...budget,
      categories: budget.categories.map((c) =>
        c.id === 'groceries' ? { ...c, rollover: true } : c,
      ),
      periods: [
        { fromMonth: '2026-09', kind: 'category', settings: {} },
        { fromMonth: '2026-10', kind: 'zero_based', settings: {} },
      ],
    };
    const v = view('2026-10', switched);
    expect(v.rows.find((r) => r.categoryId === 'groceries')?.rolledInMinor).toBe(5000);
    expect(v.ready.carriedMinor).toBe(0);
  });
});
