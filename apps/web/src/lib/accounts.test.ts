// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import {
  buildSections,
  deleteGroup,
  layoutFrom,
  moveGroup,
  moveTo,
  moveWithin,
  ownerLabel,
  privateAllowed,
  renameGroup,
  type Section,
  sectionTotal,
} from './accounts.js';

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

describe('your arrangement of the accounts list (#48)', () => {
  const acct = (id: string, type: Account['type'], amountMinor = 100) =>
    ({ id, type, balance: { amountMinor, asOf: '2026-10-01' } }) as Account;
  const checking = acct('checking', 'depository');
  const savings = acct('savings', 'depository');
  const card = acct('card', 'credit', -40);
  const house = acct('house', 'property', 5000);
  const list = [checking, savings, card, house];
  const keys = (sections: Section[]) =>
    sections.map((s) => [s.key, s.accounts.map((a) => a.id)] as const);

  it('without a layout, sections are the types, in order, with nothing empty', () => {
    expect(keys(buildSections(list, undefined))).toEqual([
      ['type:cash', ['checking', 'savings']],
      ['type:credit', ['card']],
      ['type:property', ['house']],
    ]);
  });

  it('puts your groups first, and leaves out accounts not on the page', () => {
    const layout = {
      groups: [
        { id: 'g1', name: 'Everyday', accountIds: ['card', 'gone', 'checking'] },
        { id: 'g2', name: 'Empty', accountIds: [] },
      ],
      ungrouped: [],
    };
    expect(keys(buildSections(list, layout))).toEqual([
      ['group:g1', ['card', 'checking']],
      ['type:cash', ['savings']],
      ['type:property', ['house']],
    ]);
    // While arranging, an empty group still shows, so you can move accounts into it.
    expect(buildSections(list, layout, { keepEmptyGroups: true }).map((s) => s.key)).toContain(
      'group:g2',
    );
  });

  it('totals a mixed group as net worth counts it', () => {
    const [group] = buildSections(list, {
      groups: [{ id: 'g', name: 'Mix', accountIds: ['checking', 'card'] }],
      ungrouped: [],
    });
    expect(sectionTotal(group!)).toEqual({ minor: 60, kind: 'balance' });
    expect(sectionTotal({ ...group!, accounts: [card] })).toEqual({
      minor: -40,
      kind: 'liability',
    });
  });

  it('moves accounts within a section, into a group, and back to their type', () => {
    const layout = { groups: [{ id: 'g', name: 'Mine', accountIds: [] }], ungrouped: [] };
    let s = buildSections(list, layout, { keepEmptyGroups: true });
    s = moveWithin(s, 'savings', -1);
    expect(keys(s)[1]).toEqual(['type:cash', ['savings', 'checking']]);
    s = moveTo(s, 'card', 'group:g');
    s = moveTo(s, 'house', 'group:g');
    expect(keys(s)[0]).toEqual(['group:g', ['card', 'house']]);
    s = moveTo(s, 'card', 'type:anything');
    expect(keys(s).find(([k]) => k === 'type:credit')).toEqual(['type:credit', ['card']]);
    expect(layoutFrom(s, layout)).toEqual({
      groups: [{ id: 'g', name: 'Mine', accountIds: ['house'] }],
      ungrouped: ['savings', 'checking', 'card'],
    });
  });

  it('reorders, renames, and deletes groups, and adds a new one', () => {
    const layout = {
      groups: [
        { id: 'a', name: 'A', accountIds: ['checking'] },
        { id: 'b', name: 'B', accountIds: ['house'] },
      ],
      ungrouped: [],
    };
    let s = buildSections(list, layout, { keepEmptyGroups: true });
    s = moveGroup(s, 'b', -1);
    s = renameGroup(s, 'a', 'Banking');
    expect(s.slice(0, 2).map((x) => x.label)).toEqual(['B', 'Banking']);
    s = deleteGroup(s, 'b');
    expect(keys(s).find(([k]) => k === 'type:property')).toEqual(['type:property', ['house']]);
    expect(layoutFrom(s, layout, 'New').groups).toEqual([
      { id: 'a', name: 'Banking', accountIds: ['checking'] },
      { name: 'New', accountIds: [] },
    ]);
  });

  it('keeps accounts placed but not on the page where they were', () => {
    const layout = {
      groups: [
        { id: 'g', name: 'G', accountIds: ['checking', 'closed-one'] },
        { id: 'old', name: 'Old', accountIds: ['other-lens'] },
      ],
      ungrouped: ['elsewhere'],
    };
    const s = buildSections(list, layout).filter((x) => x.groupId !== 'old');
    expect(layoutFrom(s, layout)).toEqual({
      groups: [{ id: 'g', name: 'G', accountIds: ['checking', 'closed-one'] }],
      // A deleted group's off-page accounts go back to their sections, after the rest.
      ungrouped: ['savings', 'card', 'house', 'elsewhere', 'other-lens'],
    });
  });
});
