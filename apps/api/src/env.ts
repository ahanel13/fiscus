import { encryptionKeyEnv, encryptionKeyVersionEnv } from '@fiscus/crypto';
import { databaseUrl, defineEnv, host, logLevel, nodeEnv, port } from '@fiscus/env';

export default defineEnv('api', {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  HOST: host,
  PORT: port(3000),
  DATABASE_URL: databaseUrl,
  APP_ENCRYPTION_KEY: encryptionKeyEnv,
  APP_ENCRYPTION_KEY_VERSION: encryptionKeyVersionEnv,
});
