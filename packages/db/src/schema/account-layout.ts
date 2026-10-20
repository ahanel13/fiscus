// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.js';
import { accounts } from './accounts.js';
import { householdMembers } from './households.js';

// How a member arranges their accounts list (#48): their own groups, and where each account goes.
// Only that member reads or writes these (row-level security, migration 0031), so an arrangement
// never changes what anyone can see. Accounts without a placement stay in their type's section.

export const accountGroups = pgTable(
  'account_groups',
  {
    id: id(),
    householdId: uuid().notNull(),
    memberId: uuid().notNull(),
    name: text().notNull(),
    sortOrder: integer().notNull(),
    ...timestamps(),
  },
  (t) => [
    // Target of account_placements' group key (0031): a placement can't use another member's group.
    unique('account_groups_member_id_id').on(t.memberId, t.id),
    index().on(t.householdId, t.memberId),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    check('account_groups_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 60`),
  ],
);

/**
 * Where a member put an account: in one of their groups, or (no group) in its type's section, in
 * their order. Kept while the account is hidden from them, so it comes back where they put it.
 */
export const accountPlacements = pgTable(
  'account_placements',
  {
    householdId: uuid().notNull(),
    memberId: uuid().notNull(),
    accountId: uuid().notNull(),
    /** Set to null when the group is deleted (foreign key in migration 0031). */
    groupId: uuid(),
    sortOrder: integer().notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.accountId] }),
    index().on(t.householdId, t.memberId),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
  ],
);
