// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  ProviderRegistry,
  ProviderUnavailableError,
  UnknownProviderError,
  type ConnectionRef,
  type ProviderSource,
  type ProviderUnavailableReason,
} from './registry.js';
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
export {
  hasLiabilityAccounts,
  plaidAccountType,
  plaidCurrency,
  plaidCurrentBalance,
  plaidLiabilities,
  plaidMask,
  plaidMinor,
  plaidProviderAccount,
  plaidProviderBalance,
  plaidProviderTransaction,
  plaidRemovedTransaction,
  purchaseAprBps,
} from './plaid/mapping.js';
export {
  PLAID_CAPABILITIES,
  PLAID_PROVIDER_ID,
  PLAID_SYNC_COUNT,
  PlaidProvider,
  plaidProviderSource,
  type PlaidProviderOptions,
  type PlaidProviderSourceOptions,
} from './plaid/provider.js';
export type {
  LiabilitiesGetResponse,
  PlaidAccount,
  PlaidItem,
  PlaidTransaction,
  TransactionsSyncResponse,
} from './plaid/schemas.js';
