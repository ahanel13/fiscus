// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SignupMode } from '@fiscus/shared';

export interface AppConfig {
  databaseUrl: string;
  encryptionKey: string;
  encryptionKeyVersion: number;
  publicUrl: string;
  signupMode: SignupMode;
  cookieSecure: boolean;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
