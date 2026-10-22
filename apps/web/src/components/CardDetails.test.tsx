// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account } from '@fiscus/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CardDetails } from './CardDetails.js';

const card = (fields: Partial<Account> = {}): Account => ({
  id: '00000000-0000-7000-8000-000000000001',
  name: 'Visa',
  type: 'credit',
  subtype: null,
  currency: 'USD',
  mask: '4821',
  visibility: 'full',
  balanceMode: 'transactions',
  includeInNetWorth: true,
  isBusiness: false,
  sortOrder: 0,
  closedAt: null,
  owners: [],
  yourAccess: 'owner',
  balance: { amountMinor: -128_455, asOf: '2026-10-20' },
  liabilities: {
    aprBps: 2149,
    minimumPaymentMinor: 3_500,
    nextDueDate: '2026-10-25',
    lastStatementBalanceMinor: -142_310,
    lastStatementDate: '2026-09-28',
    updatedAt: '2026-10-20T11:00:00.000Z',
  },
  version: 1,
  ...fields,
});

// Card details on the account page (#86). Covered here rather than end to end: only a sync
// writes them, and the e2e suite has no provider.
describe('CardDetails', () => {
  it('shows the APR, payment, due date, and last statement', () => {
    render(<CardDetails account={card()} />);
    expect(screen.getByRole('heading', { name: 'Card details' })).toBeInTheDocument();
    const value = (label: string) => screen.getByText(label).nextElementSibling;
    expect(value('APR')).toHaveTextContent('21.49%');
    expect(value('Minimum payment')).toHaveTextContent('$35.00');
    expect(value('Due')).toHaveTextContent('Oct 25, 2026');
    expect(value('Statement balance')).toHaveTextContent('−$1,423.10');
    expect(value('Statement date')).toHaveTextContent('Sep 28, 2026');
  });

  it('shows only what the bank reported, and calls a loan’s loan details', () => {
    render(
      <CardDetails
        account={card({
          type: 'loan',
          liabilities: {
            aprBps: 549,
            minimumPaymentMinor: null,
            nextDueDate: null,
            lastStatementBalanceMinor: null,
            lastStatementDate: null,
            updatedAt: '2026-10-20T11:00:00.000Z',
          },
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Loan details' })).toBeInTheDocument();
    expect(screen.getByText('5.49%')).toBeInTheDocument();
    expect(screen.queryByText('Due')).not.toBeInTheDocument();
  });

  it('shows nothing without details: none reported (SimpleFIN), or below full access', () => {
    const { container, rerender } = render(<CardDetails account={card({ liabilities: null })} />);
    expect(container).toBeEmptyDOMElement();
    const { liabilities: _, ...withoutDetails } = card();
    rerender(<CardDetails account={withoutDetails} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CardDetails account={card({ type: 'depository' })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
