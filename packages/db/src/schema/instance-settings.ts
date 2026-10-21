// SPDX-License-Identifier: AGPL-3.0-or-later
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity.js';

/**
 * Instance settings (#400): one row per setting an instance admin has changed; a missing row means
 * the default from the registry in @fiscus/shared. Instance-level, so no row-level security, but
 * fiscus_app (and so the worker) may only read it: writes go through fiscus_set_instance_setting(),
 * which checks the caller is an instance admin (migration 0035).
 */
export const instanceSettings = pgTable('instance_settings', {
  /** A registry key, such as `sync.intervalHours`. */
  key: text().primaryKey(),
  /** Validated by the registry before it's written, and again when it's read. */
  value: jsonb().$type<unknown>().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
});
