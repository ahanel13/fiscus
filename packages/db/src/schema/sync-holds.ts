// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, money, timestamps } from '../columns.js';
import { accounts } from './accounts.js';
import { connections } from './connections.js';

// Possible duplicates (bank connections walkthrough D7, #80): a synced transaction that looks like
// one already in the account without matching it exactly (another day within a few, or more than
// one like it). It waits here, outside the ledger, so totals don't count it twice, until an owner
// of the account decides: the same transaction (yours takes the bank's id) or a different one (it's
// added). Row-level security: migration 0050.

export const syncHolds = pgTable(
  'sync_holds',
  {
    id: id(),
    householdId: uuid().notNull(),
    connectionId: uuid().notNull(),
    accountId: uuid().notNull(),
    /** The bank's transaction, as sync would insert it (positive = money in). */
    providerTransactionId: text().notNull(),
    providerPendingId: text(),
    amountMinor: money('amount_minor').notNull(),
    currency: char({ length: 3 }).notNull(),
    postedDate: date({ mode: 'string' }),
    authorizedDate: date({ mode: 'string' }).notNull(),
    /** Untrusted text (ADR 0009). */
    originalDescription: text().notNull(),
    displayName: text().notNull(),
    foreignAmountMinor: money('foreign_amount_minor'),
    foreignCurrency: char({ length: 3 }),
    /** The transactions it may be, when it was held. Checked again when shown and decided. */
    candidateIds: uuid().array().notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('sync_holds_household_id_id').on(t.householdId, t.id),
    unique('sync_holds_provider').on(t.accountId, t.providerTransactionId),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.connectionId],
      foreignColumns: [connections.householdId, connections.id],
    }).onDelete('cascade'),
    index().on(t.householdId),
    index().on(t.connectionId),
    check('sync_holds_currency', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('sync_holds_nonzero', sql`${t.amountMinor} <> 0`),
  ],
);
