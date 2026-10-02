import { z } from 'zod';
import type { EnvVarSpec } from './env.js';

export const databaseUrl = {
  schema: z.url(),
  description: 'Postgres URL. Services connect as fiscus_app; the migrate job as the schema owner.',
  example: 'postgres://fiscus_app:change-me@localhost:5432/fiscus',
  secret: true,
} satisfies EnvVarSpec;
