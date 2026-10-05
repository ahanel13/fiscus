// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  char,
  check,
} from 'drizzle-orm/pg-core';
import { bytea, id, timestamps, versioning } from '../columns.js';
import { users } from './identity.js';

// Tenancy tables (data model §3.1, ADR 0005/0006).

export const householdStatus = pgEnum('household_status', ['active', 'disabled', 'deleting']);
export const dateBasis = pgEnum('date_basis', ['posted', 'authorized']);
export const financeStyle = pgEnum('finance_style', [
  'combined',
  'hybrid',
  'separate',
  'roommates',
]);
export const memberRole = pgEnum('member_role', ['owner', 'member', 'viewer']);

export const households = pgTable(
  'households',
  {
    id: id(),
    name: text().notNull(),
    baseCurrency: char({ length: 3 }).notNull(),
    timezone: text().notNull(),
    weekStart: smallint().notNull().default(1),
    fiscalYearStartMonth: smallint().notNull().default(1),
    dateBasis: dateBasis().notNull().default('posted'),
    financeStyle: financeStyle().notNull().default('hybrid'),
    status: householdStatus().notNull().default('active'),
    ...versioning(),
    ...timestamps(),
  },
  (t) => [
    check('households_week_start', sql`${t.weekStart} BETWEEN 0 AND 6`),
    check('households_fiscal_month', sql`${t.fiscalYearStartMonth} BETWEEN 1 AND 12`),
  ],
);

export const householdMembers = pgTable(
  'household_members',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** Null = a member without a login (#223); the API rejects these until that ships. */
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    role: memberRole().notNull(),
    displayName: text().notNull(),
    color: text().notNull(),
    avatarUrl: text(),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('household_members_active_user')
      .on(t.householdId, t.userId)
      .where(sql`${t.leftAt} IS NULL AND ${t.userId} IS NOT NULL`),
    index().on(t.userId),
    check('household_members_loginless_role', sql`${t.userId} IS NOT NULL OR ${t.role} = 'member'`),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** The invite can only be accepted by an account with this (normalized) email. */
    email: text().notNull(),
    role: memberRole().notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    invitedByMemberId: uuid().references(() => householdMembers.id, { onDelete: 'set null' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    acceptedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.householdId)],
);
