// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BankConnectionStats } from '@fiscus/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectionCounts, usage } from './server-banks.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');

const stats = (fields: Partial<BankConnectionStats> = {}): BankConnectionStats => ({
  plaidInstanceKeys: { households: 0, connections: 0 },
  plaidHouseholdKeys: { households: 0, connections: 0 },
  simplefin: { households: 0, connections: 0 },
  byStatus: { setup: 0, ok: 0, login_required: 0, error: 0 },
  last24h: { synced: 0, failing: 0, lastSyncedAt: null },
  ...fields,
});

describe('usage', () => {
  it('counts connections and households, or says none', () => {
    expect(usage({ households: 0, connections: 0 })).toBe('None');
    expect(usage({ households: 1, connections: 1 })).toBe('1 connection in 1 household');
    expect(usage({ households: 2, connections: 5 })).toBe('5 connections in 2 households');
  });
});

describe('ConnectionCounts', () => {
  it('says when no household has connected a bank', () => {
    render(<ConnectionCounts stats={stats()} now={NOW} />);
    expect(screen.getByText('No household has connected a bank yet.')).toBeTruthy();
  });

  it('shows connections by status, troubled ones first, and the last day of syncing', () => {
    render(
      <ConnectionCounts
        now={NOW}
        stats={stats({
          byStatus: { setup: 0, ok: 4, login_required: 1, error: 2 },
          last24h: { synced: 4, failing: 3, lastSyncedAt: '2026-10-25T11:55:00Z' },
        })}
      />,
    );
    const badges = within(screen.getByRole('list', { name: 'Connections by status' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(badges).toEqual(['Failing: 2', 'Need sign-in: 1', 'Working: 4']);
    expect(screen.getByText('Synced in the last 24 hours').nextSibling?.textContent).toBe('4');
    expect(screen.getByText('Latest sync failed').nextSibling?.textContent).toBe('3');
    expect(screen.getByText('Most recent sync').nextSibling?.textContent).toBe('5 minutes ago');
  });
});
