// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DetectedSeries, HouseholdMember, RecurringOccurrence } from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { OccurrenceRow, Review } from './recurring.js';

// Bills & recurring: who looks after a bill shows only where there's a choice (#121, D22).

const HH = '00000000-0000-7000-8000-0000000000aa';
const ALEX = '00000000-0000-7000-8000-00000000000a';
const SAM = '00000000-0000-7000-8000-00000000000b';
const members: HouseholdMember[] = [
  { id: ALEX, displayName: 'Alex', color: '#2f6f4f', role: 'owner', joinedAt: '', isYou: true },
  { id: SAM, displayName: 'Sam', color: '#7a4f9a', role: 'member', joinedAt: '', isYou: false },
];

beforeEach(() => {
  resetCsrf();
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url, 'http://x').pathname;
    if (path.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    if (path.endsWith('/members')) return new Response(JSON.stringify({ data: members }));
    return new Response(JSON.stringify({ data: [] }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (node: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

const occurrence = (fields: Partial<RecurringOccurrence> = {}): RecurringOccurrence => ({
  seriesId: '00000000-0000-7000-8000-000000000001',
  name: 'Lakeside Power',
  kind: 'bill',
  accountId: 'acc',
  currency: 'USD',
  due: '2026-11-24',
  status: 'due',
  expectedMinor: -13_100,
  payment: null,
  memberIds: [SAM],
  shared: true,
  ...fields,
});

const row = (o: RecurringOccurrence) =>
  wrap(
    <ul>
      <OccurrenceRow
        householdId={HH}
        o={o}
        today="2026-11-12"
        accountName={() => 'Everyday checking'}
        onOpen={() => {}}
      />
    </ul>,
  );

describe('who looks after a bill, on Upcoming', () => {
  it('shows the person on an account more than one of you sees', async () => {
    row(occurrence());
    expect(await screen.findByRole('img', { name: 'Sam looks after it' })).toBeInTheDocument();
  });

  it('shows no one on your own account, or for someone on their own (D22)', async () => {
    row(occurrence({ shared: false }));
    await screen.findByText('Lakeside Power');
    expect(screen.queryByRole('img', { name: /looks after/ })).toBeNull();
  });

  it('says who income is for', async () => {
    row(occurrence({ kind: 'income', name: 'Paycheck', expectedMinor: 198_000 }));
    expect(await screen.findByRole('img', { name: 'For Sam' })).toBeInTheDocument();
  });
});

const suggestion = (fields: Partial<DetectedSeries> = {}): DetectedSeries => ({
  key: 'lakeside power',
  name: 'Lakeside Power',
  kind: 'bill',
  draft: {
    accountId: 'acc',
    match: { direction: 'out' },
    schedule: { unit: 'month', every: 1, days: [24], anchor: '2026-10-24', weekend: 'after' },
    windowDays: 3,
  },
  seenCount: 12,
  since: '2025-11-24',
  amounts: [-12_000, -13_100],
  next: '2026-11-24',
  responsibleMemberId: SAM,
  seenBy: [ALEX, SAM],
  forMemberIds: [],
  ...fields,
});

const review = (s: DetectedSeries) =>
  wrap(
    <Review
      householdId={HH}
      suggestions={[s]}
      loading={false}
      currency="USD"
      accountName={() => 'Everyday checking'}
      onDone={() => {}}
    />,
  );

describe('who looks after a suggestion, on the review', () => {
  it('asks, on an account more than one of you sees, starting from the default', async () => {
    review(suggestion());
    const item = (await screen.findByText('Lakeside Power')).closest('li')!;
    const picker = await within(item).findByRole('button', {
      name: /Who looks after Lakeside Power/,
    });
    expect(picker).toHaveTextContent('Sam');
  });

  it('doesn’t ask on someone’s own account (D22)', async () => {
    review(suggestion({ seenBy: [ALEX], responsibleMemberId: ALEX }));
    await screen.findByText('Lakeside Power');
    expect(screen.queryByRole('button', { name: /Who looks after/ })).toBeNull();
  });

  it('doesn’t ask for income, which says who it’s for', async () => {
    review(
      suggestion({ kind: 'income', responsibleMemberId: null, forMemberIds: [ALEX], name: 'Pay' }),
    );
    expect(await screen.findByText('For Alex')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Who looks after/ })).toBeNull();
  });
});

describe('card statements, on Upcoming (#122)', () => {
  const statement = (fields: Partial<RecurringOccurrence> = {}) =>
    occurrence({
      seriesId: null,
      name: 'Joint card statement',
      kind: 'statement',
      expectedMinor: -180_722,
      minimumMinor: 4_000,
      paidSoFarMinor: 0,
      statementPaid: null,
      memberIds: [ALEX],
      ...fields,
    });

  it('says it’s from the bank, with its minimum, and whose card it is', async () => {
    row(statement());
    const item = (await screen.findByText('Joint card statement')).closest('li')!;
    expect(within(item).getByText('From the bank')).toBeInTheDocument();
    expect(item).toHaveTextContent('minimum $40.00');
    expect(item).toHaveTextContent('$1,807.22');
    expect(await within(item).findByRole('img', { name: 'Alex’s card' })).toBeInTheDocument();
    // Nothing to mark: the bank says when it's paid.
    expect(within(item).queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('is partly paid, minimum paid, or paid', async () => {
    const first = row(statement({ statementPaid: 'part', paidSoFarMinor: 2_000 }));
    expect(await screen.findByText('Partly paid')).toBeInTheDocument();
    expect(screen.getByText(/paid so far/)).toBeInTheDocument();
    first.unmount();
    const second = row(
      statement({ status: 'paid', statementPaid: 'minimum', paidSoFarMinor: 4_000 }),
    );
    expect(await screen.findByText('Minimum paid')).toBeInTheDocument();
    second.unmount();
    row(statement({ status: 'paid', statementPaid: 'paid', paidSoFarMinor: 180_722 }));
    expect(await screen.findByText('Paid')).toBeInTheDocument();
  });
});
