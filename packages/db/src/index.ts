export { createDb, type Database, type DbHandle } from './client.js';
export { householdId, id, money, timestamps, versioning } from './columns.js';
export { MIGRATIONS_FOLDER, runMigrations, type MigrateOptions } from './migrate.js';
export * as schema from './schema/index.js';
