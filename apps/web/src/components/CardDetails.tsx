// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account } from '@fiscus/shared';
import type { ReactNode } from 'react';
import { useLocale } from 'react-aria-components';
import { Amount } from './Amount.js';
import { Card, DateText } from './ui.js';

/**
 * A card's or loan's details from its bank (#86): APR, minimum payment, due date, and the last
 * statement. Only for credit and loan accounts whose bank reports them (Plaid; SimpleFIN never
 * does), and only at owner and full access, where the api includes them: otherwise nothing shows.
 */
export function CardDetails({ account }: { account: Account }) {
  const l = account.liabilities;
  const { locale } = useLocale();
  if (!l || (account.type !== 'credit' && account.type !== 'loan')) return null;
  const rows: [string, ReactNode][] = [];
  if (l.aprBps !== null) {
    const apr = new Intl.NumberFormat(locale, {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(l.aprBps / 10_000);
    rows.push(['APR', apr]);
  }
  if (l.minimumPaymentMinor !== null) {
    rows.push([
      'Minimum payment',
      <Amount key="min" minor={l.minimumPaymentMinor} currency={account.currency} kind="balance" />,
    ]);
  }
  if (l.nextDueDate !== null) rows.push(['Due', <DateText key="due" value={l.nextDueDate} />]);
  if (l.lastStatementBalanceMinor !== null) {
    rows.push([
      'Statement balance',
      <Amount
        key="statement"
        minor={l.lastStatementBalanceMinor}
        currency={account.currency}
        kind="liability"
      />,
    ]);
  }
  if (l.lastStatementDate !== null) {
    rows.push(['Statement date', <DateText key="statement-date" value={l.lastStatementDate} />]);
  }
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="account-card-details" className="space-y-3">
      <h2 id="account-card-details" className="font-semibold">
        {account.type === 'credit' ? 'Card details' : 'Loan details'}
      </h2>
      <Card>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">
          From your bank, updated <DateText value={l.updatedAt} />
        </p>
      </Card>
    </section>
  );
}
