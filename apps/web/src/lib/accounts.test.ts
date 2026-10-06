// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ownerLabel, privateAllowed } from './accounts.js';

const members = [
  { id: 'a', displayName: 'Ada', isYou: true },
  { id: 'b', displayName: 'Bea', isYou: false },
  { id: 'c', displayName: 'Cal', isYou: false },
];
const owned = (...ids: string[]) => ({
  owners: ids.map((memberId) => ({ memberId, shareBps: 1 })),
});

describe('ownerLabel', () => {
  it('is relative to the viewer and gender-neutral', () => {
    expect(ownerLabel(owned('a'), members)).toBe('Mine');
    expect(ownerLabel(owned('a', 'b'), members)).toBe('Ours');
    expect(ownerLabel(owned('b'), members)).toBe('Bea’s');
    expect(ownerLabel(owned('b', 'c'), members)).toBe('Bea & Cal’s');
  });
});

describe('privateAllowed', () => {
  it('rules out private joint accounts in two-member households only', () => {
    expect(privateAllowed(2, 2)).toBe(false);
    expect(privateAllowed(1, 2)).toBe(true);
    expect(privateAllowed(2, 3)).toBe(true);
  });
});
