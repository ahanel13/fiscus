// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PlaidEnvironment, SignupMode } from '@fiscus/shared';

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
  /**
   * The instance's Plaid keys, when set (walkthrough §8). Nothing sets this yet: #82 reads
   * PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV into it, and adds the keys themselves.
   */
  plaid?: { environment: PlaidEnvironment } | undefined;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
