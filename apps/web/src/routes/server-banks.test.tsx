// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BankConnectionStats, BankConnectionsOverview } from '@fiscus/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectionCounts, usage, WebhookHealth } from './server-banks.js';

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

const NONE = {
  signature: 0,
  stale: 0,
  body_hash: 0,
  unknown_key: 0,
  missing: 0,
  malformed: 0,
  algorithm: 0,
};
const HOOK_URL = 'https://fiscus.example/api/v1/webhooks/plaid';

const plaid = (
  webhooks: Partial<BankConnectionsOverview['plaid']['webhooks']> = {},
  webhookUrl: string | null = HOOK_URL,
): BankConnectionsOverview['plaid'] => ({
  configured: true,
  environment: 'sandbox',
  webhookUrl,
  webhooks: {
    lastVerifiedAt: null,
    lastVerifiedByKeys: { server: null, household: null },
    refusals: { last24h: NONE, last7d: NONE },
    unknownItems: { last24h: 0, last7d: 0 },
    connections: { plaid: 0, withoutWebhook: 0 },
    pollingRelaxed: false,
    testAvailable: false,
    ...webhooks,
  },
});

const value = (label: string) => screen.getByText(label).nextSibling?.textContent;

describe('WebhookHealth (#85)', () => {
  it('says webhooks are off, and how to turn them on', () => {
    render(<WebhookHealth plaid={plaid({}, null)} now={NOW} />);
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText(/PLAID_WEBHOOK_URL/).textContent).toMatch(/Off: Fiscus checks/);
    expect(screen.queryByText('Last verified webhook')).toBeNull();
  });

  it('shows the URL, the last verified webhook, counts, and refusals by reason', () => {
    render(
      <WebhookHealth
        now={NOW}
        plaid={plaid({
          lastVerifiedAt: '2026-10-25T11:58:00Z',
          lastVerifiedByKeys: { server: '2026-10-25T09:00:00Z', household: null },
          refusals: {
            last24h: { ...NONE, signature: 2 },
            last7d: { ...NONE, signature: 3, stale: 1, missing: 4, algorithm: 1 },
          },
          unknownItems: { last24h: 1, last7d: 6 },
          connections: { plaid: 5, withoutWebhook: 2 },
        })}
      />,
    );
    expect(screen.getByText(HOOK_URL)).toBeTruthy();
    expect(value('Last verified webhook')).toBe('2 minutes ago');
    expect(value('For a connection on the server’s keys')).toBe('3 hours ago');
    expect(value('For a connection on a household’s own keys')).toBe('None yet');
    expect(value('Verified, for no connection here (24 h / 7 days)')).toBe('1 / 6');
    expect(value('Connections without a webhook')).toBe('2 of 5');
    expect(value('Polling')).toBe('On its usual schedule');
    const rows = within(screen.getByRole('table', { name: 'Refused requests' }))
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent);
    expect(rows).toEqual([
      'Signature didn’t verify23',
      'Too old (stale)01',
      'Body didn’t match its hash00',
      'Unknown key00',
      'Unsigned or malformed05',
    ]);
    // Not in sandbox with webhooks on: no test.
    expect(screen.queryByRole('button', { name: 'Send a test webhook' })).toBeNull();
  });

  it('says when nothing was refused and polling is relaxed', () => {
    render(<WebhookHealth now={NOW} plaid={plaid({ pollingRelaxed: true })} />);
    expect(screen.getByText('No request was refused in the last 7 days.')).toBeTruthy();
    expect(value('Polling')).toBe('Relaxed to every 12 hours');
  });

  it('offers a test webhook in sandbox, and says whether it arrived', () => {
    const fired = '2026-10-25T11:59:00Z';
    const { rerender } = render(
      <WebhookHealth now={NOW} plaid={plaid({ testAvailable: true })} test={null} />,
    );
    expect(screen.getByRole('button', { name: 'Send a test webhook' })).toBeTruthy();
    rerender(
      <WebhookHealth
        now={NOW}
        plaid={plaid({ testAvailable: true, lastVerifiedAt: '2026-10-25T11:00:00Z' })}
        test={{ firedAt: fired, gaveUp: false }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Sent. Waiting for it to arrive…');
    rerender(
      <WebhookHealth
        now={NOW}
        plaid={plaid({ testAvailable: true, lastVerifiedAt: '2026-10-25T11:59:02Z' })}
        test={{ firedAt: fired, gaveUp: false }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'The test webhook arrived and was verified.',
    );
    rerender(
      <WebhookHealth
        now={NOW}
        plaid={plaid({ testAvailable: true })}
        test={{ firedAt: fired, gaveUp: true }}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/hasn’t arrived/);
  });
});
