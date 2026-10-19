// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineEnv, logLevel } from '@fiscus/env';
import { z } from 'zod';

/**
 * age recipients for backups (public keys, `age1…`), separated by spaces, commas, or new lines.
 * Public: a server holding them can encrypt but not decrypt (#306).
 */
export const backupRecipients = {
  schema: z
    .string()
    .default('')
    .transform((v) => v.split(/[\s,]+/).filter(Boolean))
    .pipe(
      z.array(
        z
          .string()
          .regex(/^age1[02-9ac-hj-np-z]{58}$/, 'Each recipient is an age public key (age1…)'),
      ),
    ),
  description:
    'age public keys (age1…) that backups are encrypted to; only their private keys, kept off the server, can restore them. Unset: backups are written unencrypted (docs/security/backups.md).',
};

/** The scheduled backup (`fiscus-backup`, docs/security/backups.md, #306). */
export default defineEnv('backup', {
  MIGRATION_DATABASE_URL: {
    schema: z.url(),
    description:
      'Postgres URL to dump, as the schema owner (not fiscus_app), so it sees every row.',
    example: 'postgres://fiscus_owner:change-me@localhost:5432/fiscus',
    secret: true,
  },
  BACKUP_AGE_RECIPIENTS: backupRecipients,
  BACKUP_DIR: {
    schema: z.string().min(1).default('/backups'),
    description: 'Where scheduled dumps go (the same volume as the pre-upgrade ones in compose).',
  },
  BACKUP_INTERVAL_HOURS: {
    schema: z.coerce
      .number()
      .min(0)
      .max(24 * 31)
      .default(24),
    description: 'Hours between backups. 0: take one now and exit (for cron, or a restore drill).',
  },
  BACKUP_KEEP: {
    schema: z.coerce.number().int().min(1).max(1000).default(7),
    description: 'How many scheduled dumps to keep; older ones are deleted.',
  },
  LOG_LEVEL: logLevel,
});
