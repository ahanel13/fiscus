#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describeError, loadEnvOrExit } from '@fiscus/env';
import migrateEnv from './env.js';
import { runMigrations } from './migrate.js';

const env = loadEnvOrExit(migrateEnv);

try {
  await runMigrations(env.MIGRATION_DATABASE_URL, {
    appPassword: env.APP_DATABASE_PASSWORD,
    maintenancePassword: env.MAINTENANCE_DATABASE_PASSWORD,
    backup: env.MIGRATE_BACKUP
      ? {
          dir: env.MIGRATE_BACKUP_DIR,
          keep: env.MIGRATE_BACKUP_KEEP,
          recipients: env.BACKUP_AGE_RECIPIENTS,
        }
      : undefined,
    log: (message) => console.log(`[migrate] ${message}`),
  });
} catch (err) {
  // The ORM's message is the migration's own SQL, from the repo. The database's reason is in the
  // cause: its code, table, and constraint say what failed, but not its message or detail, which
  // can quote the rows ("Key (name)=(…) is duplicated"): no financial data in logs (#308).
  console.error('[migrate] failed:', err instanceof Error ? err.message : 'a thrown value');
  const cause = (err as { cause?: unknown }).cause;
  if (cause) {
    console.error('[migrate] because:', describeError(cause));
    const hint = (cause as { hint?: unknown }).hint;
    if (typeof hint === 'string') console.error('[migrate] hint:', hint);
  }
  process.exit(1);
}
