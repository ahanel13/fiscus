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
  plaidWebhookStatus,
  plaidWebhookUrl,
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
  type PlaidCredentialSet,
  type PlaidCredentialsResult,
} from './plaid/credentials.js';
export { plaidErrorKind } from './plaid/errors.js';
export {
  PLAID_WEBHOOK_BODY_LIMIT,
  PLAID_WEBHOOK_CLOCK_SKEW_MS,
  PLAID_WEBHOOK_MAX_AGE_MS,
  PLAID_WEBHOOK_PATH,
  PLAID_WEBHOOK_REJECTIONS,
  plaidWebhookAction,
  plaidWebhookBodySchema,
  PlaidWebhookKeys,
  plaidWebhookSignatureValid,
  readPlaidWebhookToken,
  type PlaidWebhookAction,
  type PlaidWebhookBody,
  type PlaidWebhookKeyResult,
  type PlaidWebhookKeysOptions,
  type PlaidWebhookRejection,
  type PlaidWebhookToken,
} from './plaid/webhook.js';
export {
  hasLiabilityAccounts,
  MAX_LOGO_BYTES,
  PLAID_COUNTRY_CODES,
  plaidAccountType,
  plaidCurrency,
  plaidCurrentBalance,
  plaidInstitution,
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
  InstitutionsGetByIdResponse,
  LiabilitiesGetResponse,
  PlaidAccount,
  PlaidItem,
  PlaidTransaction,
  TransactionsSyncResponse,
} from './plaid/schemas.js';
export {
  allowedUrl,
  claimSetupToken,
  decodeSetupToken,
  SIMPLEFIN_BRIDGE_HOSTS,
  SIMPLEFIN_VERSION,
  SimpleFinClient,
  simpleFinItemId,
  SimpleFinTokenError,
  type AccountsRequest,
  type SimpleFinClientOptions,
} from './simplefin/client.js';
export {
  guessAccountType,
  simpleFinCurrency,
  simpleFinDate,
  simpleFinMinor,
  simpleFinProviderAccount,
  simpleFinProviderBalance,
  simpleFinProviderTransaction,
} from './simplefin/mapping.js';
export {
  SIMPLEFIN_CAPABILITIES,
  SIMPLEFIN_PROVIDER_ID,
  SimpleFinProvider,
  type SimpleFinProviderOptions,
} from './simplefin/provider.js';
export {
  instanceSimpleFinConfig,
  simpleFinEnvVars,
  type SimpleFinEnv,
  type SimpleFinInstanceConfig,
} from './simplefin/config.js';
