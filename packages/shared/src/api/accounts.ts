// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { currencyCodeSchema } from './households.js';

// Accounts, ownership, visibility, balances, and net worth
// (docs/design/accounts-and-visibility.md, ADR 0006, permissions §3 and §4.2).

export const accountTypeSchema = z.enum([
  'depository',
  'credit',
  'loan',
  'investment',
  'property',
  'vehicle',
  'crypto',
  'other',
]);
export type AccountType = z.infer<typeof accountTypeSchema>;

export const accountVisibilitySchema = z.enum(['full', 'view_only', 'balance_only', 'private']);
export type AccountVisibility = z.infer<typeof accountVisibilitySchema>;

/** What the viewer may do with an account, lowest first. */
export type AccessLevel = 'balance_only' | 'view_only' | 'full' | 'owner';

export const balanceModeSchema = z.enum(['transactions', 'value']);
export type BalanceMode = z.infer<typeof balanceModeSchema>;

/** Whose money a view shows (ADR 0006 §5): always intersected with what the viewer can see. */
export const lensSchema = z.union([
  z.enum(['all', 'me', 'shared']),
  z.templateLiteral(['member:', z.uuid()]),
]);
export type Lens = z.infer<typeof lensSchema>;

/** A calendar date, "YYYY-MM-DD". */
export const isoDateSchema = z.iso.date();

/** Money in integer minor units (cents), never a float (API conventions §2). */
export const minorUnitsSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger, 'Amount is too large');

const ownersSchema = z
  .array(
    z.object({
      memberId: z.uuid(),
      /** Basis points (1–10 000). Omit on every owner for an equal split. */
      shareBps: z.number().int().min(1).max(10000).optional(),
    }),
  )
  .min(1)
  .max(20)
  .refine((o) => new Set(o.map((x) => x.memberId)).size === o.length, 'Each owner once')
  .refine(
    (o) => o.every((x) => x.shareBps === undefined) || o.every((x) => x.shareBps !== undefined),
    'Give a share for every owner, or for none (equal split)',
  )
  .refine(
    (o) =>
      o[0]?.shareBps === undefined || o.reduce((sum, x) => sum + (x.shareBps ?? 0), 0) === 10000,
    'Shares must add up to 100% (10 000 basis points)',
  );
export type OwnersInput = z.infer<typeof ownersSchema>;

const accountName = z.string().trim().min(1).max(120);
const mask = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z]{4}$/, 'Four characters');
const notes = z.string().max(5000);

export const createAccountSchema = z.object({
  name: accountName,
  type: accountTypeSchema,
  subtype: z.string().trim().min(1).max(60).optional(),
  /** Defaults to the household's base currency. */
  currency: currencyCodeSchema.optional(),
  /** Defaults to the household's finance style (ADR 0006 §8). */
  visibility: accountVisibilitySchema.optional(),
  /** Defaults by type: bank-style accounts follow transactions, assets are valued by hand. */
  balanceMode: balanceModeSchema.optional(),
  /** Defaults to you alone (or everyone, in a Combined household). */
  owners: ownersSchema.optional(),
  openingBalance: z
    .object({ amountMinor: minorUnitsSchema, asOf: isoDateSchema.optional() })
    .optional(),
  mask: mask.optional(),
  notes: notes.optional(),
  includeInNetWorth: z.boolean().optional(),
  isBusiness: z.boolean().optional(),
});

export const updateAccountSchema = z
  .object({
    name: accountName,
    subtype: z.string().trim().min(1).max(60).nullable(),
    visibility: accountVisibilitySchema,
    balanceMode: balanceModeSchema,
    includeInNetWorth: z.boolean(),
    isBusiness: z.boolean(),
    sortOrder: z.number().int().min(0).max(1_000_000),
    mask: mask.nullable(),
    notes: notes.nullable(),
  })
  .partial()
  .strict();

export const setOwnersSchema = z.object({ owners: ownersSchema });

export const setBalanceSchema = z.object({
  amountMinor: minorUnitsSchema,
  availableMinor: minorUnitsSchema.nullable().optional(),
  creditLimitMinor: minorUnitsSchema.nullable().optional(),
});

export const accountsQuerySchema = z.object({
  lens: lensSchema.default('all'),
  include: z.enum(['open', 'closed']).default('open'),
});

/** Date windows until shared time ranges land on every endpoint (#64, #65). */
export const dateWindowSchema = z
  .object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
  .refine((w) => !w.from || !w.to || w.from <= w.to, '"from" must not be after "to"');

export const netWorthQuerySchema = z
  .object({ lens: lensSchema.default('all') })
  .and(dateWindowSchema);

export interface AccountOwner {
  memberId: string;
  shareBps: number;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  currency: string;
  mask: string | null;
  visibility: AccountVisibility;
  balanceMode: BalanceMode;
  includeInNetWorth: boolean;
  isBusiness: boolean;
  sortOrder: number;
  closedAt: string | null;
  owners: AccountOwner[];
  /** What you may do with it. Owners see everything; see permissions §3 for the rest. */
  yourAccess: AccessLevel;
  /** The latest balance, if any. */
  balance: { amountMinor: number; asOf: string } | null;
  /** Shared account notes: present at `view_only` and above. */
  notes?: string | null;
  version: number;
}

export interface BalancePoint {
  asOf: string;
  amountMinor: number;
  availableMinor: number | null;
  creditLimitMinor: number | null;
  source: 'provider' | 'computed' | 'manual';
}

export interface NetWorth {
  /** Household base currency. */
  currency: string;
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  /** One point per day, carrying each account's last balance forward (ADR 0011). */
  series: { date: string; netWorthMinor: number }[];
  /**
   * Visible accounts left out because they're in another currency. Conversion arrives with
   * multi-currency support (#43).
   */
  unconverted: { currency: string; accounts: number }[];
}
