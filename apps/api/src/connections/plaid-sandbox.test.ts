// SPDX-License-Identifier: AGPL-3.0-or-later
import { setTimeout as sleep } from 'node:timers/promises';
import { PlaidClient, PlaidProvider } from '@fiscus/aggregation';
import type { SyncPage } from '@fiscus/domain';
import { describe, expect, it } from 'vitest';
import {
  LINK_CLIENT_NAME,
  LINK_CONSENTED_PRODUCTS,
  LINK_COUNTRY_CODES,
  LINK_DAYS_REQUESTED,
  LINK_PRODUCTS,
  plaidClientUserId,
} from './plaid.js';

const clientId = process.env.PLAID_SANDBOX_CLIENT_ID;
const secret = process.env.PLAID_SANDBOX_SECRET;

/** First Platypus Bank, a non-OAuth sandbox bank. */
const PLATYPUS = 'ins_109508';

/**
 * Against Plaid's real sandbox (#79): what the fake Plaid can't prove, that Plaid takes the
 * requests Fiscus makes and answers in the shapes it reads. Run nightly, by hand, and on pushes to
 * main by `.github/workflows/plaid-sandbox.yml`, with keys from the repository's secrets; skipped
 * without them, as everywhere else. Items are made with `/sandbox/public_token/create`, not Link.
 * Nothing here prints a key or a token.
 */
describe.skipIf(!clientId || !secret)('Plaid sandbox', () => {
  const client = new PlaidClient({
    clientId: clientId!,
    secret: secret!,
    env: 'sandbox',
    timeoutMs: 60_000,
  });
  const provider = new PlaidProvider(client);

  /** Pages to `hasMore: false`, again with a growing wait until the history is in. */
  async function syncToEnd(accessToken: string) {
    let cursor: string | null = null;
    let added = 0;
    for (let attempt = 0; ; attempt++) {
      let page: SyncPage;
      let historical = false;
      do {
        page = await provider.sync(accessToken, { cursor });
        cursor = page.nextCursor;
        added += page.added.length;
        historical ||= page.historicalComplete === true;
      } while (page.hasMore);
      if (historical) return { added, last: page, cursor };
      if (attempt === 7) throw new Error('The history wasn’t in after 8 tries');
      await sleep(Math.min(2 ** attempt * 1_000, 30_000));
    }
  }

  it('takes the link token Fiscus asks for', async () => {
    const token = await client.linkTokenCreate({
      client_name: LINK_CLIENT_NAME,
      language: 'en',
      country_codes: LINK_COUNTRY_CODES,
      user: { client_user_id: plaidClientUserId('00000000-0000-7000-8000-000000000001') },
      products: LINK_PRODUCTS,
      additional_consented_products: LINK_CONSENTED_PRODUCTS,
      transactions: { days_requested: LINK_DAYS_REQUESTED },
    });
    expect(token.link_token.startsWith('link-sandbox-')).toBe(true);
  });

  it.each([
    // The usual one, with card and loan details too.
    { username: 'user_good', products: [...LINK_PRODUCTS, 'liabilities'] },
    // Transactions that change between syncs.
    { username: 'user_transactions_dynamic', products: LINK_PRODUCTS },
  ])(
    'connects $username, syncs to the end, sees a login break, and removes it',
    async ({ username, products }) => {
      const { public_token } = await client.sandboxPublicTokenCreate(PLATYPUS, products, {
        override_username: username,
        override_password: 'pass_good',
      });
      const { access_token } = await client.itemPublicTokenExchange(public_token);
      try {
        const institution = await client.institutionsGetById(PLATYPUS, LINK_COUNTRY_CODES);
        expect(institution.institution.name).toBeTruthy();

        const accounts = await provider.listAccounts(access_token);
        expect(accounts.length).toBeGreaterThan(0);

        const { added, last, cursor } = await syncToEnd(access_token);
        expect(added).toBeGreaterThan(0);
        // The last page carries the accounts and their balances.
        expect(last.accounts?.length).toBe(accounts.length);
        expect(last.balances?.length).toBeGreaterThan(0);
        // Caught up: the next sync from the saved cursor brings nothing it already had.
        const again = await provider.sync(access_token, { cursor });
        expect(again.hasMore).toBe(false);

        const liabilities = await provider.liabilities(access_token);
        if (products.includes('liabilities')) expect(liabilities.length).toBeGreaterThan(0);

        await client.sandboxItemResetLogin(access_token);
        await expect(provider.sync(access_token, { cursor })).rejects.toMatchObject({
          kind: 'login_required',
          providerCode: 'ITEM_LOGIN_REQUIRED',
        });
      } finally {
        await provider.remove(access_token);
      }
      // Gone at Plaid, and removing again is fine.
      await expect(client.itemGet(access_token)).rejects.toMatchObject({
        providerCode: 'ITEM_NOT_FOUND',
      });
      await provider.remove(access_token);
    },
    300_000,
  );
});
