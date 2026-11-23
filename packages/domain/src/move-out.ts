// SPDX-License-Identifier: AGPL-3.0-or-later

// Moving out (#253, ADR 0012 step 3, budgeting walkthrough D37): what goes with someone who spins
// off into a household of their own, what stays, and what's copied. One plan, worked out here
// from what was read, serves the preview (the api, in their own context) and the move itself (the
// worker), so what they're shown is what happens. Removing a member (#266) reuses it.

export type MoveOutRole = 'owner' | 'member' | 'viewer';

export interface MoveOutMember {
  id: string;
  displayName: string;
  role: MoveOutRole;
  /** Null: a dependent without a login (#223), who can't move out until they claim it (#252). */
  userId: string | null;
}

export interface MoveOutOwner {
  memberId: string;
  shareBps: number;
}

/** An account the person moving owns, alone or with others. */
export interface MoveOutAccount {
  id: string;
  name: string;
  closed: boolean;
  connectionId: string | null;
  owners: MoveOutOwner[];
  transactionCount: number;
}

/** A bank connection that's theirs, or that's behind an account of theirs. */
export interface MoveOutConnection {
  id: string;
  ownerMemberId: string;
  /** Null: the server's Plaid keys (or SimpleFIN). Otherwise the household's own keys (ADR 0008). */
  credentialSetId: string | null;
  institutionName: string | null;
  accountIds: string[];
}

export interface MoveOutGoal {
  id: string;
  name: string;
  /** Null: the household's. */
  memberId: string | null;
  kind: 'save' | 'pay_down';
  /** A pay-down goal's debt. */
  accountId: string | null;
  claimAccountIds: string[];
}

export interface MoveOutRule {
  id: string;
  name: string | null;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
}

export interface MoveOutCategory {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  groupKind: string;
  systemKey: string | null;
}

export interface MoveOutTag {
  id: string;
  name: string;
  color: string;
}

/** What the plan is worked out from: read by `loadMoveOutInput` in @fiscus/ledger. */
export interface MoveOutInput {
  /** Who's moving. */
  memberId: string;
  /** The household's current members, the person moving included. */
  members: MoveOutMember[];
  accounts: MoveOutAccount[];
  connections: MoveOutConnection[];
  /** Their own budget (Mine), if they have one. */
  budgetId: string | null;
  /** Their own goals, and the household's that are on, or claim, an account of theirs. */
  goals: MoveOutGoal[];
  /** Their own rules. */
  rules: MoveOutRule[];
  /** The categories and tags their own data uses (accounts, budget, rules). */
  categories: MoveOutCategory[];
  tags: MoveOutTag[];
  /** Purchases on other people's accounts attributed to them: these stay. */
  attributedElsewhere: number;
  /** Purchases on accounts that move, attributed to someone else: they become theirs. */
  forOthers: number;
}

/** Why someone can't move out yet. */
export type MoveOutBlocker = 'dependent' | 'last_owner' | 'only_member';

export interface MoveOutPlan {
  blockers: MoveOutBlocker[];
  /** Accounts they own alone: these move, with all their history. */
  accounts: {
    id: string;
    name: string;
    transactionCount: number;
    /** Its bank connection goes too, it needs re-linking in the new household, or it has none. */
    connection: 'moves' | 'relink' | null;
  }[];
  /** Joint accounts: these stay, without them, and their share goes to the other owners. */
  jointAccounts: {
    id: string;
    name: string;
    owners: MoveOutOwner[];
    /** Their bank login is behind it: the other owners re-link it with their own. */
    relink: boolean;
  }[];
  /** Their bank connections: with the server's keys they move; with the household's, re-link. */
  connections: {
    id: string;
    institutionName: string | null;
    outcome: 'moves' | 'relink';
    accountIds: string[];
  }[];
  budgetId: string | null;
  /** Goals that move: their own, and the household's pay-down goals on a debt that moves. */
  goals: { id: string; name: string; wasHousehold: boolean }[];
  /** Their own pay-down goals on a joint debt, which stays: these end when they leave. */
  goalsLeft: { id: string; name: string }[];
  /** Claims that end: a moving goal's on an account that stays, and the reverse. */
  claimsEnding: { goalId: string; accountId: string }[];
  rules: { id: string; name: string | null }[];
  /** Their rules only for accounts that stay, or that do nothing once moved: these end. */
  rulesLeft: { id: string; name: string | null }[];
  categories: MoveOutCategory[];
  tags: MoveOutTag[];
  attributedElsewhere: number;
  forOthers: number;
}

/**
 * The other owners' shares once `memberId` is gone, in proportion to what they had, adding up to
 * 10 000 again. What doesn't divide goes to the largest remainders first, then the earliest owner.
 */
export function redistributeShares(
  owners: readonly MoveOutOwner[],
  memberId: string,
): MoveOutOwner[] {
  const rest = owners.filter((o) => o.memberId !== memberId);
  const total = rest.reduce((s, o) => s + o.shareBps, 0);
  if (rest.length === 0 || total <= 0) return [];
  const exact = rest.map((o, i) => {
    const raw = (o.shareBps * 10000) / total;
    return { i, memberId: o.memberId, shareBps: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });
  let left = 10000 - exact.reduce((s, o) => s + o.shareBps, 0);
  for (const o of [...exact].sort((a, b) => b.remainder - a.remainder || a.i - b.i)) {
    if (left <= 0) break;
    o.shareBps += 1;
    left -= 1;
  }
  return exact.map(({ memberId: m, shareBps }) => ({ memberId: m, shareBps }));
}

export interface RuleIdMaps {
  /** Accounts that move: a condition or transfer naming any other no longer applies. */
  accounts: ReadonlySet<string>;
  categories: ReadonlyMap<string, string>;
  tags: ReadonlyMap<string, string>;
}

/**
 * A rule as it moves (or null, when nothing of it applies any more): its accounts only those that
 * move, its categories and tags the new household's. Who it's for goes: the new household has one
 * member at first, and no attribution is the account's owner. A transfer to an account that stays
 * goes too.
 */
export function moveRule(
  rule: Pick<MoveOutRule, 'conditions' | 'actions'>,
  maps: RuleIdMaps,
): { conditions: Record<string, unknown>; actions: Record<string, unknown> } | null {
  const conditions = { ...rule.conditions };
  if (Array.isArray(conditions.accountIds)) {
    const ids = (conditions.accountIds as string[]).filter((id) => maps.accounts.has(id));
    if (ids.length === 0) return null;
    conditions.accountIds = ids;
  }
  if (typeof conditions.categoryId === 'string') {
    const id = maps.categories.get(conditions.categoryId);
    if (!id) return null;
    conditions.categoryId = id;
  }
  const actions = { ...rule.actions };
  delete actions.attribution;
  if (typeof actions.categoryId === 'string') {
    const id = maps.categories.get(actions.categoryId);
    if (id) actions.categoryId = id;
    else delete actions.categoryId;
  }
  if (Array.isArray(actions.addTagIds)) {
    const ids = (actions.addTagIds as string[]).flatMap((id) => maps.tags.get(id) ?? []);
    if (ids.length > 0) actions.addTagIds = ids;
    else delete actions.addTagIds;
  }
  const transfer = actions.transferTo as { accountId?: unknown } | undefined;
  if (
    transfer &&
    !(typeof transfer.accountId === 'string' && maps.accounts.has(transfer.accountId))
  ) {
    delete actions.transferTo;
  }
  if (Object.keys(actions).length === 0) return null;
  return { conditions, actions };
}

/** Works out what moves, stays and is copied. Pure: the same input always gives the same plan. */
export function planMoveOut(input: MoveOutInput): MoveOutPlan {
  const me = input.memberId;
  const self = input.members.find((m) => m.id === me);
  const blockers: MoveOutBlocker[] = [];
  if (!self || self.userId === null) blockers.push('dependent');
  if (input.members.filter((m) => m.id !== me).length === 0) blockers.push('only_member');
  else if (
    self?.role === 'owner' &&
    !input.members.some((m) => m.id !== me && m.role === 'owner')
  ) {
    blockers.push('last_owner');
  }

  const mine = input.accounts.filter((a) => a.owners.some((o) => o.memberId === me));
  const sole = mine.filter((a) => a.owners.every((o) => o.memberId === me));
  const moving = new Set(sole.map((a) => a.id));
  const connections = new Map(input.connections.map((c) => [c.id, c]));
  const theirs = input.connections.filter((c) => c.ownerMemberId === me);

  const accounts = sole.map((a) => {
    const c = a.connectionId ? connections.get(a.connectionId) : undefined;
    const connection: 'moves' | 'relink' | null = !a.connectionId
      ? null
      : c && c.ownerMemberId === me && c.credentialSetId === null
        ? 'moves'
        : 'relink';
    return { id: a.id, name: a.name, transactionCount: a.transactionCount, connection };
  });
  const jointAccounts = mine
    .filter((a) => !moving.has(a.id))
    .map((a) => {
      const c = a.connectionId ? connections.get(a.connectionId) : undefined;
      return {
        id: a.id,
        name: a.name,
        owners: redistributeShares(a.owners, me),
        relink: Boolean(c && c.ownerMemberId === me),
      };
    });

  const goals: MoveOutPlan['goals'] = [];
  const goalsLeft: MoveOutPlan['goalsLeft'] = [];
  const claimsEnding: MoveOutPlan['claimsEnding'] = [];
  for (const g of input.goals) {
    const own = g.memberId === me;
    const onMovingDebt = g.kind === 'pay_down' && g.accountId !== null && moving.has(g.accountId);
    const moves = own ? g.kind === 'save' || onMovingDebt : onMovingDebt;
    if (moves) {
      goals.push({ id: g.id, name: g.name, wasHousehold: !own });
      for (const a of g.claimAccountIds) {
        if (!moving.has(a)) claimsEnding.push({ goalId: g.id, accountId: a });
      }
    } else {
      if (own) goalsLeft.push({ id: g.id, name: g.name });
      for (const a of g.claimAccountIds) {
        if (moving.has(a)) claimsEnding.push({ goalId: g.id, accountId: a });
      }
    }
  }

  const categoryIds = new Map(input.categories.map((c) => [c.id, c.id]));
  const tagIds = new Map(input.tags.map((t) => [t.id, t.id]));
  const rules: MoveOutPlan['rules'] = [];
  const rulesLeft: MoveOutPlan['rulesLeft'] = [];
  for (const r of input.rules) {
    const moved = moveRule(r, { accounts: moving, categories: categoryIds, tags: tagIds });
    (moved ? rules : rulesLeft).push({ id: r.id, name: r.name });
  }

  const byName = (a: { name: string | null }, b: { name: string | null }) =>
    (a.name ?? '').localeCompare(b.name ?? '');
  return {
    blockers,
    accounts: accounts.sort(byName),
    jointAccounts: jointAccounts.sort(byName),
    connections: theirs
      .map((c) => ({
        id: c.id,
        institutionName: c.institutionName,
        outcome: c.credentialSetId === null ? ('moves' as const) : ('relink' as const),
        accountIds: c.accountIds.filter((id) => moving.has(id)),
      }))
      .sort((a, b) => (a.institutionName ?? '').localeCompare(b.institutionName ?? '')),
    budgetId: input.budgetId,
    goals: goals.sort(byName),
    goalsLeft: goalsLeft.sort(byName),
    claimsEnding,
    rules,
    rulesLeft,
    categories: [...input.categories].sort(
      (a, b) => a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name),
    ),
    tags: [...input.tags].sort(byName),
    attributedElsewhere: input.attributedElsewhere,
    forOthers: input.forOthers,
  };
}

export interface ExistingCategory {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  systemKey: string | null;
}

/**
 * Which of the new household's categories each copied one becomes: the one with the same system
 * key (Uncategorized, Transfer, Settlement), else the one with the same name in a group of the same
 * name, ignoring case. Null: it's copied as a new category, into the group of the same name if
 * there is one (`groups`), else a copy of its group.
 */
export function matchCategories(
  used: readonly MoveOutCategory[],
  existing: readonly ExistingCategory[],
): Map<string, { categoryId: string | null; groupId: string | null }> {
  const key = (...parts: string[]) => parts.map((p) => p.trim().toLowerCase()).join('\u0000');
  const bySystem = new Map(existing.filter((c) => c.systemKey).map((c) => [c.systemKey!, c]));
  const byName = new Map(existing.map((c) => [key(c.groupName, c.name), c]));
  const groups = new Map(existing.map((c) => [key(c.groupName), c.groupId]));
  const out = new Map<string, { categoryId: string | null; groupId: string | null }>();
  for (const c of used) {
    const hit = (c.systemKey && bySystem.get(c.systemKey)) || byName.get(key(c.groupName, c.name));
    out.set(c.id, {
      categoryId: hit ? hit.id : null,
      groupId: hit ? hit.groupId : (groups.get(key(c.groupName)) ?? null),
    });
  }
  return out;
}
