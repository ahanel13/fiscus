// SPDX-License-Identifier: AGPL-3.0-or-later
import { startFakePlaid } from './fake-plaid.js';
import { startFakeSimpleFin } from './fake-simplefin.js';

// The fake Plaid as a service, for the end-to-end stack (D17: no test talks to Plaid, and CI has
// no Plaid secrets): deploy/compose/docker-compose.plaid-stub.yml runs this file from the api
// image and points the api's sandbox-only PLAID_API_BASE_URL at it. It serves the Riveras'
// Harbor Credit Union to the fake keys below, and nothing else. Never part of a real install.
//
// It imports only the fake and its scenario (no vitest), so it runs with production dependencies.

const port = Number(process.env.PLAID_STUB_PORT ?? 4010);
const plaid = await startFakePlaid({ listen: { host: '0.0.0.0', port } });
// The client id and secret are the fake's own, not secrets: the compose override sets the same.
console.log(`Fake Plaid (sandbox stub) listening on port ${port}, client id ${plaid.clientId}`);

// And a fake SimpleFIN Bridge beside it (#91), reached as SIMPLEFIN_STUB_URL: its setup token is
// base64 of `${SIMPLEFIN_STUB_URL}/claim/rivera-setup`, claimable once per stack.
const bridgePort = Number(process.env.SIMPLEFIN_STUB_PORT ?? 4011);
const bridge = await startFakeSimpleFin({
  listen: { host: '0.0.0.0', port: bridgePort },
  publicUrl: process.env.SIMPLEFIN_STUB_URL ?? `http://127.0.0.1:${bridgePort}`,
});
console.log(`Fake SimpleFIN Bridge listening on port ${bridgePort}`);

const stop = () => void Promise.all([plaid.close(), bridge.close()]).then(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
