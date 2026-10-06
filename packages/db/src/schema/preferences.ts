// SPDX-License-Identifier: AGPL-3.0-or-later
import { foreignKey, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../columns.js';
import { householdMembers } from './households.js';

/**
 * A member's own preferences in a household, such as the default range per page (ADR 0011 §5,
 * #68). Only that member reads or writes them (row-level security, migration 0015).
 */
export const memberPreferences = pgTable(
  'member_preferences',
  {
    householdId: uuid().notNull(),
    memberId: uuid().notNull(),
    key: text().notNull(),
    value: jsonb().$type<unknown>().notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.key] }),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
  ],
);
