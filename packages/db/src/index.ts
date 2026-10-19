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
  INSTANCE_SCOPE,
  verifyChain,
  type ActivityEntry,
  type ChainVerification,
} from './activity.js';
export { systemContext, userContext, withContext, type DbContext } from './context.js';
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
