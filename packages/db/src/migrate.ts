// SPDX-License-Identifier: AGPL-3.0-or-later
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { backupDatabase, type BackupOptions, pendingMigrations } from './backup.js';

export const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

// Arbitrary constant: serializes concurrent `migrate` runs (e.g. two replicas starting at once).
const MIGRATION_LOCK = 4_217_001;

export interface MigrateOptions {
  appPassword?: string | undefined;
  /** For fiscus_worker, the only role system context works for (#271). */
  workerPassword?: string | undefined;
  maintenancePassword?: string | undefined;
  log?: (message: string) => void;
  /**
   * Dump the database before applying pending migrations (upgrades.md §5). Skipped when nothing
   * is pending, and on a fresh install. A failed backup stops the migration.
   */
  backup?: BackupOptions | undefined;
  /** Tests only: a folder holding the first N migrations, to stop partway. */
  migrationsFolder?: string;
}

/**
 * Applies pending migrations as the schema owner, then enables login for the service roles
 * whose passwords are provided. Safe to run repeatedly and concurrently.
 */
export async function runMigrations(
  url: string,
  {
    appPassword,
    workerPassword,
    maintenancePassword,
    log = () => {},
    backup,
    migrationsFolder = MIGRATIONS_FOLDER,
  }: MigrateOptions = {},
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    // Under the lock, so two jobs starting at once don't both dump.
    if (backup) {
      const pending = await pendingMigrations(client, migrationsFolder);
      if (pending === null) log('New database: no backup needed');
      else if (pending.length === 0) log('Nothing to apply: no backup needed');
      else {
        log(`${pending.length} migration(s) to apply; backing up first`);
        log(`Backup written to ${await backupDatabase(url, pending[0]!, backup)}`);
      }
    }
    await migrate(drizzle(client), { migrationsFolder });
    log('Migrations applied');
    // The worker has the app's privileges through membership (migration 0028). A dump keeps grants
    // but not memberships, so after a restore into a fresh server it would have none: re-assert it.
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fiscus_worker') THEN
        GRANT fiscus_app TO fiscus_worker;
      END IF;
    END $$`);

    // Role passwords can't be bind parameters, so they are escaped as literals.
    for (const [role, password] of [
      ['fiscus_app', appPassword],
      ['fiscus_worker', workerPassword],
      ['fiscus_maintenance', maintenancePassword],
    ] as const) {
      if (!password) continue;
      await client.query(
        `ALTER ROLE ${role} WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`,
      );
      log(`Login enabled for ${role}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    await client.end();
  }
}
