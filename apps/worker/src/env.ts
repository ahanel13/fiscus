import { encryptionKeyEnv, encryptionKeyVersionEnv } from '@fiscus/crypto';
import { databaseUrl, defineEnv, logLevel, nodeEnv, port } from '@fiscus/env';

export default defineEnv('worker', {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  HEALTH_PORT: { ...port(3001), description: 'Port for the worker health endpoints.' },
  DATABASE_URL: databaseUrl,
  APP_ENCRYPTION_KEY: encryptionKeyEnv,
  APP_ENCRYPTION_KEY_VERSION: encryptionKeyVersionEnv,
});
