// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import {
  accountTypeSchema,
  accountVisibilitySchema,
  balanceModeSchema,
  isoDateSchema,
  minorUnitsSchema,
} from './accounts.js';
import { categoryKindSchema } from './ledger.js';

// File imports (docs/design/imports.md, permissions TXN-09/10). The browser parses the file; the
// server receives these rows, checks every one, and stores only the resulting transactions.

export const importFormatSchema = z.enum(['csv', 'monarch']);
export type ImportFormat = z.infer<typeof importFormatSchema>;

export const IMPORT_LIMITS = {
  transactions: 50_000,
  /** Ten years of daily balances for 50 accounts. */
  balances: 200_000,
  accounts: 200,
  categories: 500,
  /** Transactions per rows request; files go up in parts (docs/design/imports.md §1). */
  rowsPerRequest: 5_000,
  /** Request body, in bytes. */
  bodyBytes: 25 * 1024 * 1024,
} as const;

/** A transaction as read from the file. */
export const importRowSchema = z.object({
  /** The file line it came from, for messages. */
  line: z.number().int().min(1),
  date: isoDateSchema,
  amountMinor: minorUnitsSchema,
  /** The bank's text: the original description and, without `name`, the starting name. */
  description: z.string().max(500),
  name: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  /** Becomes the shared note. */
  note: z.string().max(5000).optional(),
  /** The bank's or Monarch's own id: the dedupe key when present. */
  externalId: z.string().min(1).max(100).optional(),
  /** Imported as reviewed (Monarch) or needing review (default). */
  reviewed: z.boolean().optional(),
  /** A person's name (Monarch's Owner column), mapped to a member in `members`. */
  owner: z.string().max(100).optional(),
});
export type ImportRow = z.infer<typeof importRowSchema>;

/** A row in a whole file: `account` is the key of an entry in `accounts`. */
export const importTransactionSchema = importRowSchema.extend({
  account: z.string().min(1).max(200),
});
export type ImportTransaction = z.infer<typeof importTransactionSchema>;

export const importBalanceSchema = z.object({
  account: z.string().min(1).max(200),
  date: isoDateSchema,
  balanceMinor: minorUnitsSchema,
});
export type ImportBalance = z.infer<typeof importBalanceSchema>;

/** Where one account in the file goes: an existing account, or a new one. */
export const importAccountSchema = z
  .object({
    key: z.string().min(1).max(200),
    accountId: z.uuid().optional(),
    create: z
      .object({
        name: z.string().trim().min(1).max(120),
        type: accountTypeSchema,
        balanceMode: balanceModeSchema.optional(),
        visibility: accountVisibilitySchema.optional(),
        owners: z
          .array(z.object({ memberId: z.uuid() }))
          .min(1)
          .max(20)
          .optional(),
      })
      .optional(),
    /** Closed from this day on (the day after its last balance). */
    closeOn: isoDateSchema.optional(),
    /** Leave this account's rows out. */
    skip: z.boolean().optional(),
    /**
     * Goes into the same account as another account in the file (the key of that entry): one
     * account that Monarch replaced with another, such as a vehicle re-added with automatic
     * valuation. Its close date is ignored.
     */
    sameAs: z.string().min(1).max(200).optional(),
  })
  .refine(
    (a) =>
      a.skip === true ||
      [a.accountId, a.create, a.sameAs].filter((x) => x !== undefined).length === 1,
    'Choose an existing account, create one, or combine it with another',
  );
export type ImportAccount = z.infer<typeof importAccountSchema>;

/**
 * Where a category name goes. Names without an entry match an existing category by name, or are
 * created (docs/design/imports.md §2).
 */
export const importCategorySchema = z.object({
  name: z.string().min(1).max(100),
  categoryId: z.uuid().optional(),
  /** For a new category: its kind, which picks the group it goes in. */
  kind: categoryKindSchema.optional(),
});

/** A person named in the file → a member, or nobody (no attribution). */
export const importMemberSchema = z.object({
  name: z.string().min(1).max(100),
  memberId: z.uuid().nullable(),
});

/** How a file maps onto the household: where each account, category, and person goes. */
const importMappingFields = {
  format: importFormatSchema,
  filename: z.string().trim().min(1).max(255),
  profileId: z.uuid().optional(),
  accounts: z.array(importAccountSchema).min(1).max(IMPORT_LIMITS.accounts),
  categories: z.array(importCategorySchema).max(IMPORT_LIMITS.categories).default([]),
  members: z.array(importMemberSchema).max(50).default([]),
};

/** The whole file, for the preview: nothing is saved. */
export const importRequestSchema = z.object({
  ...importMappingFields,
  transactions: z.array(importTransactionSchema).max(IMPORT_LIMITS.transactions).default([]),
  balances: z.array(importBalanceSchema).max(IMPORT_LIMITS.balances).default([]),
  /** Lines of possible duplicates to import anyway. */
  includeOverlaps: z.array(z.number().int().min(1)).max(IMPORT_LIMITS.transactions).default([]),
});
export type ImportRequest = z.input<typeof importRequestSchema>;

/**
 * Starts an import run: creates the new accounts, categories, and tags, closes accounts the file
 * shows closed, and opens a batch per account. Rows follow per batch.
 */
export const startImportSchema = z.object({
  ...importMappingFields,
  /** Every tag name in the file, so they exist before rows arrive. */
  tags: z.array(z.string().trim().min(1).max(100)).max(IMPORT_LIMITS.categories).default([]),
  /** Every category name in the file, likewise. */
  categoryNames: z
    .array(z.string().trim().min(1).max(100))
    .max(IMPORT_LIMITS.categories)
    .default([]),
});
export type StartImport = z.input<typeof startImportSchema>;

export interface ImportRun {
  runId: string;
  batches: { key: string; batchId: string; accountId: string }[];
}

/**
 * One part of an account's rows. Keep each day's rows in one request (chunkRowsByDate), so two
 * identical purchases on one day are counted as two. Send an account's balances after its
 * transactions, all in one request.
 */
export const importRowsSchema = z.object({
  transactions: z.array(importRowSchema).max(IMPORT_LIMITS.rowsPerRequest).default([]),
  balances: z
    .array(importBalanceSchema.omit({ account: true }))
    .max(IMPORT_LIMITS.balances)
    .default([]),
  includeOverlaps: z.array(z.number().int().min(1)).max(IMPORT_LIMITS.rowsPerRequest).default([]),
});
export type ImportRows = z.input<typeof importRowsSchema>;

export interface ImportRowsResult {
  added: number;
  balances: number;
  /** Of those added, how many your rules changed (renamed, categorized, …). */
  changedByRules: number;
  /** Rows that aren't simply new. */
  rows: ImportRowResult[];
}

export type ImportRowStatus =
  | 'new'
  /** Imported before (same dedupe key): skipped. */
  | 'duplicate'
  /** Looks like a transaction already in the account: left out unless ticked. */
  | 'overlap'
  /** $0, or its account is skipped. */
  | 'skipped'
  | 'error';

export interface ImportRowResult {
  line: number;
  status: ImportRowStatus;
  /** For overlaps: the existing transaction it may duplicate. */
  matchId?: string;
  message?: string;
}

export interface ImportAccountSummary {
  key: string;
  /** The existing account, or null for one the import creates. */
  accountId: string | null;
  name: string;
  new: number;
  duplicates: number;
  overlaps: number;
  skipped: number;
  errors: number;
  /** Balances stored: days the balance changed, or with transactions (docs/design/imports.md §2). */
  balances: number;
  closeOn: string | null;
}

export interface ImportPreview {
  accounts: ImportAccountSummary[];
  /** Categories the import creates, and the group each goes in. */
  newCategories: { name: string; kind: z.infer<typeof categoryKindSchema>; group: string }[];
  newTags: string[];
  /** Rows that aren't simply new (duplicates, overlaps, skipped, errors). */
  rows: ImportRowResult[];
  totals: { new: number; duplicates: number; overlaps: number; skipped: number; errors: number };
}

export interface ImportBatch {
  id: string;
  /** Batches from one file share a run. */
  runId: string;
  accountId: string;
  /** Null when the account is hidden from you or was removed. */
  accountName: string | null;
  memberId: string;
  format: ImportFormat | 'ofx' | 'qfx';
  filename: string;
  transactionCount: number;
  balanceCount: number;
  createdAt: string;
  revertedAt: string | null;
  /** You imported it, or own the account (TXN-10). */
  canRevert: boolean;
}

/** A saved column mapping for a bank's CSV files. */
export const csvMappingSchema = z.object({
  date: z.string().min(1).max(200),
  dateFormat: z.enum(['ymd', 'mdy', 'dmy', 'text']),
  amount: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('signed'),
      column: z.string().min(1).max(200),
      /** The bank shows spending as positive. */
      negate: z.boolean(),
    }),
    z.object({
      kind: z.literal('split'),
      debit: z.string().min(1).max(200),
      credit: z.string().min(1).max(200),
    }),
  ]),
  decimal: z.enum(['.', ',']),
  description: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
  notes: z.string().max(200).optional(),
  tags: z.string().max(200).optional(),
  account: z.string().max(200).optional(),
  id: z.string().max(200).optional(),
});
export type CsvMapping = z.infer<typeof csvMappingSchema>;

export const createImportProfileSchema = z.object({
  name: z.string().trim().min(1).max(60),
  headers: z.array(z.string().max(200)).min(1).max(100),
  mapping: csvMappingSchema,
});
export const updateImportProfileSchema = createImportProfileSchema.partial().strict();

export interface ImportProfile {
  id: string;
  name: string;
  headers: string[];
  mapping: CsvMapping;
  updatedAt: string;
}
