// SPDX-License-Identifier: AGPL-3.0-or-later
import { plaidEnvVars } from '@fiscus/aggregation';
import {
  encryptionKeyEnv,
  encryptionKeyVersionEnv,
  previousEncryptionKeyEnv,
  previousEncryptionKeyVersionEnv,
} from '@fiscus/crypto';
import { databaseUrl, defineEnv, logLevel, nodeEnv, port } from '@fiscus/env';

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
});
