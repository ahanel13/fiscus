export { createDb, type CreateDbOptions, type Database, type DbHandle } from './client.js';
export { pingDatabase } from './health.js';
export { bytea, householdId, id, money, timestamps, versioning } from './columns.js';
export {
  HouseholdKeyNotFoundError,
  HouseholdKeyStore,
  type HouseholdKeyStoreOptions,
} from './household-key-store.js';
export { MIGRATIONS_FOLDER, runMigrations, type MigrateOptions } from './migrate.js';
export * as schema from './schema/index.js';
