// SPDX-License-Identifier: AGPL-3.0-or-later
export { ProviderRegistry, UnknownProviderError } from './registry.js';
export { PlaidClient, PLAID_API_VERSION } from './plaid/client.js';
export type {
  LinkTokenCreateRequest,
  PlaidClientOptions,
  TransactionsSyncRequest,
} from './plaid/client.js';
export {
  instancePlaidConfig,
  instancePlaidConfigOrExit,
  PLAID_BASE_URLS,
  PLAID_ENVIRONMENTS,
  plaidBaseUrl,
  PlaidConfigError,
  plaidEnvVars,
  plaidStatus,
  type PlaidEnv,
  type PlaidEnvironment,
  type PlaidInstanceConfig,
} from './plaid/config.js';
export {
  credentialsChanged,
  credentialStamp,
  resolvePlaidCredentials,
  type ConnectionCredentialStamp,
  type PlaidCredentials,
  type PlaidCredentialsResult,
} from './plaid/credentials.js';
export { plaidErrorKind } from './plaid/errors.js';
export type {
  LiabilitiesGetResponse,
  PlaidAccount,
  PlaidItem,
  PlaidTransaction,
  TransactionsSyncResponse,
} from './plaid/schemas.js';
