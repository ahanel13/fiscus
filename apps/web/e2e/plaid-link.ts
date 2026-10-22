// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';

// Plaid Link, stubbed for the end-to-end tests (#79, D17): no Plaid account, no secrets. The stub
// is served at Plaid's real script URL, so the connect page's real Content-Security-Policy is
// what lets it load (and every other page's is what keeps it out). It opens a frame from
// cdn.plaid.com, as Link does, then hands back the public token the api's fake Plaid accepts
// (deploy/compose/docker-compose.plaid-stub.yml).

export const PLAID_LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const LINK_FRAME = 'https://cdn.plaid.com/link/v2/stable/link.html';
/** The fake Plaid's public token (packages/aggregation/src/testing/fake-plaid.ts). */
export const STUB_PUBLIC_TOKEN = 'public-sandbox-harbor-0001';

/** What Link's metadata says about the Riveras' bank, as Plaid's Link would. */
const INSTITUTION = { name: 'Harbor Credit Union', institution_id: 'ins_harbor_cu' };
const SUCCESS_METADATA = {
  link_session_id: 'stub-session-success',
  institution: INSTITUTION,
  accounts: [
    {
      id: 'acc-checking',
      name: 'Harbor CU Checking',
      mask: '4410',
      type: 'depository',
      subtype: 'checking',
      verification_status: null,
    },
    {
      id: 'acc-savings',
      name: 'Harbor CU Savings',
      mask: '8812',
      type: 'depository',
      subtype: 'savings',
      verification_status: null,
    },
  ],
};
const EXIT_METADATA = {
  link_session_id: 'stub-session-exit',
  institution: INSTITUTION,
  status: 'requires_credentials',
  request_id: 'stub-request',
};

export type StubOutcome = 'success' | 'error' | 'closed';

// As Link does: create() loads its frame (hidden) and calls onLoad; open() shows it, and Link
// reports how it went once the person is done.
const script = (outcome: StubOutcome) => `
window.Plaid = {
  create: function (config) {
    var frame = document.createElement('iframe');
    frame.title = 'Plaid Link (stub)';
    frame.src = ${JSON.stringify(LINK_FRAME)};
    frame.style.position = 'fixed';
    frame.style.inset = '0';
    frame.style.display = 'none';
    frame.onload = function () {
      if (config.onLoad) config.onLoad();
    };
    document.body.appendChild(frame);
    return {
      open: function () {
        frame.style.display = 'block';
        setTimeout(function () {
          frame.style.display = 'none';
          ${
            outcome === 'success'
              ? `config.onSuccess(${JSON.stringify(STUB_PUBLIC_TOKEN)}, ${JSON.stringify(SUCCESS_METADATA)});`
              : outcome === 'error'
                ? `config.onExit({ error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', error_message: 'internal', display_message: null }, ${JSON.stringify(EXIT_METADATA)});`
                : `config.onExit(null, ${JSON.stringify(EXIT_METADATA)});`
          }
        }, 50);
      },
      exit: function () {},
      destroy: function () {
        frame.remove();
      },
      submit: function () {},
    };
  },
};
`;

/**
 * Serves the stub at Plaid's URLs. Set `outcome` before Link is created (the page loads, or Link
 * stops and a fresh token arrives); `loads` counts the script.
 */
export async function stubPlaidLink(page: Page) {
  const state = { outcome: 'success' as StubOutcome, loads: 0 };
  await page.route(PLAID_LINK_SCRIPT, (route) => {
    state.loads++;
    return route.fulfill({ contentType: 'text/javascript', body: script(state.outcome) });
  });
  await page.route(`${LINK_FRAME}*`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><title>Plaid Link (stub)</title><p>Signing in…</p></html>',
    }),
  );
  return state;
}
