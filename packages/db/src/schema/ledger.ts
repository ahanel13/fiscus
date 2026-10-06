// SPDX-License-Identifier: AGPL-3.0-or-later
import { type SQL, sql } from 'drizzle-orm';
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
import { accounts } from './accounts.js';
import { householdMembers, households } from './households.js';
import { importBatches } from './imports.js';

// Categories, tags, transactions, attribution, and notes (data model §3.5,
// docs/design/transactions.md). Visibility is enforced by row-level security (migration 0012).

export const categoryKind = pgEnum('category_kind', [
  'income',
  'fixed',
  'flexible',
  'non_monthly',
  'savings',
  'transfer',
]);
export const transactionSource = pgEnum('transaction_source', ['provider', 'import', 'manual']);
export const reviewStatus = pgEnum('review_status', ['needs_review', 'reviewed']);

const householdRef = () =>
  uuid()
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' });

export const categoryGroups = pgTable(
  'category_groups',
  {
    id: id(),
    householdId: householdRef(),
    name: text().notNull(),
    kind: categoryKind().notNull(),
    sortOrder: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique('category_groups_household_id_id').on(t.householdId, t.id),
    check('category_groups_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 60`),
  ],
);

export const categories = pgTable(
  'categories',
  {
    id: id(),
    householdId: uuid().notNull(),
    groupId: uuid().notNull(),
    name: text().notNull(),
    icon: text(),
    /** `uncategorized`, `transfer`, `settlement`: can be renamed, never deleted. */
    systemKey: text(),
    archivedAt: timestamp({ withTimezone: true }),
    sortOrder: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique('categories_household_id_id').on(t.householdId, t.id),
    foreignKey({
      columns: [t.householdId, t.groupId],
      foreignColumns: [categoryGroups.householdId, categoryGroups.id],
    }),
    uniqueIndex('categories_system_key')
      .on(t.householdId, t.systemKey)
      .where(sql`${t.systemKey} IS NOT NULL`),
    check('categories_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 60`),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: id(),
    householdId: householdRef(),
    name: text().notNull(),
    color: text().notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('tags_household_id_id').on(t.householdId, t.id),
    uniqueIndex('tags_name').on(t.householdId, sql`lower(${t.name})`),
    check('tags_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 40`),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    id: id(),
    householdId: uuid().notNull(),
    /** Who paid (ADR 0006 §3). */
    accountId: uuid().notNull(),
    /** Set on split children. */
    parentId: uuid(),
    /** On a split parent. Totals only count rows without splits. */
    hasSplits: boolean().notNull().default(false),
    /** Positive = money in, negative = money out (data model §1). */
    amountMinor: money('amount_minor').notNull(),
    currency: char({ length: 3 }).notNull(),
    postedDate: date({ mode: 'string' }),
    authorizedDate: date({ mode: 'string' }).notNull(),
    /** A member moved it to another day (#281). Sync and imports never write it. */
    dateOverride: date({ mode: 'string' }),
    /**
     * The day it counts on: the override, else the posted date, else the authorized date.
     * Households on the "authorized date" basis use `effectiveAuthorizedDate` instead (#69).
     */
    effectiveDate: date({ mode: 'string' })
      .notNull()
      .generatedAlwaysAs(
        (): SQL =>
          sql`coalesce(${transactions.dateOverride}, ${transactions.postedDate}, ${transactions.authorizedDate})`,
      ),
    /** The same, for households that count purchases on the day they were made (#69). */
    effectiveAuthorizedDate: date({ mode: 'string' })
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`coalesce(${transactions.dateOverride}, ${transactions.authorizedDate})`,
      ),
    pending: boolean().notNull().default(false),
    /** As the bank or file had it. Untrusted text (ADR 0009). */
    originalDescription: text().notNull(),
    displayName: text().notNull(),
    categoryId: uuid(),
    reviewStatus: reviewStatus().notNull().default('needs_review'),
    excluded: boolean().notNull().default(false),
    transferGroupId: uuid(),
    isSettlement: boolean().notNull().default(false),
    /** Null = inherit from the account. */
    isBusiness: boolean(),
    foreignAmountMinor: money('foreign_amount_minor'),
    foreignCurrency: char({ length: 3 }),
    source: transactionSource().notNull(),
    providerTransactionId: text(),
    providerPendingId: text(),
    importBatchId: uuid(),
    /**
     * The account an import put it in. Moving it to another account (TXN-12) keeps this, so
     * importing the same file again recognizes it. No foreign key: it's a historical reference.
     */
    importAccountId: uuid(),
    dedupeKey: text(),
    deletedAt: timestamp({ withTimezone: true }),
    ...versioning(),
    ...timestamps(),
  },
  (t) => [
    unique('transactions_household_id_id').on(t.householdId, t.id),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.parentId],
      foreignColumns: [t.householdId, t.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.categoryId],
      foreignColumns: [categories.householdId, categories.id],
    }),
    foreignKey({
      columns: [t.householdId, t.importBatchId],
      foreignColumns: [importBatches.householdId, importBatches.id],
    }),
    index().on(t.importBatchId),
    index('transactions_list')
      .on(t.householdId, t.effectiveDate.desc(), t.id.desc())
      .where(sql`${t.deletedAt} IS NULL AND ${t.hasSplits} = false`),
    index('transactions_list_authorized')
      .on(t.householdId, t.effectiveAuthorizedDate.desc(), t.id.desc())
      .where(sql`${t.deletedAt} IS NULL AND ${t.hasSplits} = false`),
    index().on(t.accountId, t.effectiveDate.desc()),
    index().on(t.householdId, t.categoryId, t.effectiveDate),
    index().on(t.parentId),
    index('transactions_review_queue')
      .on(t.householdId)
      .where(sql`${t.reviewStatus} = 'needs_review' AND ${t.deletedAt} IS NULL`),
    uniqueIndex('transactions_provider')
      .on(t.accountId, t.providerTransactionId)
      .where(sql`${t.providerTransactionId} IS NOT NULL`),
    index('transactions_import_dedupe')
      .on(t.importAccountId, t.dedupeKey)
      .where(sql`${t.importAccountId} IS NOT NULL`),
    uniqueIndex('transactions_dedupe')
      .on(t.accountId, t.dedupeKey)
      .where(sql`${t.source} = 'import' AND ${t.dedupeKey} IS NOT NULL`),
    check('transactions_currency', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('transactions_parent', sql`${t.parentId} IS NULL OR ${t.hasSplits} = false`),
    // A posted transaction of nothing means nothing; a pending $0 hold (card check) is real.
    check('transactions_nonzero', sql`${t.amountMinor} <> 0 OR ${t.pending}`),
  ],
);

/** Who a transaction is for, in shares. No rows = the paying account's owners (ADR 0006 §3). */
export const transactionAttributions = pgTable(
  'transaction_attributions',
  {
    transactionId: uuid().notNull(),
    memberId: uuid().notNull(),
    householdId: uuid().notNull(),
    shareBps: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.memberId] }),
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    index().on(t.memberId, t.transactionId),
    check('transaction_attributions_share', sql`${t.shareBps} BETWEEN 1 AND 10000`),
  ],
);

export const transactionTags = pgTable(
  'transaction_tags',
  {
    transactionId: uuid().notNull(),
    tagId: uuid().notNull(),
    householdId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.tagId] }),
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.tagId],
      foreignColumns: [tags.householdId, tags.id],
    }).onDelete('cascade'),
    index().on(t.tagId),
  ],
);

/** A shared note (no author) or a member's private note, encrypted (data model, NOTE-01–04). */
export const transactionNotes = pgTable(
  'transaction_notes',
  {
    id: id(),
    householdId: uuid().notNull(),
    transactionId: uuid().notNull(),
    /** Null = the shared note; otherwise private to this member. */
    authorMemberId: uuid(),
    bodyEnc: bytea('body_enc').notNull(),
    updatedByMemberId: uuid().notNull(),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
    }).onDelete('cascade'),
    uniqueIndex('transaction_notes_shared')
      .on(t.transactionId)
      .where(sql`${t.authorMemberId} IS NULL`),
    uniqueIndex('transaction_notes_private')
      .on(t.transactionId, t.authorMemberId)
      .where(sql`${t.authorMemberId} IS NOT NULL`),
  ],
);
