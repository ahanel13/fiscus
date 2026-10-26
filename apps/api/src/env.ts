// SPDX-License-Identifier: AGPL-3.0-or-later
import { plaidEnvVars, simpleFinEnvVars } from '@fiscus/aggregation';
import {
  encryptionKeyEnv,
  encryptionKeyVersionEnv,
  previousEncryptionKeyEnv,
  previousEncryptionKeyVersionEnv,
} from '@fiscus/crypto';
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
  APP_ENCRYPTION_KEY_PREVIOUS: previousEncryptionKeyEnv,
  APP_ENCRYPTION_KEY_PREVIOUS_VERSION: previousEncryptionKeyVersionEnv,
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
  VALKEY_URL: {
    schema: z
      .url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' })
      .optional(),
    description:
      'Valkey (or Redis) URL, where rate limits are counted so they hold across api replicas and ' +
      'restarts. Unset: each api process counts its own.',
    example: 'redis://localhost:6379',
    secret: true,
  },
  // The server's own Plaid keys (ADR 0008, #82): all three or none, checked at startup.
  ...plaidEnvVars,
  // Where SimpleFIN setup tokens may point (#91, threat model T28).
  ...simpleFinEnvVars,
});
