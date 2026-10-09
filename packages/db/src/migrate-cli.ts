#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadEnvOrExit } from '@fiscus/env';
import migrateEnv from './env.js';
import { runMigrations } from './migrate.js';

const env = loadEnvOrExit(migrateEnv);

try {
  await runMigrations(env.MIGRATION_DATABASE_URL, {
    appPassword: env.APP_DATABASE_PASSWORD,
    maintenancePassword: env.MAINTENANCE_DATABASE_PASSWORD,
    backup: env.MIGRATE_BACKUP
      ? { dir: env.MIGRATE_BACKUP_DIR, keep: env.MIGRATE_BACKUP_KEEP }
      : undefined,
    log: (message) => console.log(`[migrate] ${message}`),
  });
} catch (err) {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  // The ORM's message is the SQL that failed; the database's reason is in the cause.
  for (let cause = (err as { cause?: unknown }).cause; cause;) {
    const c = cause as { message?: string; detail?: string; hint?: string; cause?: unknown };
    console.error('[migrate] because:', c.message ?? cause);
    if (c.detail) console.error('[migrate] detail:', c.detail);
    if (c.hint) console.error('[migrate] hint:', c.hint);
    cause = c.cause;
  }
  process.exit(1);
}
