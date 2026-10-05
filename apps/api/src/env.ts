// SPDX-License-Identifier: AGPL-3.0-or-later
import { encryptionKeyEnv, encryptionKeyVersionEnv } from '@fiscus/crypto';
import { booleanFlag, databaseUrl, defineEnv, host, logLevel, nodeEnv, port } from '@fiscus/env';
import { signupModeSchema } from '@fiscus/shared';
import { z } from 'zod';

export default defineEnv('api', {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  HOST: host,
  PORT: port(3000),
  DATABASE_URL: databaseUrl,
  APP_ENCRYPTION_KEY: encryptionKeyEnv,
  APP_ENCRYPTION_KEY_VERSION: encryptionKeyVersionEnv,
  PUBLIC_URL: {
    schema: z.url().default('http://localhost:8080'),
    description: 'Base URL people use to reach Fiscus. Used in links (invites, password resets).',
    example: 'http://localhost:8080',
  },
  SIGNUP_MODE: {
    schema: signupModeSchema.default('invite_only'),
    description: 'Who can create an account: open, invite_only, or closed (ADR 0005).',
    example: 'invite_only',
  },
  COOKIE_SECURE: booleanFlag(
    true,
    'Mark session cookies Secure (HTTPS only; browsers also allow localhost). Disable only for ' +
      'plain-HTTP LAN access, which exposes sessions to network snooping.',
  ),
  TRUST_PROXY: booleanFlag(
    false,
    'Trust X-Forwarded-For from a reverse proxy, for client IPs in rate limits and audit logs. ' +
      'Enable only when the api is reachable solely through that proxy.',
  ),
});
