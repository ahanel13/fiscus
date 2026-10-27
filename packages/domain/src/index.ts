// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  isProviderError,
  PROVIDER_ERROR_KINDS,
  ProviderError,
  type AggregationProvider,
  type ProviderAccount,
  type ProviderAccountError,
  type ProviderAccountType,
  type ProviderBalance,
  type ProviderCapabilities,
  type ProviderConnectFlow,
  type ProviderConnection,
  type ProviderErrorKind,
  type ProviderErrorOptions,
  type ProviderInstitution,
  type ProviderLiability,
  type ProviderLiabilityKind,
  type ProviderRemovedTransaction,
  type ProviderSecret,
  type ProviderTransaction,
  type SyncPage,
  type SyncRequest,
  type SyncWindow,
} from './aggregation.js';
export { splitRuleFor, splitShares, type SplitPolicyRow, type SplitRuleInput } from './split.js';
export {
  etagFor,
  parseIfMatch,
  planVersionedPatch,
  type FieldConflict,
  type PatchPlan,
  type VersionState,
} from './versioned-patch.js';
