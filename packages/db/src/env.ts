// SPDX-License-Identifier: AGPL-3.0-or-later
import { booleanFlag, defineEnv, logLevel } from '@fiscus/env';
import { z } from 'zod';

// The migrate and seed jobs connect as the schema owner, separately from the services'
// DATABASE_URL (fiscus_app), so both can live in one .env file or compose stack.
export default defineEnv('migrate', {
  MIGRATION_DATABASE_URL: {
    schema: z.url(),
    description: 'Postgres URL for migrations and seeding, as the schema owner (not fiscus_app).',
    example: 'postgres://fiscus_owner:change-me@localhost:5432/fiscus',
    secret: true,
  },
  APP_DATABASE_PASSWORD: {
    schema: z.string().min(12).optional(),
    description: 'If set, migrate enables login for the fiscus_app role with this password.',
    secret: true,
  },
  MAINTENANCE_DATABASE_PASSWORD: {
    schema: z.string().min(12).optional(),
    description:
      'If set, migrate enables login for the fiscus_maintenance (BYPASSRLS) role with this password.',
    secret: true,
  },
  MIGRATE_BACKUP: booleanFlag(
    true,
    'Before applying pending migrations, write a pg_dump to MIGRATE_BACKUP_DIR (docs/design/upgrades.md §5). ' +
      'Turn off only if the database is backed up another way.',
  ),
  MIGRATE_BACKUP_DIR: {
    schema: z.string().min(1).default('/backups'),
    description: 'Where pre-migration dumps go (a volume in the compose stack).',
  },
  MIGRATE_BACKUP_KEEP: {
    schema: z.coerce.number().int().min(1).max(100).default(5),
    description: 'How many pre-migration dumps to keep; older ones are deleted.',
  },
  LOG_LEVEL: logLevel,
});
