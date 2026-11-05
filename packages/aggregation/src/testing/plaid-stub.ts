// SPDX-License-Identifier: AGPL-3.0-or-later
import { startFakePlaid } from './fake-plaid.js';
import { startFakeSimpleFin } from './fake-simplefin.js';
import { riveraScenario } from './rivera.js';

// The fake Plaid as a service, for the end-to-end stack (D17: no test talks to Plaid, and CI has
// no Plaid secrets): deploy/compose/docker-compose.plaid-stub.yml runs this file from the api
// image and points the api's sandbox-only PLAID_API_BASE_URL at it. It serves the Riveras'
// Harbor Credit Union to the fake keys below, and nothing else. Never part of a real install.
//
// It imports only the fake and its scenario (no vitest), so it runs with production dependencies.

// The bank's balances are as of now, as a live bank's are: the scenario's fixed date would soon
// read as an account that isn't updating (#514).
const base = riveraScenario();
const now = new Date().toISOString();
const scenario = { ...base, balances: base.balances.map((b) => ({ ...b, asOf: now })) };

const port = Number(process.env.PLAID_STUB_PORT ?? 4010);
const plaid = await startFakePlaid({
  scenario,
  listen: { host: '0.0.0.0', port },
  // A household's own keys (#83), as fake as the server's: what the tests enter in the keys card.
  otherKeys: [{ clientId: 'fake-household-client-id-5150', secret: 'fake-household-secret-5150' }],
});
// The client id and secret are the fake's own, not secrets: the compose override sets the same.
console.log(`Fake Plaid (sandbox stub) listening on port ${port}, client id ${plaid.clientId}`);

// And a fake SimpleFIN Bridge beside it (#91), reached as SIMPLEFIN_STUB_URL: its setup token is
// base64 of `${SIMPLEFIN_STUB_URL}/claim/rivera-setup`, claimable once per stack.
const bridgePort = Number(process.env.SIMPLEFIN_STUB_PORT ?? 4011);
const bridge = await startFakeSimpleFin({
  scenario,
  listen: { host: '0.0.0.0', port: bridgePort },
  publicUrl: process.env.SIMPLEFIN_STUB_URL ?? `http://127.0.0.1:${bridgePort}`,
});
console.log(`Fake SimpleFIN Bridge listening on port ${bridgePort}`);

const stop = () => void Promise.all([plaid.close(), bridge.close()]).then(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
