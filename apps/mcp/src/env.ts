// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineEnv, logLevel, nodeEnv } from '@fiscus/env';

export default defineEnv('mcp', {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
});
