import { sql } from 'drizzle-orm';
import { bigint, integer, jsonb, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Column helpers that encode the conventions in docs/design/data-model.md §1.

/** UUIDv7 primary key, generated in the app for time ordering. */
export const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const householdId = () => uuid('household_id').notNull();

/** Money in integer minor units. Pair with a `char(3)` currency column. */
export const money = (name: string) => bigint(name, { mode: 'number' });

export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Optimistic concurrency: row version plus the version each field last changed in. */
export const versioning = () => ({
  version: integer('version').notNull().default(1),
  fieldVersions: jsonb('field_versions')
    .$type<Record<string, number>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
});
