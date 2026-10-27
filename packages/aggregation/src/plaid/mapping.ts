// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ProviderAccount,
  ProviderAccountType,
  ProviderBalance,
  ProviderInstitution,
  ProviderLiability,
  ProviderRemovedTransaction,
  ProviderTransaction,
} from '@fiscus/domain';
import { minorUnitExponent } from '@fiscus/shared';
import type {
  InstitutionsGetByIdResponse,
  LiabilitiesGetResponse,
  PlaidAccount,
  PlaidTransaction,
  TransactionsSyncResponse,
} from './schemas.js';

// Plaid's terms as Fiscus's (#82), shared by the api (connecting) and the worker (sync). Plaid's
// amounts are decimals with positive = money out of the account (TXN-005), and a card's or loan's
// balance owed is positive; Fiscus keeps integer minor units with negative = money out, and what's
// owed is negative. Nothing past here sees Plaid's sign.

const TYPES: Record<string, ProviderAccountType> = {
  depository: 'depository',
  credit: 'credit',
  loan: 'loan',
  investment: 'investment',
  // Plaid's older name for investment accounts.
  brokerage: 'investment',
};

/** Plaid's account type in Fiscus's terms; anything new is `other` (ITEM-009). */
export const plaidAccountType = (type: string): ProviderAccountType => TYPES[type] ?? 'other';

/** Plaid reports what a card or a loan owes as positive; Fiscus as negative. */
const owedSign = (type: string): 1 | -1 => {
  const t = plaidAccountType(type);
  return t === 'credit' || t === 'loan' ? -1 : 1;
};

/**
 * A Plaid decimal amount in the currency's minor units, never through a float that's kept: the
 * product is rounded to an integer at once (`|| 0` so there's no -0). Null for a currency Fiscus
 * can't represent, or an amount past a safe integer.
 */
export function plaidMinor(amount: number, currency: string): number | null {
  let exponent: number;
  try {
    exponent = minorUnitExponent(currency);
  } catch {
    return null;
  }
  if (!Number.isFinite(amount)) return null;
  const minor = Math.round(amount * 10 ** exponent) || 0;
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * The currency of a Plaid amount: `iso_currency_code`, else `unofficial_currency_code` (TXN-005),
 * when it's a code Fiscus can hold amounts in. Null otherwise; such rows are skipped.
 */
export function plaidCurrency(
  iso: string | null | undefined,
  unofficial: string | null | undefined,
): string | null {
  const code = iso || unofficial;
  if (!code) return null;
  try {
    minorUnitExponent(code);
    return code;
  } catch {
    return null;
  }
}

/**
 * The bank's current balance in Fiscus's sign and minor units. Null when Plaid has none, or no ISO
 * currency for it (the api offers accounts with this when connecting, #79).
 */
export function plaidCurrentBalance(
  account: PlaidAccount,
): { amountMinor: number; currency: string } | null {
  const { current, iso_currency_code: currency } = account.balances;
  if (current === null || current === undefined || !currency) return null;
  const amountMinor = plaidMinor(owedSign(account.type) * current, currency);
  return amountMinor === null ? null : { amountMinor, currency };
}

/** The last 4 characters of Plaid's mask, when they're what an account's mask may hold. */
export const plaidMask = (mask: string | null | undefined): string | null => {
  const last4 = mask?.trim().slice(-4);
  return last4 && /^[0-9A-Za-z]{4}$/.test(last4) ? last4 : null;
};

/** An account from `/accounts/get` (TXN-012: the authoritative list), or null without a currency. */
export function plaidProviderAccount(account: PlaidAccount): ProviderAccount | null {
  const currency = plaidCurrency(
    account.balances.iso_currency_code,
    account.balances.unofficial_currency_code,
  );
  if (!currency) return null;
  const mask = plaidMask(account.mask);
  return {
    providerAccountId: account.account_id,
    name: account.name,
    ...(account.official_name ? { officialName: account.official_name } : {}),
    type: plaidAccountType(account.type),
    ...(account.subtype ? { subtype: account.subtype } : {}),
    currency,
    ...(mask ? { mask } : {}),
  };
}

/**
 * An account's balances in Fiscus's sign: current negated for a card or loan; available (what can
 * still be spent or drawn) and the credit limit as they are. `asOf` is Plaid's
 * `last_updated_datetime`, which most banks leave null, else `now`. Null without a current balance
 * or a usable currency.
 */
export function plaidProviderBalance(account: PlaidAccount, now: Date): ProviderBalance | null {
  const b = account.balances;
  const currency = plaidCurrency(b.iso_currency_code, b.unofficial_currency_code);
  if (!currency || b.current === null || b.current === undefined) return null;
  const currentMinor = plaidMinor(owedSign(account.type) * b.current, currency);
  if (currentMinor === null) return null;
  const optional = (value: number | null | undefined) =>
    value === null || value === undefined ? null : plaidMinor(value, currency);
  const availableMinor = optional(b.available);
  const creditLimitMinor = optional(b.limit);
  const updated = b.last_updated_datetime ? new Date(b.last_updated_datetime) : null;
  return {
    providerAccountId: account.account_id,
    currency,
    currentMinor,
    ...(availableMinor !== null ? { availableMinor } : {}),
    ...(creditLimitMinor !== null ? { creditLimitMinor } : {}),
    asOf: (updated && !Number.isNaN(updated.getTime()) ? updated : now).toISOString(),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (d: string | null | undefined): d is string => !!d && DATE.test(d);

/**
 * A transaction in Fiscus's terms, or null when it can't be represented (no usable currency, or
 * no date). The amount's sign is reversed (TXN-005). A posted transaction keeps
 * `pending_transaction_id`, the pending one it replaces (TXN-004). The description is the bank's
 * own text (`original_description`, asked for with `include_original_description`, TXN-013),
 * else Plaid's `name`; the merchant is `merchant_name`, never `name` (TXN-023). Categories
 * (`personal_finance_category`, v2 pinned by the request, TXN-006) and `payment_channel` have no
 * place in Fiscus's transaction yet, so they aren't read; never the legacy `category` fields.
 */
export function plaidProviderTransaction(t: PlaidTransaction): ProviderTransaction | null {
  const currency = plaidCurrency(t.iso_currency_code, t.unofficial_currency_code);
  if (!currency || !isDate(t.date)) return null;
  const amountMinor = plaidMinor(-t.amount, currency);
  if (amountMinor === null) return null;
  const authorizedDate = isDate(t.authorized_date) ? t.authorized_date : t.date;
  const merchantName = t.merchant_name?.trim();
  return {
    providerTransactionId: t.transaction_id,
    providerAccountId: t.account_id,
    amountMinor,
    currency,
    pending: t.pending,
    ...(!t.pending && t.pending_transaction_id
      ? { pendingTransactionId: t.pending_transaction_id }
      : {}),
    // For a pending transaction Plaid's `date` is when it happened, not a posted date.
    ...(t.pending ? {} : { postedDate: t.date }),
    authorizedDate,
    description: t.original_description?.trim() || t.name?.trim() || merchantName || '',
    ...(merchantName ? { merchantName } : {}),
  };
}

/** A removal, or null without the account it was on (ingest matches by account). */
export function plaidRemovedTransaction(
  r: TransactionsSyncResponse['removed'][number],
): ProviderRemovedTransaction | null {
  return r.account_id
    ? { providerTransactionId: r.transaction_id, providerAccountId: r.account_id }
    : null;
}

/** A rate in percent as basis points (21.49% = 2149), or undefined for none or nonsense. */
const bps = (percentage: number | null | undefined): number | undefined =>
  percentage === null || percentage === undefined || !Number.isFinite(percentage) || percentage < 0
    ? undefined
    : Math.round(percentage * 100);

type CreditLiability = NonNullable<LiabilitiesGetResponse['liabilities']['credit']>[number];

/**
 * A card's purchase APR, chosen by `apr_type` and never by position (LIAB-003): the array can hold
 * cash, balance transfer, penalty and special rates, in any order, or be empty.
 */
export const purchaseAprBps = (aprs: CreditLiability['aprs']): number | undefined =>
  bps(aprs?.find((a) => a.apr_type === 'purchase_apr')?.apr_percentage);

/**
 * `/liabilities/get` in Fiscus's terms: cards, student loans and mortgages (Plaid's other loan
 * kinds have no place yet). Every field is nullable at some bank (LIAB-002), so each is read on its
 * own and left out when absent. Statement balances are what was owed, so negative; the minimum
 * payment is a positive amount due. A liability whose account has no usable currency is skipped.
 */
export function plaidLiabilities(response: LiabilitiesGetResponse): ProviderLiability[] {
  const currencies = new Map(
    response.accounts.map((a) => [
      a.account_id,
      plaidCurrency(a.balances.iso_currency_code, a.balances.unofficial_currency_code),
    ]),
  );
  const out: ProviderLiability[] = [];
  const add = (
    accountId: string | null | undefined,
    kind: ProviderLiability['kind'],
    fields: {
      aprBps?: number | undefined;
      lastStatementBalance?: number | null | undefined;
      lastStatementDate?: string | null | undefined;
      minimumPayment?: number | null | undefined;
      nextPaymentDueDate?: string | null | undefined;
    },
  ) => {
    const currency = accountId ? currencies.get(accountId) : null;
    if (!accountId || !currency) return;
    const owed =
      fields.lastStatementBalance === null || fields.lastStatementBalance === undefined
        ? null
        : plaidMinor(-fields.lastStatementBalance, currency);
    const minimum =
      fields.minimumPayment === null || fields.minimumPayment === undefined
        ? null
        : plaidMinor(fields.minimumPayment, currency);
    out.push({
      providerAccountId: accountId,
      kind,
      currency,
      ...(fields.aprBps !== undefined ? { aprBps: fields.aprBps } : {}),
      ...(owed !== null ? { lastStatementBalanceMinor: owed } : {}),
      ...(isDate(fields.lastStatementDate) ? { lastStatementDate: fields.lastStatementDate } : {}),
      ...(minimum !== null ? { minimumPaymentMinor: minimum } : {}),
      ...(isDate(fields.nextPaymentDueDate)
        ? { nextPaymentDueDate: fields.nextPaymentDueDate }
        : {}),
    });
  };
  const { credit, student, mortgage } = response.liabilities;
  for (const c of credit ?? []) {
    add(c.account_id, 'credit', {
      aprBps: purchaseAprBps(c.aprs),
      lastStatementBalance: c.last_statement_balance,
      lastStatementDate: c.last_statement_issue_date,
      minimumPayment: c.minimum_payment_amount,
      nextPaymentDueDate: c.next_payment_due_date,
    });
  }
  for (const s of student ?? []) {
    add(s.account_id, 'student', {
      aprBps: bps(s.interest_rate_percentage),
      lastStatementBalance: s.last_statement_balance,
      lastStatementDate: s.last_statement_issue_date,
      minimumPayment: s.minimum_payment_amount,
      nextPaymentDueDate: s.next_payment_due_date,
    });
  }
  for (const m of mortgage ?? []) {
    add(m.account_id, 'mortgage', {
      aprBps: bps(m.interest_rate?.percentage),
      minimumPayment: m.next_monthly_payment,
      nextPaymentDueDate: m.next_payment_due_date,
    });
  }
  return out;
}

/** Whether an Item has an account `/liabilities/get` covers: a card or a loan (LIAB-008). */
export const hasLiabilityAccounts = (accounts: PlaidAccount[]): boolean =>
  accounts.some((a) => {
    const type = plaidAccountType(a.type);
    return type === 'credit' || type === 'loan';
  });

/** The countries Fiscus asks Plaid about: Link's, and the institutions it shows. */
export const PLAID_COUNTRY_CODES = ['US', 'CA'];

/** Larger than any bank logo Plaid sends (they're small PNGs); anything bigger isn't kept. */
export const MAX_LOGO_BYTES = 64 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A bank's display data from `/institutions/get_by_id` with optional metadata (GUIDE-017, #423).
 * The logo is kept only if it's a PNG within `MAX_LOGO_BYTES`, and the color only as `#RRGGBB`:
 * what Fiscus serves back to browsers is never anything else.
 */
export function plaidInstitution(
  i: InstitutionsGetByIdResponse['institution'],
): ProviderInstitution {
  const out: ProviderInstitution = { providerInstitutionId: i.institution_id, name: i.name };
  if (i.url) out.url = i.url;
  if (i.logo) {
    const bytes = Buffer.from(i.logo, 'base64');
    if (bytes.length <= MAX_LOGO_BYTES && PNG.every((b, n) => bytes[n] === b)) {
      out.logoPng = new Uint8Array(bytes);
    }
  }
  if (i.primary_color && /^#[0-9a-f]{6}$/i.test(i.primary_color)) {
    out.color = i.primary_color.toLowerCase();
  }
  return out;
}
