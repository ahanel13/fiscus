// SPDX-License-Identifier: AGPL-3.0-or-later
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

// Arbitrary constant: serializes concurrent `migrate` runs (e.g. two replicas starting at once).
const MIGRATION_LOCK = 4_217_001;

export interface MigrateOptions {
  appPassword?: string | undefined;
  maintenancePassword?: string | undefined;
  log?: (message: string) => void;
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
    maintenancePassword,
    log = () => {},
    migrationsFolder = MIGRATIONS_FOLDER,
  }: MigrateOptions = {},
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await migrate(drizzle(client), { migrationsFolder });
    log('Migrations applied');

    // Role passwords can't be bind parameters, so they are escaped as literals.
    for (const [role, password] of [
      ['fiscus_app', appPassword],
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
