#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describeError, exitOnUnhandled, loadEnvOrExit } from '@fiscus/env';
import { nextScheduledBackupIn, scheduledBackup, waitAfterBackup } from './backup.js';
import backupEnv from './backup-env.js';

// Scheduled backups (docs/security/backups.md, #306): a dump every BACKUP_INTERVAL_HOURS, the
// newest BACKUP_KEEP kept, encrypted to BACKUP_AGE_RECIPIENTS. With an interval of 0, one dump
// now, and the exit code says whether it worked (cron, the restore drill).

const env = loadEnvOrExit(backupEnv);
exitOnUnhandled((message) => console.error(`[backup] ${message}`));
const HOUR = 3_600_000;
const options = {
  dir: env.BACKUP_DIR,
  keep: env.BACKUP_KEEP,
  recipients: env.BACKUP_AGE_RECIPIENTS,
};

if (!options.recipients.length) {
  console.warn(
    '[backup] BACKUP_AGE_RECIPIENTS is not set: backups are written unencrypted, so anyone with a copy can read them (docs/security/backups.md).',
  );
}

async function backUp(): Promise<boolean> {
  try {
    console.log(
      `[backup] written to ${await scheduledBackup(env.MIGRATION_DATABASE_URL, options)}`,
    );
    return true;
  } catch (err) {
    // pg_dump's and age's own errors (connection, permissions, a bad recipient) carry no rows.
    console.error('[backup] failed:', err instanceof Error ? err.message : describeError(err));
    return false;
  }
}

if (env.BACKUP_INTERVAL_HOURS === 0) {
  process.exit((await backUp()) ? 0 : 1);
}

const interval = env.BACKUP_INTERVAL_HOURS * HOUR;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => process.exit(0));
let wait = await nextScheduledBackupIn(options.dir, interval);
console.log(
  `[backup] every ${env.BACKUP_INTERVAL_HOURS} h, keeping ${options.keep}; next in ${Math.round(wait / 60_000)} min`,
);
for (;;) {
  await new Promise((r) => setTimeout(r, wait));
  // A failed backup is tried again in an hour, not a whole interval later.
  wait = waitAfterBackup(await backUp(), interval);
}
