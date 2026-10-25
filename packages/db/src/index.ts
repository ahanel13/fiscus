// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  createDb,
  type CreateDbOptions,
  type Database,
  type DbHandle,
  type Executor,
} from './client.js';
export {
  appendActivity,
  canonical,
  foldLeaves,
  GENESIS_HASH,
  HASH_VERSION,
  householdProof,
  INSTANCE_SCOPE,
  PROOF_PAGE_SIZE,
  verifyChain,
  verifyHouseholdChain,
  type ActivityEntry,
  type ChainVerification,
  type HouseholdProof,
} from './activity.js';
export { readConnectionSecret, saveConnectionSecret } from './connection-secrets.js';
export {
  activePlaidKeySet,
  type PlaidKeySet,
  plaidKeySetUses,
  readPlaidKeySet,
  revokePlaidKeySet,
  savePlaidKeySet,
  shredPlaidKeySet,
} from './plaid-credentials.js';
export { setContext, systemContext, userContext, withContext, type DbContext } from './context.js';
export { MAINTENANCE_JOBS, runMaintenanceJob, type MaintenanceJob } from './maintenance.js';
export { pingDatabase } from './health.js';
export { bytea, householdId, id, money, timestamps, versioning } from './columns.js';
export {
  HouseholdKeyNotFoundError,
  HouseholdKeyStore,
  type HouseholdKeyStoreOptions,
  masterKeyUsage,
  rewrapHouseholdKeys,
  type RewrapResult,
} from './household-key-store.js';
export { MIGRATIONS_FOLDER, runMigrations, type MigrateOptions } from './migrate.js';
export * as schema from './schema/index.js';
export * from './schema/index.js';
