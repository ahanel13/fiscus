import { integer, pgTable, primaryKey, timestamp } from 'drizzle-orm/pg-core';
import { bytea, householdId } from '../columns.js';

/**
 * Household data keys, each encrypted ("wrapped") by the master key (ADR 0005). The newest
 * unretired version encrypts; any version decrypts. Deleting a household's rows is the
 * crypto-shred. The foreign key to households is added with that table (#17).
 */
export const householdKeys = pgTable(
  'household_keys',
  {
    householdId: householdId(),
    version: integer().notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    masterKeyVersion: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.version] })],
);

export type HouseholdKeyRow = typeof householdKeys.$inferSelect;
