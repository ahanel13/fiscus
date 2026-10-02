import { databaseUrl, defineEnv, logLevel } from '@fiscus/env';
import { z } from 'zod';

export default defineEnv('migrate', {
  DATABASE_URL: databaseUrl,
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
