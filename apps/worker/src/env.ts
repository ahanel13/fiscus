import { defineEnv, logLevel, nodeEnv } from '@fiscus/env';

export default defineEnv('worker', {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
});
