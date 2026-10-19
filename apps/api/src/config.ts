// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SignupMode } from '@fiscus/shared';

export interface AppConfig {
  databaseUrl: string;
  encryptionKey: string;
  encryptionKeyVersion: number;
  /** During a key rotation: the previous master key and its version (#25). */
  encryptionKeyPrevious?: string | undefined;
  encryptionKeyPreviousVersion?: number | undefined;
  publicUrl: string;
  signupMode: SignupMode;
  cookieSecure: boolean;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
