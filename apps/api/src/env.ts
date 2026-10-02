import { defineEnv, host, logLevel, nodeEnv, port } from '@fiscus/env';

export default defineEnv('api', {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  HOST: host,
  PORT: port(3000),
});
