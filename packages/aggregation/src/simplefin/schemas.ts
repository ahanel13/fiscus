// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// The fields of SimpleFIN's Account Set (protocol v2) that Fiscus reads. Unknown fields pass
// (additive changes aren't breaking); what's read is checked. Amounts are numeric strings,
// times are epoch seconds. Names and descriptions are untrusted text.

const epoch = z.number().int().nonnegative();
const numeric = z.string().regex(/^-?\d+(\.\d+)?$/);

export const simpleFinTransactionSchema = z.object({
  id: z.string().min(1).max(500),
  /** 0 while pending, at some Bridges. */
  posted: epoch,
  /** Positive = money in, as in Fiscus. */
  amount: numeric,
  description: z.string().max(2000).default(''),
  transacted_at: epoch.optional(),
  pending: z.boolean().optional(),
});
export type SimpleFinTransaction = z.infer<typeof simpleFinTransactionSchema>;

export const simpleFinAccountSchema = z.object({
  id: z.string().min(1).max(500),
  name: z.string().max(500),
  conn_id: z.string().max(500).optional(),
  /** ISO 4217, or a custom currency's URL (not supported). */
  currency: z.string().max(500),
  balance: numeric,
  'available-balance': numeric.optional(),
  'balance-date': epoch,
  transactions: z.array(simpleFinTransactionSchema).max(100_000).optional(),
});
export type SimpleFinAccount = z.infer<typeof simpleFinAccountSchema>;

export const simpleFinErrorSchema = z.object({
  code: z.string().max(200),
  /** Display text from the Bridge: never logged or stored. */
  msg: z.string().max(2000).optional(),
  conn_id: z.string().max(500).optional(),
  account_id: z.string().max(500).optional(),
});

export const simpleFinConnectionSchema = z.object({
  conn_id: z.string().max(500),
  name: z.string().max(500),
  org_id: z.string().max(500).optional(),
  org_url: z.string().max(2000).optional(),
});

export const simpleFinAccountSetSchema = z.object({
  errlist: z.array(simpleFinErrorSchema).max(10_000).default([]),
  connections: z.array(simpleFinConnectionSchema).max(10_000).default([]),
  accounts: z.array(simpleFinAccountSchema).max(10_000),
});
export type SimpleFinAccountSet = z.infer<typeof simpleFinAccountSetSchema>;
