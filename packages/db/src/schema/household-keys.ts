import { integer, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from '../columns.js';
import { households } from './households.js';

/**
 * Household data keys, each encrypted ("wrapped") by the master key (ADR 0005). The newest
 * unretired version encrypts; any version decrypts. Deleting a household's rows is the
 * crypto-shred.
 */
export const householdKeys = pgTable(
  'household_keys',
  {
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    masterKeyVersion: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.version] })],
);

export type HouseholdKeyRow = typeof householdKeys.$inferSelect;
