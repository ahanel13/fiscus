// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  consentedDebts,
  type Debt,
  netPositions,
  simplifyDebts,
  transfersFor,
} from './simplify.js';

const d = (from: string, to: string, amountMinor: number): Debt => ({ from, to, amountMinor });

/** A small seeded random generator, so failures repeat. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomDebts(rand: () => number, people: number, edges: number): Debt[] {
  const ids = Array.from({ length: people }, (_, i) => `m${i}`);
  const out: Debt[] = [];
  for (let k = 0; k < edges; k++) {
    const a = ids[Math.floor(rand() * people)]!;
    const b = ids[Math.floor(rand() * people)]!;
    if (a === b) continue;
    // Round amounts make groups that cancel out more likely, which is where the search matters.
    out.push(d(a, b, (1 + Math.floor(rand() * 6)) * 1000));
  }
  return out;
}

/** The fewest payments by trying every way to split people into groups that cancel out. */
function bruteForceFewest(debts: readonly Debt[]): number {
  const net = [...netPositions(debts).values()];
  const most = (left: number[]): number => {
    if (left.length === 0) return 0;
    const [first, ...rest] = left;
    let best = 0;
    // Every group containing `first` that cancels out, then the most groups among the rest.
    for (let mask = 0; mask < 1 << rest.length; mask++) {
      const inGroup = rest.filter((_, i) => mask & (1 << i));
      if (inGroup.reduce((s, v) => s + v, first!) !== 0) continue;
      best = Math.max(best, 1 + most(rest.filter((_, i) => !(mask & (1 << i)))));
    }
    return best;
  };
  return net.length - most(net);
}

describe('netPositions', () => {
  it('adds up what each person is owed, less what they owe, and leaves out zeros', () => {
    expect(netPositions([d('ada', 'sam', 4000), d('sam', 'jo', 4000)])).toEqual(
      new Map([
        ['ada', -4000],
        ['jo', 4000],
      ]),
    );
  });
});

describe('simplifyDebts', () => {
  it('pays straight through: Ada pays Jo instead of Ada → Sam → Jo', () => {
    expect(simplifyDebts([d('ada', 'sam', 4000), d('sam', 'jo', 4000)])).toEqual([
      d('ada', 'jo', 4000),
    ]);
  });

  it('cancels a circle out entirely', () => {
    expect(simplifyDebts([d('a', 'b', 1000), d('b', 'c', 1000), d('c', 'a', 1000)])).toEqual([]);
  });

  it('leaves two people as they are, netted', () => {
    expect(simplifyDebts([d('ada', 'sam', 5000), d('sam', 'ada', 2000)])).toEqual([
      d('ada', 'sam', 3000),
    ]);
    expect(simplifyDebts([d('ada', 'sam', 5000), d('sam', 'ada', 5000)])).toEqual([]);
    expect(simplifyDebts([])).toEqual([]);
  });

  it('finds groups that cancel out, where matching largest to largest would not', () => {
    // Nets: a −6, b −5, c −3, e +1, d +6, f +7. Largest first takes 5 payments; {a, d} squares
    // up on its own and {b, c, e, f} in 3, so 4.
    const debts = [d('a', 'd', 600), d('b', 'f', 500), d('c', 'f', 200), d('c', 'e', 100)];
    const plan = simplifyDebts(debts);
    expect(plan).toHaveLength(4);
    expect(plan).toContainEqual(d('a', 'd', 600));
    expect(netPositions(plan)).toEqual(netPositions(debts));
  });

  it('gives the same plan whatever order the balances come in', () => {
    const debts = randomDebts(rng(7), 6, 14);
    const plan = simplifyDebts(debts);
    for (let i = 0; i < 5; i++) {
      const shuffled = [...debts].sort(() => rng(i)() - 0.5);
      expect(simplifyDebts(shuffled.reverse())).toEqual(plan);
    }
  });

  it('over many random households: squares everyone up, in the fewest payments, never more than paying each balance', () => {
    const rand = rng(262);
    for (let run = 0; run < 300; run++) {
      const people = 2 + Math.floor(rand() * 7);
      const debts = randomDebts(rand, people, 1 + Math.floor(rand() * 16));
      const plan = simplifyDebts(debts);
      // Everyone ends up exactly where paying each balance would leave them.
      expect(netPositions(plan)).toEqual(netPositions(debts));
      for (const t of plan) {
        expect(t.amountMinor).toBeGreaterThan(0);
        expect(Number.isInteger(t.amountMinor)).toBe(true);
        expect(t.from).not.toBe(t.to);
      }
      const pairs = new Set(
        debts.map((x) => [x.from, x.to].sort().join('|')).filter((k) => k.length > 0),
      );
      expect(plan.length).toBeLessThanOrEqual(pairs.size);
      expect(plan.length).toBe(bruteForceFewest(debts));
    }
  });

  it('still squares everyone up past the exact limit, never with more payments than balances', () => {
    const debts = randomDebts(rng(99), 20, 60);
    const plan = simplifyDebts(debts);
    expect(netPositions(plan)).toEqual(netPositions(debts));
    expect(plan.length).toBeLessThan(netPositions(debts).size);
  });
});

describe('who sees what (ADR 0006 §4)', () => {
  // Ada, Sam and Jo agreed; Kim didn't.
  const agreed = new Set(['ada', 'sam', 'jo']);
  const base = [d('ada', 'sam', 4000), d('sam', 'jo', 4000), d('sam', 'kim', 2500)];

  it('leaves out every balance with someone who hasn’t agreed', () => {
    expect(consentedDebts(base, agreed)).toEqual([d('ada', 'sam', 4000), d('sam', 'jo', 4000)]);
  });

  it('a balance with someone who hasn’t agreed never changes anyone’s plan', () => {
    const plan = (debts: Debt[]) => simplifyDebts(consentedDebts(debts, agreed));
    const before = plan(base);
    for (const amount of [1, 2500, 999_999]) {
      for (const changed of [
        [...base.slice(0, 2), d('sam', 'kim', amount)],
        [...base.slice(0, 2), d('kim', 'sam', amount)],
        [...base, d('kim', 'jo', amount), d('ada', 'kim', amount)],
      ]) {
        expect(plan(changed)).toEqual(before);
      }
    }
  });

  it('shows each person only the payments they make or receive', () => {
    const plan = simplifyDebts(
      consentedDebts(
        [d('ada', 'sam', 4000), d('sam', 'jo', 4000), d('bo', 'cy', 1000)],
        new Set(['ada', 'sam', 'jo', 'bo', 'cy']),
      ),
    );
    expect(plan).toEqual([d('ada', 'jo', 4000), d('bo', 'cy', 1000)]);
    expect(transfersFor('ada', plan)).toEqual([d('ada', 'jo', 4000)]);
    expect(transfersFor('jo', plan)).toEqual([d('ada', 'jo', 4000)]);
    expect(transfersFor('sam', plan)).toEqual([]);
    expect(transfersFor('bo', plan)).toEqual([d('bo', 'cy', 1000)]);
    // Ada's view says nothing about Bo and Cy.
    expect(JSON.stringify(transfersFor('ada', plan))).not.toMatch(/bo|cy/);
  });

  it('what you’re shown always adds up to where you stand with those who agreed', () => {
    const rand = rng(3);
    for (let run = 0; run < 100; run++) {
      const debts = consentedDebts(randomDebts(rand, 6, 12), new Set(['m0', 'm1', 'm2', 'm3']));
      const plan = simplifyDebts(debts);
      const net = netPositions(debts);
      for (const m of ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']) {
        const mine = transfersFor(m, plan).reduce(
          (s, t) => s + (t.to === m ? t.amountMinor : -t.amountMinor),
          0,
        );
        expect(mine).toBe(net.get(m) ?? 0);
      }
    }
  });
});
