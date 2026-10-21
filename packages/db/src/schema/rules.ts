// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, versioning } from '../columns.js';
import { householdMembers, households } from './households.js';

// Rules: conditions → actions on transactions as they arrive (docs/design/imports.md §3, #41).
// Household-wide, or one member's own (#58). Row-level security: migrations 0020 and 0039.

/** What a rule matches and what it does; the shapes are in @fiscus/shared (api/rules.ts). */
export type RuleJson = Record<string, unknown>;

export const rules = pgTable(
  'rules',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /**
     * Whose rule it is: null for the household's, or the member it belongs to, which runs on the
     * accounts they own after the household's rules (imports.md §3). Only they see it (RULE-02).
     */
    memberId: uuid(),
    name: text(),
    /** Rules run in this order within their scope; a later one wins for the same field. */
    position: integer().notNull(),
    enabled: boolean().notNull().default(true),
    conditions: jsonb().$type<RuleJson>().notNull(),
    actions: jsonb().$type<RuleJson>().notNull(),
    /**
     * Whose access the rule acts with (RULE-05): its author, or whoever last edited it. Editing a
     * rule makes you its author, so nobody can borrow another member's reach.
     */
    authorMemberId: uuid().notNull(),
    ...versioning(),
    ...timestamps(),
  },
  (t) => [
    unique('rules_household_id_id').on(t.householdId, t.id),
    foreignKey({
      columns: [t.householdId, t.authorMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    // A member's rules go when they leave (RULE-07): the trigger in 0039, or this cascade.
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    index().on(t.householdId, t.position),
    index().on(t.memberId),
    // A member's rule acts with their own access: nobody else can edit it to borrow it.
    check('rules_member_author', sql`${t.memberId} IS NULL OR ${t.memberId} = ${t.authorMemberId}`),
    check('rules_name', sql`${t.name} IS NULL OR length(btrim(${t.name})) BETWEEN 1 AND 80`),
  ],
);
