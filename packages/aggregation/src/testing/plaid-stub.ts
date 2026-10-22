// SPDX-License-Identifier: AGPL-3.0-or-later
import { startFakePlaid } from './fake-plaid.js';

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

const stop = () => void plaid.close().then(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
