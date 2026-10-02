import { defineEnv, logLevel } from '@fiscus/env';
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
  LOG_LEVEL: logLevel,
});
