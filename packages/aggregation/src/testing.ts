// SPDX-License-Identifier: AGPL-3.0-or-later
// Test helpers for aggregation adapters: a scripted fake provider, the conformance suite every
// adapter passes, synthetic data for the Riveras, and a stub http server. Uses vitest, so import
// it only from tests.
export {
  applyPage,
  describeProviderConformance,
  type ConformanceHarness,
  type ConformanceOptions,
  type ConformanceSetup,
} from './testing/conformance.js';
export {
  FakeAggregationProvider,
  FakeClock,
  transactionDate,
  type FakeCall,
  type FakeScript,
  type ScriptedError,
  type ScriptedPage,
} from './testing/fake-provider.js';
export {
  RIVERA,
  riveraAccounts,
  riveraBalances,
  riveraLiabilities,
  riveraScenario,
  type ConformanceScenario,
} from './testing/rivera.js';
export {
  jsonBody,
  startStubServer,
  type StubHandler,
  type StubRequest,
  type StubResponse,
  type StubRoutes,
  type StubServer,
} from './testing/stub-server.js';
export {
  plaidAccount,
  plaidCreditLiability,
  plaidLoanLiability,
  plaidTransaction,
  startFakePlaid,
  type FakePlaid,
  type FakePlaidError,
  type FakePlaidOptions,
} from './testing/fake-plaid.js';
