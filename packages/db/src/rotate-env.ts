// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  encryptionKeyEnv,
  encryptionKeyVersionEnv,
  previousEncryptionKeyEnv,
  previousEncryptionKeyVersionEnv,
} from '@fiscus/crypto';
import { defineEnv, logLevel } from '@fiscus/env';
import { z } from 'zod';

/** Master key rotation (`fiscus-rotate-key`, docs/security/encryption.md, #25). */
export default defineEnv('rotate-key', {
  MAINTENANCE_DATABASE_URL: {
    schema: z.url(),
    description:
      'Postgres URL as fiscus_maintenance, the role allowed to reach every household for key rotation and other maintenance jobs.',
    example: 'postgres://fiscus_maintenance:change-me@localhost:5432/fiscus',
    secret: true,
  },
  APP_ENCRYPTION_KEY: encryptionKeyEnv,
  APP_ENCRYPTION_KEY_VERSION: encryptionKeyVersionEnv,
  APP_ENCRYPTION_KEY_PREVIOUS: previousEncryptionKeyEnv,
  APP_ENCRYPTION_KEY_PREVIOUS_VERSION: previousEncryptionKeyVersionEnv,
  LOG_LEVEL: logLevel,
});
