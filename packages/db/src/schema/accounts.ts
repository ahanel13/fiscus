// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, id, money, timestamps, versioning } from '../columns.js';
import { householdMembers, households } from './households.js';

// Accounts, ownership, and balances (data model §3.3, docs/design/accounts-and-visibility.md).
// Visibility is enforced by row-level security through fiscus_account_access() (migration 0010).

export const accountType = pgEnum('account_type', [
  'depository',
  'credit',
  'loan',
  'investment',
  'property',
  'vehicle',
  'crypto',
  'other',
]);
export const accountVisibility = pgEnum('account_visibility', [
  'full',
  'view_only',
  'balance_only',
  'private',
]);
/** What a member may see of an account, lowest first, so levels compare with < and >. */
export const accountAccessLevel = pgEnum('account_access_level', [
  'balance_only',
  'view_only',
  'full',
  'owner',
]);
/** How a manual balance moves: with transactions (bank-style) or set by hand (house, car). */
export const balanceMode = pgEnum('balance_mode', ['transactions', 'value']);
export const balanceSource = pgEnum('balance_source', ['provider', 'computed', 'manual']);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** Bank connection (M2). No foreign key until the connections table exists. */
    connectionId: uuid(),
    providerAccountId: text(),
    name: text().notNull(),
    officialName: text(),
    type: accountType().notNull(),
    subtype: text(),
    currency: char({ length: 3 }).notNull(),
    maskLast4: char({ length: 4 }),
    /** Full account number, encrypted with the household key; owners only. */
    accountNumberEnc: bytea('account_number_enc'),
    visibility: accountVisibility().notNull(),
    balanceMode: balanceMode().notNull(),
    includeInNetWorth: boolean().notNull().default(true),
    isBusiness: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    notesEnc: bytea('notes_enc'),
    closedAt: timestamp({ withTimezone: true }),
    ...versioning(),
    ...timestamps(),
  },
  (t) => [
    // Target of the composite foreign keys below: children can't cross households.
    unique('accounts_household_id_id').on(t.householdId, t.id),
    uniqueIndex('accounts_provider_account')
      .on(t.connectionId, t.providerAccountId)
      .where(sql`${t.connectionId} IS NOT NULL AND ${t.providerAccountId} IS NOT NULL`),
    index().on(t.householdId, t.sortOrder),
    check('accounts_currency', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('accounts_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 120`),
  ],
);

/** Who owns an account, and in what shares (basis points summing to 10 000; ADR 0006 §2). */
export const accountOwners = pgTable(
  'account_owners',
  {
    accountId: uuid().notNull(),
    memberId: uuid().notNull(),
    householdId: uuid().notNull(),
    shareBps: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.memberId] }),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    index().on(t.memberId),
    check('account_owners_share', sql`${t.shareBps} BETWEEN 1 AND 10000`),
  ],
);

/** One balance per account per day (end of day, household time zone; ADR 0011). */
export const balanceSnapshots = pgTable(
  'balance_snapshots',
  {
    accountId: uuid().notNull(),
    asOf: date({ mode: 'string' }).notNull(),
    householdId: uuid().notNull(),
    balanceMinor: money('balance_minor').notNull(),
    availableMinor: money('available_minor'),
    creditLimitMinor: money('credit_limit_minor'),
    source: balanceSource().notNull(),
    /**
     * The import it came from (shown as "from Monarch"; reverting removes it). The foreign key to
     * import_batches is declared in migration 0017, which avoids a cycle between schema files.
     */
    importBatchId: uuid(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.asOf] }),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
    index().on(t.householdId, t.asOf),
    index().on(t.importBatchId),
  ],
);
