// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { optionalRangeFields, type RangeMeta } from '../ranges.js';
import { isoDateSchema, lensSchema, minorUnitsSchema } from './accounts.js';

// Categories, tags, and transactions (docs/design/transactions.md, permissions §4.3–4.6).

export const categoryKindSchema = z.enum([
  'income',
  'fixed',
  'flexible',
  'non_monthly',
  'savings',
  'transfer',
]);
export type CategoryKind = z.infer<typeof categoryKindSchema>;

const label = (max: number) => z.string().trim().min(1).max(max);

export const createCategoryGroupSchema = z.object({ name: label(60), kind: categoryKindSchema });
export const updateCategoryGroupSchema = z
  .object({ name: label(60), kind: categoryKindSchema, sortOrder: z.number().int().min(0) })
  .partial()
  .strict();

export const createCategorySchema = z.object({
  name: label(60),
  groupId: z.uuid(),
  icon: z.string().max(40).optional(),
});
export const updateCategorySchema = z
  .object({
    name: label(60),
    groupId: z.uuid(),
    icon: z.string().max(40).nullable(),
    sortOrder: z.number().int().min(0),
    archived: z.boolean(),
  })
  .partial()
  .strict();
/** Deleting a category in use moves its transactions to another (CAT-03). */
export const deleteCategoryQuerySchema = z.object({ replaceWith: z.uuid().optional() });

export interface Category {
  id: string;
  groupId: string;
  name: string;
  icon: string | null;
  systemKey: 'uncategorized' | 'transfer' | 'settlement' | null;
  archived: boolean;
  sortOrder: number;
}
export interface CategoryGroup {
  id: string;
  name: string;
  kind: CategoryKind;
  sortOrder: number;
  categories: Category[];
}

const tagColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A hex color like #2f6fdb');
export const createTagSchema = z.object({ name: label(40), color: tagColor });
export const updateTagSchema = z
  .object({ name: label(40), color: tagColor })
  .partial()
  .strict();
export interface Tag {
  id: string;
  name: string;
  color: string;
}

const attributionSchema = z
  .array(z.object({ memberId: z.uuid(), shareBps: z.number().int().min(1).max(10000).optional() }))
  .max(20)
  .refine((a) => new Set(a.map((x) => x.memberId)).size === a.length, 'Each member once')
  .refine(
    (a) => a.every((x) => x.shareBps === undefined) || a.every((x) => x.shareBps !== undefined),
    'Give a share for every member, or for none (equal split)',
  )
  .refine(
    (a) => a[0]?.shareBps === undefined || a.reduce((s, x) => s + (x.shareBps ?? 0), 0) === 10000,
    'Shares must add up to 100% (10 000 basis points)',
  );
export type AttributionInput = z.infer<typeof attributionSchema>;

/** `[]` returns to inheriting from the paying account's owners. */
export const setAttributionSchema = z.object({ attribution: attributionSchema });

const description = label(200);

/** A transaction or split part of nothing means nothing; only a pending hold can be $0. */
const nonZeroAmount = (message: string) => minorUnitsSchema.refine((n) => n !== 0, message);

export const createTransactionSchema = z.object({
  accountId: z.uuid(),
  amountMinor: nonZeroAmount('Enter an amount'),
  date: isoDateSchema,
  displayName: description,
  categoryId: z.uuid().nullable().optional(),
  tagIds: z.array(z.uuid()).max(20).optional(),
  attribution: attributionSchema.optional(),
});

export const updateTransactionSchema = z
  .object({
    displayName: description,
    /** Manual transactions only (TXN-03). Never zero (only pending holds can be). */
    amountMinor: nonZeroAmount('Enter an amount'),
    /** Manual: the date. Imported: a date override, or null to go back to the bank's (#281). */
    date: isoDateSchema.nullable(),
    categoryId: z.uuid().nullable(),
    reviewStatus: z.enum(['needs_review', 'reviewed']),
    excluded: z.boolean(),
    isBusiness: z.boolean().nullable(),
    tagIds: z.array(z.uuid()).max(20),
  })
  .partial()
  .strict();

export const bulkUpdateTransactionsSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(500),
  changes: z
    .object({
      categoryId: z.uuid().nullable(),
      reviewStatus: z.enum(['needs_review', 'reviewed']),
      excluded: z.boolean(),
      addTagIds: z.array(z.uuid()).max(20),
      removeTagIds: z.array(z.uuid()).max(20),
    })
    .partial()
    .strict()
    .refine((c) => Object.keys(c).length > 0, 'Nothing to change'),
});

export const setSplitsSchema = z.object({
  parts: z
    .array(
      z.object({
        amountMinor: nonZeroAmount('A part can’t be zero'),
        categoryId: z.uuid().nullable().optional(),
        displayName: description.optional(),
        attribution: attributionSchema.optional(),
      }),
    )
    .min(2)
    .max(50),
});

export const noteSchema = z.object({ body: z.string().trim().min(1).max(5000) });

const csv = z
  .string()
  .transform((s) => s.split(',').filter(Boolean))
  .pipe(z.array(z.uuid()).max(100));

export const transactionsQuerySchema = z.object({
  lens: lensSchema.default('all'),
  /** A preset or `custom` (with from/to); plain from/to also work on their own. */
  range: optionalRangeFields.range,
  accounts: csv.optional(),
  categories: csv.optional(),
  tags: csv.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  minAmount: z.coerce.number().int().optional(),
  maxAmount: z.coerce.number().int().optional(),
  review: z.enum(['needs_review', 'reviewed']).optional(),
  includeExcluded: z.enum(['true', 'false']).default('true'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface Transaction {
  id: string;
  /** The day it counts on (override, else posted, else authorized). */
  date: string;
  /** As the bank or file reported it. */
  reportedDate: string;
  /** A member moved it to another day (#281). */
  dateEdited: boolean;
  amountMinor: number;
  currency: string;
  displayName: string;
  originalDescription: string;
  categoryId: string | null;
  reviewStatus: 'needs_review' | 'reviewed';
  excluded: boolean;
  pending: boolean;
  source: 'provider' | 'import' | 'manual';
  isBusiness: boolean | null;
  /**
   * The paying account, or null when you see this transaction only because it's attributed to
   * you (F1): then only `paidBy` says who paid, never which account.
   */
  account: { id: string; name: string; mask: string | null } | null;
  /** Members who own the paying account. */
  paidBy: string[];
  /** Who it's for. `inherited` = no explicit attribution, so the paying account's owners. */
  attribution: { memberId: string; shareBps: number }[];
  attributionInherited: boolean;
  tagIds: string[];
  sharedNote: string | null;
  myNote: string | null;
  parentId: string | null;
  hasSplits: boolean;
  /** What you may do with it (permissions §4.3–4.5). */
  can: {
    categorize: boolean;
    edit: boolean;
    attribute: boolean;
    writeSharedNote: boolean;
  };
  version: number;
}

export interface BulkUpdateResult {
  updated: string[];
  refused: {
    id: string;
    code: 'not_found' | 'forbidden' | 'not_editable' | 'different_currency' | 'already_there';
  }[];
}

/** Moves transactions to another account (TXN-12). Splits move with all their parts. */
export const moveTransactionsSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(500),
  accountId: z.uuid(),
});

export const cashFlowQuerySchema = z
  .object({ lens: lensSchema.default('all'), ...optionalRangeFields })
  .extend({
    range: optionalRangeFields.range.default('last_6m'),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine((q) => q.range !== 'custom' || (q.from && q.to), 'A custom range needs "from" and "to"');

export interface CashFlowBucket {
  start: string;
  end: string;
  /** Not over yet, or cut off by the range (ADR 0011 §3). */
  partial: boolean;
  /** Null before the first transaction in view: no data, not zero. */
  incomeMinor: number | null;
  spendingMinor: number | null;
  netMinor: number | null;
}

export interface CashFlow {
  currency: string;
  range: RangeMeta;
  buckets: CashFlowBucket[];
  totals: { incomeMinor: number; spendingMinor: number; netMinor: number };
  /** Per bucket, over complete buckets with data only. */
  averages: { incomeMinor: number | null; spendingMinor: number | null; netMinor: number | null };
  comparison: { incomeMinor: number; spendingMinor: number; netMinor: number } | null;
  /** Transactions left out because they're in another currency (#43). */
  unconverted: { currency: string; transactions: number }[];
}

export const preferenceKeySchema = z
  .string()
  .regex(/^[a-z0-9:_-]{1,64}$/, 'Invalid preference key');
export const setPreferenceSchema = z.object({
  value: z.json().refine((v) => JSON.stringify(v).length <= 2000, 'Preference is too large'),
});
