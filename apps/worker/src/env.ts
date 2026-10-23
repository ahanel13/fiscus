// SPDX-License-Identifier: AGPL-3.0-or-later
import { plaidEnvVars, simpleFinEnvVars } from '@fiscus/aggregation';
import {
  encryptionKeyEnv,
  encryptionKeyVersionEnv,
  previousEncryptionKeyEnv,
  previousEncryptionKeyVersionEnv,
} from '@fiscus/crypto';
import { databaseUrl, defineEnv, logLevel, nodeEnv, port } from '@fiscus/env';
import { z } from 'zod';

export default defineEnv('worker', {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  HEALTH_PORT: { ...port(3001), description: 'Port for the worker health endpoints.' },
  DATABASE_URL: databaseUrl,
  APP_ENCRYPTION_KEY: encryptionKeyEnv,
  APP_ENCRYPTION_KEY_VERSION: encryptionKeyVersionEnv,
  APP_ENCRYPTION_KEY_PREVIOUS: previousEncryptionKeyEnv,
  APP_ENCRYPTION_KEY_PREVIOUS_VERSION: previousEncryptionKeyVersionEnv,
  // The server's own Plaid keys (ADR 0008, #82): all three or none, checked at startup.
  ...plaidEnvVars,
  // Where SimpleFIN access URLs may point (#91, threat model T28): the same as the api's.
  ...simpleFinEnvVars,
  SYNC_INTERVAL_HOURS: {
    schema: z.coerce.number().int().min(1).max(24).optional(),
    description:
      "Hours between scheduled bank syncs, overriding the instance admin's setting (Server → Bank " +
      'connections). Leave empty to use that setting (default 4).',
  },
  SYNC_POLL_SECONDS: {
    schema: z.coerce.number().int().min(1).max(300).default(5),
    description: "Seconds between the worker's checks for connections that are due to sync.",
    example: '5',
  },
});
