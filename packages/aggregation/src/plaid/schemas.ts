// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// Plaid's responses, as far as Fiscus reads them. Only the fields used are listed; unknown fields
// are dropped, not refused, so Plaid can add fields without breaking anything. Plaid sends null
// for most absent values, hence `nullish`. Everything is in Plaid's terms (positive amount =
// money out, decimal amounts); the adapter translates (#80).

const nullishString = z.string().nullish();
const nullishNumber = z.number().nullish();

/** Every response carries one; safe to log, and what Plaid support asks for. */
const requestId = { request_id: z.string().optional() };

export const plaidErrorSchema = z.object({
  error_type: z.string(),
  error_code: z.string(),
  /** Untrusted text: kept only as `ProviderError.providerMessage`, never logged. */
  error_message: nullishString,
  display_message: nullishString,
  request_id: z.string().optional(),
});
export type PlaidErrorBody = z.infer<typeof plaidErrorSchema>;

export const plaidBalancesSchema = z.object({
  available: nullishNumber,
  current: nullishNumber,
  limit: nullishNumber,
  iso_currency_code: nullishString,
  unofficial_currency_code: nullishString,
  last_updated_datetime: nullishString,
});

export const plaidAccountSchema = z.object({
  account_id: z.string(),
  name: z.string(),
  official_name: nullishString,
  /** `depository`, `credit`, `loan`, `investment`, `other`; text, so a new type isn't refused. */
  type: z.string(),
  subtype: nullishString,
  mask: nullishString,
  balances: plaidBalancesSchema,
});
export type PlaidAccount = z.infer<typeof plaidAccountSchema>;

export const plaidItemSchema = z.object({
  item_id: z.string(),
  institution_id: nullishString,
  webhook: nullishString,
  error: plaidErrorSchema.omit({ request_id: true }).nullish(),
  consent_expiration_time: nullishString,
  products: z.array(z.string()).optional(),
  billed_products: z.array(z.string()).optional(),
});
export type PlaidItem = z.infer<typeof plaidItemSchema>;

export const plaidTransactionSchema = z.object({
  transaction_id: z.string(),
  account_id: z.string(),
  /** Plaid's sign: positive = money out. */
  amount: z.number(),
  iso_currency_code: nullishString,
  unofficial_currency_code: nullishString,
  pending: z.boolean(),
  pending_transaction_id: nullishString,
  /** The posted date, or for a pending transaction the date it happened. */
  date: z.string(),
  authorized_date: nullishString,
  /** As the bank reports it. Untrusted text (ADR 0009). */
  name: nullishString,
  original_description: nullishString,
  merchant_name: nullishString,
});
export type PlaidTransaction = z.infer<typeof plaidTransactionSchema>;

export const plaidRemovedTransactionSchema = z.object({
  transaction_id: z.string(),
  account_id: nullishString,
});

export const linkTokenCreateResponseSchema = z.object({
  ...requestId,
  link_token: z.string(),
  expiration: z.string(),
});

export const publicTokenExchangeResponseSchema = z.object({
  ...requestId,
  access_token: z.string(),
  item_id: z.string(),
});

export const accountsGetResponseSchema = z.object({
  ...requestId,
  accounts: z.array(plaidAccountSchema),
  item: plaidItemSchema,
});

export const institutionsGetByIdResponseSchema = z.object({
  ...requestId,
  institution: z.object({
    institution_id: z.string(),
    name: z.string(),
    url: nullishString,
    logo: nullishString,
    primary_color: nullishString,
  }),
});

export const transactionsSyncResponseSchema = z.object({
  ...requestId,
  added: z.array(plaidTransactionSchema),
  modified: z.array(plaidTransactionSchema),
  removed: z.array(plaidRemovedTransactionSchema),
  next_cursor: z.string(),
  has_more: z.boolean(),
  /** `HISTORICAL_UPDATE_COMPLETE` once all history has arrived. */
  transactions_update_status: z.string().optional(),
  accounts: z.array(plaidAccountSchema).optional(),
});
export type TransactionsSyncResponse = z.infer<typeof transactionsSyncResponseSchema>;

export const emptyResponseSchema = z.object({ ...requestId });

const apr = z.object({
  apr_percentage: z.number(),
  apr_type: z.string(),
  balance_subject_to_apr: nullishNumber,
});

export const liabilitiesGetResponseSchema = z.object({
  ...requestId,
  accounts: z.array(plaidAccountSchema),
  item: plaidItemSchema,
  liabilities: z.object({
    credit: z
      .array(
        z.object({
          account_id: nullishString,
          aprs: z.array(apr),
          is_overdue: z.boolean().nullish(),
          last_payment_amount: nullishNumber,
          last_payment_date: nullishString,
          last_statement_balance: nullishNumber,
          last_statement_issue_date: nullishString,
          minimum_payment_amount: nullishNumber,
          next_payment_due_date: nullishString,
        }),
      )
      .nullish(),
    student: z
      .array(
        z.object({
          account_id: nullishString,
          interest_rate_percentage: z.number(),
          last_statement_balance: nullishNumber,
          last_statement_issue_date: nullishString,
          minimum_payment_amount: nullishNumber,
          next_payment_due_date: nullishString,
        }),
      )
      .nullish(),
    mortgage: z
      .array(
        z.object({
          account_id: z.string(),
          interest_rate: z.object({ percentage: nullishNumber, type: nullishString }),
          next_monthly_payment: nullishNumber,
          next_payment_due_date: nullishString,
        }),
      )
      .nullish(),
  }),
});
export type LiabilitiesGetResponse = z.infer<typeof liabilitiesGetResponseSchema>;

export const itemGetResponseSchema = z.object({
  ...requestId,
  item: plaidItemSchema,
  status: z
    .object({
      transactions: z
        .object({
          last_successful_update: nullishString,
          last_failed_update: nullishString,
        })
        .nullish(),
    })
    .nullish(),
});

export const itemWebhookUpdateResponseSchema = z.object({ ...requestId, item: plaidItemSchema });

/** The JWK a webhook's `Plaid-Verification` JWT is checked against (ADR 0008). */
export const webhookVerificationKeyGetResponseSchema = z.object({
  ...requestId,
  key: z.object({
    alg: z.string(),
    crv: z.string(),
    kid: z.string(),
    kty: z.string(),
    use: z.string(),
    x: z.string(),
    y: z.string(),
    created_at: z.number(),
    expired_at: nullishNumber,
  }),
});
