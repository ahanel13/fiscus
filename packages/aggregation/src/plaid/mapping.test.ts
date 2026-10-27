// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  hasLiabilityAccounts,
  plaidCurrency,
  MAX_LOGO_BYTES,
  plaidCurrentBalance,
  plaidInstitution,
  plaidLiabilities,
  plaidMinor,
  plaidProviderBalance,
  plaidProviderTransaction,
  purchaseAprBps,
} from './mapping.js';
import type { LiabilitiesGetResponse, PlaidAccount, PlaidTransaction } from './schemas.js';

// Plaid's sign, currencies and APRs in Fiscus's terms (#82; TXN-005, LIAB-002, LIAB-003).

const account = (type: string, balances: Partial<PlaidAccount['balances']> = {}): PlaidAccount => ({
  account_id: `acct-${type}`,
  name: 'Account',
  type,
  balances: { current: 100, iso_currency_code: 'USD', ...balances },
});

const transaction = (fields: Partial<PlaidTransaction> = {}): PlaidTransaction => ({
  transaction_id: 't1',
  account_id: 'a1',
  amount: 12.34,
  iso_currency_code: 'USD',
  pending: false,
  date: '2026-10-09',
  name: 'Plaid name',
  ...fields,
});

describe('plaidMinor', () => {
  it('rounds decimals to integer minor units by the currency’s exponent', () => {
    expect(plaidMinor(0.29, 'USD')).toBe(29);
    expect(plaidMinor(1807.22, 'USD')).toBe(180722);
    expect(plaidMinor(1234, 'JPY')).toBe(1234);
    expect(plaidMinor(1.234, 'KWD')).toBe(1234);
    expect(Object.is(plaidMinor(-0, 'USD'), 0)).toBe(true);
  });

  it('refuses what it can’t represent', () => {
    expect(plaidMinor(1, 'usd')).toBeNull();
    expect(plaidMinor(Number.NaN, 'USD')).toBeNull();
    expect(plaidMinor(1e20, 'USD')).toBeNull();
  });
});

describe('plaidCurrency', () => {
  it('reads iso_currency_code, falling back to unofficial_currency_code (TXN-005)', () => {
    expect(plaidCurrency('EUR', 'CNH')).toBe('EUR');
    expect(plaidCurrency(null, 'CNH')).toBe('CNH');
    expect(plaidCurrency(null, null)).toBeNull();
    expect(plaidCurrency(null, 'DOGE')).toBeNull();
  });
});

describe('plaidProviderTransaction', () => {
  it('reverses Plaid’s sign: positive is money out (TXN-005)', () => {
    expect(plaidProviderTransaction(transaction({ amount: 12.34 }))?.amountMinor).toBe(-1234);
    expect(plaidProviderTransaction(transaction({ amount: -3125 }))?.amountMinor).toBe(312500);
  });

  it('dates a pending transaction without a posted date, and links a posted one (TXN-004)', () => {
    const pending = plaidProviderTransaction(
      transaction({ pending: true, date: '2026-10-05', pending_transaction_id: 'ignored' }),
    );
    expect(pending).toMatchObject({ pending: true, authorizedDate: '2026-10-05' });
    expect(pending).not.toHaveProperty('postedDate');
    expect(pending).not.toHaveProperty('pendingTransactionId');
    expect(
      plaidProviderTransaction(
        transaction({
          date: '2026-10-07',
          authorized_date: '2026-10-05',
          pending_transaction_id: 'p1',
        }),
      ),
    ).toMatchObject({
      postedDate: '2026-10-07',
      authorizedDate: '2026-10-05',
      pendingTransactionId: 'p1',
    });
  });

  it('takes the bank’s own text, and the merchant from merchant_name only (TXN-013, TXN-023)', () => {
    expect(
      plaidProviderTransaction(
        transaction({
          original_description: 'SQ *CORNER COFFEE #12',
          merchant_name: 'Corner Coffee',
        }),
      ),
    ).toMatchObject({ description: 'SQ *CORNER COFFEE #12', merchantName: 'Corner Coffee' });
    const noMerchant = plaidProviderTransaction(transaction({ merchant_name: null }));
    expect(noMerchant?.description).toBe('Plaid name');
    expect(noMerchant).not.toHaveProperty('merchantName');
  });

  it('skips a row without a usable currency or date', () => {
    expect(
      plaidProviderTransaction(
        transaction({ iso_currency_code: null, unofficial_currency_code: null }),
      ),
    ).toBeNull();
    expect(plaidProviderTransaction(transaction({ date: '10/09/2026' }))).toBeNull();
  });
});

describe('balances', () => {
  it('negates what a card or loan owes, and leaves a depository balance as it is', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    expect(plaidProviderBalance(account('depository', { current: 6512.4 }), now)).toEqual({
      providerAccountId: 'acct-depository',
      currency: 'USD',
      currentMinor: 651240,
      asOf: '2026-10-20T12:00:00.000Z',
    });
    expect(
      plaidProviderBalance(
        account('credit', { current: 1807.22, available: 13192.78, limit: 15000 }),
        now,
      ),
    ).toMatchObject({ currentMinor: -180722, availableMinor: 1319278, creditLimitMinor: 1500000 });
    expect(plaidProviderBalance(account('loan', { current: 250000 }), now)?.currentMinor).toBe(
      -25000000,
    );
    expect(plaidProviderBalance(account('depository', { current: null }), now)).toBeNull();
  });

  it('keeps the api’s current balance: ISO currencies only', () => {
    expect(plaidCurrentBalance(account('credit', { current: 10 }))).toEqual({
      amountMinor: -1000,
      currency: 'USD',
    });
    expect(
      plaidCurrentBalance(
        account('depository', { iso_currency_code: null, unofficial_currency_code: 'CNH' }),
      ),
    ).toBeNull();
  });
});

describe('liabilities', () => {
  it('picks the purchase APR by apr_type, never by position (LIAB-003)', () => {
    expect(
      purchaseAprBps([
        { apr_type: 'cash_apr', apr_percentage: 29.99 },
        { apr_type: 'balance_transfer_apr', apr_percentage: 0 },
        { apr_type: 'purchase_apr', apr_percentage: 21.49 },
      ]),
    ).toBe(2149);
    expect(purchaseAprBps([{ apr_type: 'cash_apr', apr_percentage: 29.99 }])).toBeUndefined();
    expect(purchaseAprBps([])).toBeUndefined();
    expect(purchaseAprBps(null)).toBeUndefined();
    expect(purchaseAprBps([{ apr_type: 'purchase_apr', apr_percentage: null }])).toBeUndefined();
  });

  it('degrades field by field when the bank leaves them null (LIAB-002)', () => {
    const response: LiabilitiesGetResponse = {
      accounts: [account('credit'), account('loan', { iso_currency_code: 'CAD' })],
      item: { item_id: 'i' },
      liabilities: {
        credit: [
          {
            account_id: 'acct-credit',
            aprs: null,
            last_statement_balance: null,
            last_statement_issue_date: null,
            minimum_payment_amount: 25,
            next_payment_due_date: null,
          },
          // Without an account: nothing to put it on.
          { account_id: null, aprs: [] },
        ],
        student: [
          {
            account_id: 'acct-loan',
            interest_rate_percentage: null,
            last_statement_balance: 9000.5,
          },
        ],
        mortgage: null,
      },
    };
    expect(plaidLiabilities(response)).toEqual([
      {
        providerAccountId: 'acct-credit',
        kind: 'credit',
        currency: 'USD',
        minimumPaymentMinor: 2500,
      },
      {
        providerAccountId: 'acct-loan',
        kind: 'student',
        currency: 'CAD',
        lastStatementBalanceMinor: -900050,
      },
    ]);
  });

  it('knows which Items /liabilities/get covers (LIAB-008)', () => {
    expect(hasLiabilityAccounts([account('depository'), account('investment')])).toBe(false);
    expect(hasLiabilityAccounts([account('depository'), account('credit')])).toBe(true);
    expect(hasLiabilityAccounts([account('loan')])).toBe(true);
  });
});

describe('plaidInstitution', () => {
  // The first bytes of a PNG, then anything: enough for the signature check.
  const png = (size: number) => {
    const bytes = Buffer.alloc(size);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    return bytes.toString('base64');
  };
  const bank = { institution_id: 'ins_1', name: 'Harbor Credit Union', url: null };

  it('keeps a bank’s logo as PNG bytes, and its color as #rrggbb (GUIDE-017, #423)', () => {
    const out = plaidInstitution({ ...bank, logo: png(200), primary_color: '#1F4E79' });
    expect(out.providerInstitutionId).toBe('ins_1');
    expect(out.logoPng?.length).toBe(200);
    expect(out.color).toBe('#1f4e79');
    expect(out.url).toBeUndefined();
  });

  it('drops a logo that isn’t a PNG, or is too big, and a color that isn’t one', () => {
    const notPng = Buffer.from('<svg onload="alert(1)"/>').toString('base64');
    expect(plaidInstitution({ ...bank, logo: notPng, primary_color: 'red' })).toEqual({
      providerInstitutionId: 'ins_1',
      name: 'Harbor Credit Union',
    });
    expect(plaidInstitution({ ...bank, logo: png(MAX_LOGO_BYTES + 1) }).logoPng).toBeUndefined();
    expect(plaidInstitution({ ...bank, logo: png(MAX_LOGO_BYTES) }).logoPng?.length).toBe(
      MAX_LOGO_BYTES,
    );
    expect(plaidInstitution({ ...bank, primary_color: '#12345' }).color).toBeUndefined();
  });
});
