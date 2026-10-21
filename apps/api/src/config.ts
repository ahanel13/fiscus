// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PlaidInstanceConfig } from '@fiscus/aggregation';
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
  /**
   * The server's own Plaid keys (#82), or undefined when Plaid isn't configured. Resolve a
   * connection's keys with `resolvePlaidCredentials`, never from here directly.
   */
  plaid?: PlaidInstanceConfig | undefined;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
