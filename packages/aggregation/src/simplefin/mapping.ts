// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ProviderAccount,
  ProviderAccountType,
  ProviderBalance,
  ProviderTransaction,
} from '@fiscus/domain';
import { maskInName, minorUnitExponent } from '@fiscus/shared';
import type { SimpleFinAccount, SimpleFinTransaction } from './schemas.js';

// SimpleFIN in Fiscus's terms (#91). Its sign is already Fiscus's (positive = money in; what a
// card owes is a negative balance). Amounts are decimal strings, turned into minor units by
// their digits, never through a float. Times are epoch seconds: a transaction's date is the day
// it happened in the household's time zone, except a time of exactly 00:00:00Z, which Bridges use
// for a bare date, and which is that date in UTC.

const DAY_SECONDS = 86_400;

/** A decimal string in the currency's minor units, rounded half away from zero; null if it can't be. */
export function simpleFinMinor(amount: string, currency: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return null;
  let exponent: number;
  try {
    exponent = minorUnitExponent(currency);
  } catch {
    return null;
  }
  const [, sign, whole, fraction = ''] = m;
  const digits = (fraction + '0'.repeat(exponent + 1)).slice(0, exponent + 1);
  let units = BigInt(whole + digits.slice(0, exponent));
  if (Number(digits[exponent]) >= 5) units += 1n;
  const minor = Number(units) * (sign ? -1 : 1);
  return Number.isSafeInteger(minor) ? minor || 0 : null;
}

/** An ISO 4217 code Fiscus keeps amounts in, or null (a custom currency's URL isn't supported). */
export function simpleFinCurrency(currency: string): string | null {
  const code = currency.trim().toUpperCase();
  try {
    minorUnitExponent(code);
    return code;
  } catch {
    return null;
  }
}

const dateIn = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

/** The day `seconds` falls on in `timeZone`; exactly midnight UTC is a bare date, in UTC. */
export function simpleFinDate(seconds: number, timeZone = 'UTC'): string {
  const zone = seconds % DAY_SECONDS === 0 ? 'UTC' : timeZone;
  return dateIn(zone).format(new Date(seconds * 1000));
}

/** Today in `timeZone`. */
export const todayIn = (now: Date, timeZone = 'UTC'): string => dateIn(timeZone).format(now);

/**
 * What kind of account a name suggests: SimpleFIN doesn't say. A card or loan by its words, then
 * a negative balance as a card; otherwise a bank account.
 */
export function guessAccountType(
  name: string,
  balanceMinor: number | null,
): { type: ProviderAccountType; subtype?: string } {
  const n = name.toLowerCase();
  const has = (...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`).test(n));
  if (has('mortgage', 'heloc')) return { type: 'loan', subtype: 'mortgage' };
  if (has('loan', 'auto loan', 'student loan')) return { type: 'loan', subtype: 'loan' };
  if (has('credit', 'card', 'visa', 'mastercard', 'amex', 'american express'))
    return { type: 'credit', subtype: 'credit card' };
  if (has('brokerage', 'ira', 'roth', '401k', '403b', 'hsa', 'invest', 'investment'))
    return { type: 'investment' };
  if (has('savings', 'money market')) return { type: 'depository', subtype: 'savings' };
  if (has('checking', 'chequing')) return { type: 'depository', subtype: 'checking' };
  if (balanceMinor !== null && balanceMinor < 0) return { type: 'credit' };
  return { type: 'depository' };
}

/** A Bridge account as Fiscus's, or null when its currency isn't one Fiscus keeps. */
export function simpleFinProviderAccount(a: SimpleFinAccount): ProviderAccount | null {
  const currency = simpleFinCurrency(a.currency);
  if (!currency) return null;
  const name = a.name.trim().slice(0, 120) || 'Bank account';
  const { type, subtype } = guessAccountType(name, simpleFinMinor(a.balance, currency));
  const mask = maskInName(name);
  return {
    providerAccountId: a.id,
    name,
    type,
    ...(subtype ? { subtype } : {}),
    currency,
    ...(mask ? { mask } : {}),
  };
}

/** Its balance, available balance and their date as one snapshot. */
export function simpleFinProviderBalance(a: SimpleFinAccount): ProviderBalance | null {
  const currency = simpleFinCurrency(a.currency);
  if (!currency) return null;
  const currentMinor = simpleFinMinor(a.balance, currency);
  if (currentMinor === null) return null;
  const available = a['available-balance']
    ? simpleFinMinor(a['available-balance'], currency)
    : null;
  return {
    providerAccountId: a.id,
    currency,
    currentMinor,
    ...(available !== null ? { availableMinor: available } : {}),
    asOf: new Date(a['balance-date'] * 1000).toISOString(),
  };
}

/** A transaction in Fiscus's terms, or null when it can't be read. */
export function simpleFinProviderTransaction(
  t: SimpleFinTransaction,
  account: { providerAccountId: string; currency: string },
  timeZone: string,
  today: string,
): ProviderTransaction | null {
  const amountMinor = simpleFinMinor(t.amount, account.currency);
  if (amountMinor === null) return null;
  const pending = t.pending === true || t.posted === 0;
  const postedDate = t.posted > 0 ? simpleFinDate(t.posted, timeZone) : undefined;
  const authorizedDate = t.transacted_at
    ? simpleFinDate(t.transacted_at, timeZone)
    : (postedDate ?? today);
  return {
    providerTransactionId: t.id,
    providerAccountId: account.providerAccountId,
    amountMinor,
    currency: account.currency,
    pending,
    ...(pending || !postedDate ? {} : { postedDate }),
    authorizedDate,
    description: t.description.trim().slice(0, 500),
  };
}
