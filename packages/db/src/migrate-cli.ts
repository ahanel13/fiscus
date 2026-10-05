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
    log: (message) => console.log(`[migrate] ${message}`),
  });
} catch (err) {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
