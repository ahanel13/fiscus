import { defineEnv, logLevel, nodeEnv } from '@fiscus/env';

export default defineEnv('mcp', {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
});
