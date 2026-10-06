// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from '../columns.js';
import { accounts } from './accounts.js';
import { householdMembers, households } from './households.js';

// File imports (data model §3.5, docs/design/imports.md). Files are parsed in the browser; only
// the resulting rows reach the server, and no file is stored. Row-level security: migration 0017.

export const importFormat = pgEnum('import_format', ['csv', 'ofx', 'qfx', 'monarch']);

/** A saved column mapping ("Chase checking CSV"), picked again when a file's headers match. */
export const importProfiles = pgTable(
  'import_profiles',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    format: importFormat().notNull(),
    /** The file's headers, lower-cased and trimmed: how a later file is recognized. */
    headers: text().array().notNull(),
    mapping: jsonb().$type<Record<string, unknown>>().notNull(),
    createdByMemberId: uuid(),
    ...timestamps(),
  },
  (t) => [
    unique('import_profiles_household_id_id').on(t.householdId, t.id),
    uniqueIndex('import_profiles_name').on(t.householdId, sql`lower(${t.name})`),
    check('import_profiles_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 60`),
  ],
);

/**
 * One import into one account. Reverting soft-deletes its transactions and removes its balances
 * (TXN-10); the row stays as the record that it happened.
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: id(),
    householdId: uuid().notNull(),
    accountId: uuid().notNull(),
    /** Who imported it. */
    memberId: uuid().notNull(),
    profileId: uuid(),
    format: importFormat().notNull(),
    filename: text().notNull(),
    transactionCount: integer().notNull(),
    balanceCount: integer().notNull(),
    /** The import created the account: reverting removes it too, if nothing else is in it. */
    createdAccount: boolean().notNull().default(false),
    revertedAt: timestamp({ withTimezone: true }),
    revertedByMemberId: uuid(),
    ...timestamps(),
  },
  (t) => [
    unique('import_batches_household_id_id').on(t.householdId, t.id),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    foreignKey({
      columns: [t.profileId],
      foreignColumns: [importProfiles.id],
    }).onDelete('set null'),
    index().on(t.householdId, t.createdAt.desc()),
    index().on(t.accountId),
    check('import_batches_filename', sql`length(${t.filename}) BETWEEN 1 AND 255`),
  ],
);
