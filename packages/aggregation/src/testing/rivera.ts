// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ProviderAccount,
  ProviderBalance,
  ProviderLiability,
  ProviderTransaction,
} from '@fiscus/domain';
import type { ScriptedPage } from './fake-provider.js';

// Synthetic data for the Riveras, Alex and Sam, the invented household of the design
// walkthroughs: their Harbor Credit Union connection, as the bank connections walkthrough shows
// it. Every name, number and amount here is made up.

/** What a provider adapter is checked against: a bank, and what happens at it over time. */
export interface ConformanceScenario {
  /** The bank's clock when the first sync runs. */
  now: string;
  /** The `since` every sync asks for (D6: 90 days back for new accounts). */
  since: string;
  accounts: ProviderAccount[];
  balances: ProviderBalance[];
  liabilities: ProviderLiability[];
  /** Each update is the pages a sync returns after it (see `FakeScript.updates`). */
  updates: ScriptedPage[][];
}

export const RIVERA = {
  checking: 'harbor-checking-4410',
  savings: 'harbor-savings-8812',
  visa: 'harbor-visa-3301',
  oldSavings: 'harbor-savings-0071',
} as const;

export const riveraAccounts = (): ProviderAccount[] => [
  {
    providerAccountId: RIVERA.checking,
    name: 'Harbor CU Checking',
    officialName: 'Harbor Credit Union Everyday Checking',
    type: 'depository',
    subtype: 'checking',
    currency: 'USD',
    mask: '4410',
  },
  {
    providerAccountId: RIVERA.savings,
    name: 'Harbor CU Savings',
    type: 'depository',
    subtype: 'savings',
    currency: 'USD',
    mask: '8812',
  },
  {
    providerAccountId: RIVERA.visa,
    name: 'Harbor CU Visa',
    type: 'credit',
    subtype: 'credit card',
    currency: 'USD',
    mask: '3301',
  },
  {
    providerAccountId: RIVERA.oldSavings,
    name: 'Old savings',
    type: 'depository',
    subtype: 'savings',
    currency: 'USD',
    mask: '0071',
    closed: true,
  },
];

const BALANCES_AS_OF = '2026-10-20T11:00:00.000Z';

/** In Fiscus's sign: the card's balance owed is negative. */
export const riveraBalances = (): ProviderBalance[] => [
  {
    providerAccountId: RIVERA.checking,
    currency: 'USD',
    currentMinor: 651_240,
    availableMinor: 651_240,
    asOf: BALANCES_AS_OF,
  },
  {
    providerAccountId: RIVERA.savings,
    currency: 'USD',
    currentMinor: 3_125_000,
    asOf: BALANCES_AS_OF,
  },
  {
    providerAccountId: RIVERA.visa,
    currency: 'USD',
    currentMinor: -180_722,
    availableMinor: 1_319_278,
    creditLimitMinor: 1_500_000,
    asOf: BALANCES_AS_OF,
  },
  { providerAccountId: RIVERA.oldSavings, currency: 'USD', currentMinor: 0, asOf: BALANCES_AS_OF },
];

export const riveraLiabilities = (): ProviderLiability[] => [
  {
    providerAccountId: RIVERA.visa,
    kind: 'credit',
    currency: 'USD',
    aprBps: 2149,
    lastStatementBalanceMinor: -142_310,
    lastStatementDate: '2026-09-28',
    minimumPaymentMinor: 3_500,
    nextPaymentDueDate: '2026-10-25',
  },
];

type TransactionFields = Omit<ProviderTransaction, 'currency' | 'pending' | 'authorizedDate'> &
  Partial<Pick<ProviderTransaction, 'currency' | 'pending' | 'authorizedDate'>>;

/** A posted USD transaction authorized the day it posted, unless the fields say otherwise. */
const txn = (fields: TransactionFields): ProviderTransaction => ({
  currency: 'USD',
  pending: false,
  authorizedDate: fields.postedDate!,
  ...fields,
});

const pending = (
  fields: Omit<TransactionFields, 'postedDate'> & { authorizedDate: string },
): ProviderTransaction => ({ currency: 'USD', ...fields, pending: true });

const dinner = txn({
  providerTransactionId: 'txn-dinner-1004',
  providerAccountId: RIVERA.visa,
  amountMinor: -5_200,
  postedDate: '2026-10-05',
  authorizedDate: '2026-10-04',
  description: "LUCIA'S TRATTORIA",
  merchantName: "Lucia's Trattoria",
});

const coffeePending = pending({
  providerTransactionId: 'txn-coffee-1005-pending',
  providerAccountId: RIVERA.visa,
  amountMinor: -450,
  authorizedDate: '2026-10-05',
  description: 'CORNER COFFEE #12',
  merchantName: 'Corner Coffee',
});

/**
 * Three updates: the first sync's history over two pages; then the pending coffee posts (a
 * pending → posted pair), the dinner gains its tip, and a foreign purchase and a refund arrive;
 * then a card payment, both sides, and a pending fuel purchase. Money in and money out on every
 * account type, so a sign that isn't normalized shows.
 */
export const riveraScenario = (): ConformanceScenario => ({
  now: '2026-10-20T12:00:00.000Z',
  since: '2026-07-22',
  accounts: riveraAccounts(),
  balances: riveraBalances(),
  liabilities: riveraLiabilities(),
  updates: [
    [
      {
        added: [
          txn({
            providerTransactionId: 'txn-payroll-0930',
            providerAccountId: RIVERA.checking,
            amountMinor: 312_500,
            postedDate: '2026-09-30',
            description: 'ACME LOGISTICS PAYROLL',
          }),
          txn({
            providerTransactionId: 'txn-dividend-0930',
            providerAccountId: RIVERA.savings,
            amountMinor: 2_604,
            postedDate: '2026-09-30',
            description: 'DIVIDEND EARNED',
          }),
          txn({
            providerTransactionId: 'txn-rent-1001',
            providerAccountId: RIVERA.checking,
            amountMinor: -185_000,
            postedDate: '2026-10-01',
            description: 'OAKVIEW PROPERTIES RENT',
            merchantName: 'Oakview Properties',
          }),
        ],
      },
      {
        added: [
          txn({
            providerTransactionId: 'txn-groceries-1003',
            providerAccountId: RIVERA.visa,
            amountMinor: -8_743,
            postedDate: '2026-10-03',
            authorizedDate: '2026-10-02',
            description: 'GREEN BASKET MKT #112',
            merchantName: 'Green Basket Market',
          }),
          dinner,
          coffeePending,
        ],
      },
    ],
    [
      {
        added: [
          txn({
            providerTransactionId: 'txn-coffee-1005',
            providerAccountId: RIVERA.visa,
            amountMinor: -450,
            postedDate: '2026-10-07',
            authorizedDate: '2026-10-05',
            pendingTransactionId: coffeePending.providerTransactionId,
            description: 'CORNER COFFEE #12',
            merchantName: 'Corner Coffee',
          }),
          txn({
            providerTransactionId: 'txn-cafe-paris-1008',
            providerAccountId: RIVERA.visa,
            amountMinor: -4_860,
            foreignAmountMinor: -4_200,
            foreignCurrency: 'EUR',
            postedDate: '2026-10-09',
            authorizedDate: '2026-10-08',
            description: 'CAFE DE FLORE PARIS FR',
          }),
          txn({
            providerTransactionId: 'txn-refund-1009',
            providerAccountId: RIVERA.visa,
            amountMinor: 2_599,
            postedDate: '2026-10-09',
            description: 'RIVERSIDE OUTFITTERS REFUND',
            merchantName: 'Riverside Outfitters',
          }),
        ],
        modified: [{ ...dinner, amountMinor: -6_100 }],
        removed: [
          {
            providerTransactionId: coffeePending.providerTransactionId,
            providerAccountId: RIVERA.visa,
          },
        ],
        historicalComplete: true,
      },
    ],
    [
      {
        added: [
          txn({
            providerTransactionId: 'txn-visa-payment-1012',
            providerAccountId: RIVERA.visa,
            amountMinor: 50_000,
            postedDate: '2026-10-12',
            description: 'PAYMENT - THANK YOU',
          }),
          txn({
            providerTransactionId: 'txn-visa-payment-out-1012',
            providerAccountId: RIVERA.checking,
            amountMinor: -50_000,
            postedDate: '2026-10-12',
            description: 'HARBOR CU VISA PAYMENT',
          }),
          pending({
            providerTransactionId: 'txn-fuel-1014-pending',
            providerAccountId: RIVERA.visa,
            amountMinor: -3_874,
            authorizedDate: '2026-10-14',
            description: 'SHELL OIL 5741',
            merchantName: 'Shell',
          }),
        ],
      },
    ],
  ],
});
