// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecurringSeries } from '@fiscus/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChangeBadges } from '../components/ChangeBadges.js';
import { SubscriptionAudit } from './recurring.js';

// Changes worth noticing (#129, D14) and the subscription audit (#123).

const sub = (fields: Partial<RecurringSeries>): RecurringSeries => ({
  id: '00000000-0000-7000-8000-000000000001',
  accountId: 'acc',
  name: 'Streamly',
  kind: 'subscription',
  match: { direction: 'out' },
  schedule: { unit: 'month', every: 1, days: [14], anchor: '2026-10-14', weekend: 'as_is' },
  windowDays: 3,
  endedOn: null,
  currency: 'USD',
  next: '2026-11-14',
  estimateMinor: -1_549,
  recent: [],
  paidCount: 12,
  responsibleMemberId: null,
  forMemberIds: [],
  seenBy: [],
  changes: { priceUp: null, isNew: false, looksEnded: false },
  lastPaid: '2026-10-14',
  version: 1,
  updatedAt: '2026-10-14T00:00:00.000Z',
  ...fields,
});

describe('ChangeBadges (D14)', () => {
  it('says a price went up, since when; new; and looks ended', () => {
    render(
      <ChangeBadges
        changes={{
          priceUp: { changeMinor: 500, since: '2026-06-14' },
          isNew: true,
          looksEnded: true,
        }}
        currency="USD"
      />,
    );
    expect(screen.getByText(/^Up/)).toHaveTextContent('Up $5.00 since June');
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Looks ended')).toBeInTheDocument();
  });

  it('shows nothing when nothing changed', () => {
    const { container } = render(
      <ChangeBadges changes={{ priceUp: null, isNew: false, looksEnded: false }} currency="USD" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SubscriptionAudit (#123)', () => {
  it('lists each subscription a month and a year, with the year’s total', async () => {
    const onOpen = vi.fn();
    render(
      <SubscriptionAudit
        series={[
          sub({}),
          sub({
            id: '00000000-0000-7000-8000-000000000002',
            name: 'Peak Fitness',
            estimateMinor: -3_900,
            lastPaid: null,
            changes: { priceUp: null, isNew: true, looksEnded: false },
          }),
          // Not subscriptions, or ended: left out.
          sub({ id: '00000000-0000-7000-8000-000000000003', name: 'Power', kind: 'bill' }),
          sub({
            id: '00000000-0000-7000-8000-000000000004',
            name: 'Old gym',
            endedOn: '2026-01-01',
            next: null,
          }),
        ]}
        accountName={() => 'Joint card'}
        onOpen={onOpen}
      />,
    );
    // $15.49 and $39.00 a month: $653.88 a year.
    expect(screen.getByText('Subscriptions a year').nextSibling).toHaveTextContent('$653.88');
    const list = screen.getByRole('list', { name: 'Subscriptions' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Peak Fitness'),
      expect.stringContaining('Streamly'),
    ]);
    expect(items[0]).toHaveTextContent('$39.00 a month');
    expect(items[0]).toHaveTextContent('$468.00 a year');
    expect(items[0]).toHaveTextContent('not paid yet');
    expect(items[0]).toHaveTextContent('New');
    expect(items[1]).toHaveTextContent('last paid Oct 14, 2026');
    await userEvent.click(within(items[1]!).getByRole('button'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'Streamly' }));
  });
});
