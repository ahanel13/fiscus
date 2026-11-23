// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  matchCategories,
  type MoveOutInput,
  moveRule,
  planMoveOut,
  redistributeShares,
} from './move-out.js';

const sam = { id: 'sam', displayName: 'Sam', role: 'member' as const, userId: 'u-sam' };
const ada = { id: 'ada', displayName: 'Ada', role: 'owner' as const, userId: 'u-ada' };
const jo = { id: 'jo', displayName: 'Jo', role: 'member' as const, userId: 'u-jo' };

const input = (over: Partial<MoveOutInput> = {}): MoveOutInput => ({
  memberId: 'sam',
  members: [ada, sam],
  accounts: [],
  connections: [],
  budgetId: null,
  goals: [],
  rules: [],
  categories: [],
  tags: [],
  attributedElsewhere: 0,
  forOthers: 0,
  ...over,
});

const account = (id: string, owners: [string, number][], connectionId: string | null = null) => ({
  id,
  name: id,
  closed: false,
  connectionId,
  owners: owners.map(([memberId, shareBps]) => ({ memberId, shareBps })),
  transactionCount: 3,
});

describe('redistributeShares', () => {
  it('gives the share to the others in proportion, adding up to 10 000', () => {
    expect(
      redistributeShares(
        [
          { memberId: 'sam', shareBps: 5000 },
          { memberId: 'ada', shareBps: 2500 },
          { memberId: 'jo', shareBps: 2500 },
        ],
        'sam',
      ),
    ).toEqual([
      { memberId: 'ada', shareBps: 5000 },
      { memberId: 'jo', shareBps: 5000 },
    ]);
  });

  it('gives what does not divide to the largest remainders, then the earliest', () => {
    const out = redistributeShares(
      [
        { memberId: 'sam', shareBps: 1 },
        { memberId: 'ada', shareBps: 3333 },
        { memberId: 'jo', shareBps: 3333 },
        { memberId: 'kim', shareBps: 3333 },
      ],
      'sam',
    );
    expect(out.reduce((s, o) => s + o.shareBps, 0)).toBe(10000);
    expect(out.map((o) => o.shareBps)).toEqual([3334, 3333, 3333]);
  });

  it('leaves nothing when they were the only owner', () => {
    expect(redistributeShares([{ memberId: 'sam', shareBps: 10000 }], 'sam')).toEqual([]);
  });
});

describe('planMoveOut', () => {
  it('moves accounts they own alone, and keeps joint ones with their share passed on', () => {
    const plan = planMoveOut(
      input({
        members: [ada, sam, jo],
        accounts: [
          account('checking', [['sam', 10000]]),
          account('joint', [
            ['sam', 5000],
            ['ada', 2500],
            ['jo', 2500],
          ]),
        ],
      }),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.accounts).toEqual([
      { id: 'checking', name: 'checking', transactionCount: 3, connection: null },
    ]);
    expect(plan.jointAccounts).toEqual([
      {
        id: 'joint',
        name: 'joint',
        relink: false,
        owners: [
          { memberId: 'ada', shareBps: 5000 },
          { memberId: 'jo', shareBps: 5000 },
        ],
      },
    ]);
  });

  it('moves bank connections made with the server’s keys, and re-links the household’s', () => {
    const plan = planMoveOut(
      input({
        accounts: [
          account('a1', [['sam', 10000]], 'c-server'),
          account('a2', [['sam', 10000]], 'c-household'),
          account('a3', [['sam', 10000]], 'c-ada'),
          account(
            'joint',
            [
              ['sam', 5000],
              ['ada', 5000],
            ],
            'c-server',
          ),
        ],
        connections: [
          {
            id: 'c-server',
            ownerMemberId: 'sam',
            credentialSetId: null,
            institutionName: 'Chase',
            accountIds: ['a1', 'joint'],
          },
          {
            id: 'c-household',
            ownerMemberId: 'sam',
            credentialSetId: 'keys',
            institutionName: 'Ally',
            accountIds: ['a2'],
          },
          // Ada's bank login, behind an account of Sam's.
          {
            id: 'c-ada',
            ownerMemberId: 'ada',
            credentialSetId: null,
            institutionName: 'Citi',
            accountIds: ['a3'],
          },
        ],
      }),
    );
    expect(plan.accounts.map((a) => [a.id, a.connection])).toEqual([
      ['a1', 'moves'],
      ['a2', 'relink'],
      ['a3', 'relink'],
    ]);
    expect(plan.connections).toEqual([
      { id: 'c-household', institutionName: 'Ally', outcome: 'relink', accountIds: ['a2'] },
      { id: 'c-server', institutionName: 'Chase', outcome: 'moves', accountIds: ['a1'] },
    ]);
    // Their login was behind the joint account: Ada re-links it with hers.
    expect(plan.jointAccounts[0]?.relink).toBe(true);
  });

  it('moves their own goals, and the household’s on a debt that moves; claims across end', () => {
    const plan = planMoveOut(
      input({
        accounts: [
          account('savings', [['sam', 10000]]),
          account('card', [['sam', 10000]]),
          account('joint', [
            ['sam', 5000],
            ['ada', 5000],
          ]),
          account('loan', [
            ['sam', 5000],
            ['ada', 5000],
          ]),
        ],
        goals: [
          {
            id: 'trip',
            name: 'Trip',
            memberId: 'sam',
            kind: 'save',
            accountId: null,
            claimAccountIds: ['savings', 'joint'],
          },
          {
            id: 'house',
            name: 'House',
            memberId: null,
            kind: 'save',
            accountId: null,
            claimAccountIds: ['savings', 'joint'],
          },
          {
            id: 'card-off',
            name: 'Card off',
            memberId: null,
            kind: 'pay_down',
            accountId: 'card',
            claimAccountIds: [],
          },
          {
            id: 'loan-off',
            name: 'Loan off',
            memberId: 'sam',
            kind: 'pay_down',
            accountId: 'loan',
            claimAccountIds: [],
          },
        ],
      }),
    );
    expect(plan.goals).toEqual([
      { id: 'card-off', name: 'Card off', wasHousehold: true },
      { id: 'trip', name: 'Trip', wasHousehold: false },
    ]);
    expect(plan.goalsLeft).toEqual([{ id: 'loan-off', name: 'Loan off' }]);
    expect(plan.claimsEnding).toEqual([
      { goalId: 'trip', accountId: 'joint' },
      { goalId: 'house', accountId: 'savings' },
    ]);
  });

  it('moves rules that still do something, and lists the ones that end', () => {
    const plan = planMoveOut(
      input({
        accounts: [
          account('mine', [['sam', 10000]]),
          account('joint', [
            ['sam', 5000],
            ['ada', 5000],
          ]),
        ],
        categories: [
          {
            id: 'food',
            name: 'Food',
            groupId: 'g',
            groupName: 'Everyday',
            groupKind: 'flexible',
            systemKey: null,
          },
        ],
        rules: [
          {
            id: 'r1',
            name: 'Groceries',
            conditions: { accountIds: ['mine', 'joint'] },
            actions: { categoryId: 'food' },
          },
          {
            id: 'r2',
            name: 'Joint only',
            conditions: { accountIds: ['joint'] },
            actions: { categoryId: 'food' },
          },
          {
            id: 'r3',
            name: 'Split',
            conditions: { direction: 'out' },
            actions: { attribution: [{ memberId: 'ada' }] },
          },
        ],
      }),
    );
    expect(plan.rules).toEqual([{ id: 'r1', name: 'Groceries' }]);
    expect(plan.rulesLeft).toEqual([
      { id: 'r2', name: 'Joint only' },
      { id: 'r3', name: 'Split' },
    ]);
  });

  it('refuses a dependent, the last owner, and someone on their own', () => {
    expect(planMoveOut(input({ members: [ada, { ...sam, userId: null }] })).blockers).toEqual([
      'dependent',
    ]);
    expect(planMoveOut(input({ memberId: 'ada' })).blockers).toEqual(['last_owner']);
    expect(
      planMoveOut(input({ memberId: 'ada', members: [ada, { ...sam, role: 'owner' }] })).blockers,
    ).toEqual([]);
    expect(planMoveOut(input({ members: [sam] })).blockers).toEqual(['only_member']);
  });
});

describe('moveRule', () => {
  const maps = {
    accounts: new Set(['mine']),
    categories: new Map([['old-food', 'new-food']]),
    tags: new Map([['old-tag', 'new-tag']]),
  };

  it('keeps moving accounts, maps categories and tags, and drops who it’s for', () => {
    expect(
      moveRule(
        {
          conditions: { accountIds: ['mine', 'joint'], categoryId: 'old-food' },
          actions: {
            categoryId: 'old-food',
            addTagIds: ['old-tag', 'gone'],
            attribution: [{ memberId: 'ada' }],
            transferTo: { accountId: 'joint', withinDays: 5 },
            markReviewed: true,
          },
        },
        maps,
      ),
    ).toEqual({
      conditions: { accountIds: ['mine'], categoryId: 'new-food' },
      actions: { categoryId: 'new-food', addTagIds: ['new-tag'], markReviewed: true },
    });
  });

  it('keeps a null category condition (uncategorized)', () => {
    expect(
      moveRule({ conditions: { categoryId: null }, actions: { markReviewed: true } }, maps),
    ).toEqual({ conditions: { categoryId: null }, actions: { markReviewed: true } });
  });

  it('ends a rule with nothing left to do', () => {
    expect(
      moveRule({ conditions: { direction: 'out' }, actions: { attribution: [] } }, maps),
    ).toBeNull();
  });
});

describe('matchCategories', () => {
  it('matches system keys, then group and name ignoring case, else copies', () => {
    const out = matchCategories(
      [
        {
          id: 'u1',
          name: 'Uncategorised',
          groupId: 'g1',
          groupName: 'Other',
          groupKind: 'flexible',
          systemKey: 'uncategorized',
        },
        {
          id: 'u2',
          name: 'groceries',
          groupId: 'g2',
          groupName: 'FOOD',
          groupKind: 'flexible',
          systemKey: null,
        },
        {
          id: 'u3',
          name: 'Boat',
          groupId: 'g2',
          groupName: 'Food',
          groupKind: 'flexible',
          systemKey: null,
        },
        {
          id: 'u4',
          name: 'Boat',
          groupId: 'g3',
          groupName: 'Hobbies',
          groupKind: 'flexible',
          systemKey: null,
        },
      ],
      [
        {
          id: 'n1',
          name: 'Uncategorized',
          groupId: 'ng1',
          groupName: 'Other',
          systemKey: 'uncategorized',
        },
        { id: 'n2', name: 'Groceries', groupId: 'ng2', groupName: 'Food', systemKey: null },
      ],
    );
    expect(Object.fromEntries(out)).toEqual({
      u1: { categoryId: 'n1', groupId: 'ng1' },
      u2: { categoryId: 'n2', groupId: 'ng2' },
      u3: { categoryId: null, groupId: 'ng2' },
      u4: { categoryId: null, groupId: null },
    });
  });
});
