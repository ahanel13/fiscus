// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OfferedAccount } from '@fiscus/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TimeZoneProvider } from '../components/ui.js';
import { notUpdatingFirst, OfferedRow } from './connect-plaid.js';

const offered = (id: string, accountId: string | null): OfferedAccount => ({
  providerAccountId: `p-${id}`,
  name: `Account ${id}`,
  officialName: null,
  type: 'depository',
  subtype: 'checking',
  mask: null,
  currency: 'USD',
  balance: { amountMinor: 12_34, currency: 'USD' },
  suggestion: { choice: 'new', owners: [{ memberId: 'me' }], visibility: 'private' },
  tracked: accountId ? { accountId } : null,
});

describe('notUpdatingFirst', () => {
  it('puts the tracked accounts the connection isn’t updating first, and finds them', () => {
    const accounts = [offered('a', 'acc-a'), offered('b', 'acc-b'), offered('c', null)];
    const { offered: sorted, staleOf } = notUpdatingFirst(accounts, [
      { accountId: 'acc-b', code: null, asOf: '2026-11-02' },
    ]);
    expect(sorted.map((a) => a.name)).toEqual(['Account b', 'Account a', 'Account c']);
    expect(staleOf(accounts[1]!)?.asOf).toBe('2026-11-02');
    expect(staleOf(accounts[0]!)).toBeUndefined();
    expect(staleOf(accounts[2]!)).toBeUndefined();
  });

  it('leaves the order alone when every account updates', () => {
    const accounts = [offered('a', 'acc-a'), offered('b', 'acc-b')];
    expect(notUpdatingFirst(accounts, []).offered).toEqual(accounts);
  });
});

describe('OfferedRow', () => {
  const row = (stale?: { accountId: string; code: null; asOf: string | null }, absent = false) => {
    const a = { ...offered('a', 'acc-a'), ...(absent && { absent: true, balance: null }) };
    render(
      <TimeZoneProvider timeZone="UTC">
        <ul>
          <OfferedRow
            account={a}
            stale={stale}
            choice={{
              providerAccountId: a.providerAccountId,
              choice: 'keep',
              accountId: null,
              owners: ['me'],
              visibility: 'private',
            }}
            choices={[]}
            yours={[]}
            syncedBy={new Map()}
            members={[]}
            me="me"
            onChange={() => {}}
          />
        </ul>
      </TimeZoneProvider>,
    );
  };

  it('marks an account that isn’t updating, with its latest balance date', () => {
    row({ accountId: 'acc-a', code: null, asOf: '2026-11-02' });
    expect(screen.getByText('Not updating')).toBeTruthy();
    expect(screen.getByText(/The latest balance from the bank is from/).textContent).toMatch(
      /Nov 2/,
    );
  });

  it('says when no balance has come for it', () => {
    row({ accountId: 'acc-a', code: null, asOf: null });
    expect(screen.getByText('No balance has come from the bank for it.')).toBeTruthy();
  });

  it('says when the bank left it out, instead of a balance', () => {
    row({ accountId: 'acc-a', code: null, asOf: '2026-10-14' }, true);
    expect(screen.getByText(/not sent by the bank this time/)).toBeTruthy();
    expect(screen.getByText('Not updating')).toBeTruthy();
  });

  it('shows nothing extra for one that updates', () => {
    row();
    expect(screen.queryByText('Not updating')).toBeNull();
  });
});
