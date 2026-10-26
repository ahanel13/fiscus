// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PossibleDuplicate } from '@fiscus/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCsrf } from '../api/client.js';
import { duplicateReason, PossibleDuplicatesList } from './possible-duplicates.js';

// Possible duplicates in Review (#80). Covered here rather than end to end: only a sync holds
// them, and the e2e suite has no provider that does.

const HH = '00000000-0000-7000-8000-0000000000aa';
const yours = (id: string, date: string, displayName: string) => ({
  id,
  date,
  amountMinor: -8_412,
  currency: 'USD',
  displayName,
  categoryId: null,
  account: { id: 'acc', name: 'Checking' },
  version: 1,
});
const held = (fields: Partial<PossibleDuplicate> = {}): PossibleDuplicate => ({
  id: '00000000-0000-7000-8000-000000000001',
  account: { id: 'acc', name: 'Checking' },
  bank: {
    date: '2026-09-30',
    amountMinor: -8_412,
    currency: 'USD',
    displayName: 'Trader Joe’s',
    originalDescription: 'TRADER JOES #552',
  },
  candidates: [yours('t1', '2026-10-01', 'TRADER JOES #552')],
  heldAt: '2026-10-02T08:00:00.000Z',
  ...fields,
});

let list: PossibleDuplicate[];
let posts: { path: string; body: unknown }[];

beforeEach(() => {
  resetCsrf();
  posts = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    if (path.endsWith('/auth/csrf')) {
      return new Response(JSON.stringify({ data: { csrfToken: 't' } }));
    }
    if (init.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      list = list.filter((d) => !path.endsWith(d.id));
      return new Response(JSON.stringify({ data: { transactionId: 't1' } }));
    }
    return new Response(JSON.stringify({ data: list }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PossibleDuplicatesList householdId={HH} groups={[]} />
    </QueryClientProvider>,
  );

describe('PossibleDuplicatesList', () => {
  it('shows yours beside the bank’s, and "Same transaction" keeps yours', async () => {
    list = [held()];
    show();
    const card = await screen.findByRole('listitem', { name: 'Trader Joe’s, from the bank' });
    expect(within(card).getByText('dates 1 day apart')).toBeInTheDocument();
    expect(within(card).getByText('Yours')).toBeInTheDocument();
    expect(within(card).getByText('From the bank')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Same transaction' }));
    expect(posts).toEqual([
      {
        path: `/api/v1/households/${HH}/transactions/possible-duplicates/${held().id}`,
        body: { decision: 'same', transactionId: 't1' },
      },
    ]);
    expect(await screen.findByText('No possible duplicates')).toBeInTheDocument();
  });

  it('asks which one when there are several, and offers only adding when none is left', async () => {
    list = [
      held({
        candidates: [yours('t1', '2026-09-30', 'Groceries'), yours('t2', '2026-09-30', 'More')],
      }),
      held({ id: '00000000-0000-7000-8000-000000000002', candidates: [] }),
    ];
    show();
    const [several, none] = await screen.findAllByRole('listitem');
    expect(within(several!).getByText('2 like it here')).toBeInTheDocument();
    expect(within(several!).queryByRole('button', { name: 'Same transaction' })).toBeNull();
    await userEvent.click(within(several!).getByRole('button', { name: /^This one\b.*\bMore\b/ }));
    expect(posts.at(-1)!.body).toEqual({ decision: 'same', transactionId: 't2' });

    expect(within(none!).getByText(/It can only be added/)).toBeInTheDocument();
    await userEvent.click(within(none!).getByRole('button', { name: 'Add it' }));
    expect(posts.at(-1)!.body).toEqual({ decision: 'different' });
  });
});

describe('duplicateReason', () => {
  it('names what kept it from matching on its own', () => {
    expect(duplicateReason(held())).toBe('dates 1 day apart');
    expect(duplicateReason(held({ candidates: [yours('t1', '2026-09-27', 'Shell')] }))).toBe(
      'dates 3 days apart',
    );
    expect(duplicateReason(held({ candidates: [yours('t1', '2026-09-30', 'Shell')] }))).toBe(
      'same day',
    );
    expect(duplicateReason(held({ candidates: [] }))).toBe('nothing left to match');
  });
});
