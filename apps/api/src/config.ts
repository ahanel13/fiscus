// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PlaidInstanceConfig, SimpleFinInstanceConfig } from '@fiscus/aggregation';
import type { MailConfig, MailTransport } from '@fiscus/notify';
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
  /** Where rate limits are counted across replicas (#377). Unset: in this process's memory. */
  valkeyUrl?: string | undefined;
  /**
   * The server's own Plaid keys (#82), or undefined when Plaid isn't configured. Resolve a
   * connection's keys with `resolvePlaidCredentials`, never from here directly.
   */
  plaid?: PlaidInstanceConfig | undefined;
  /** Where SimpleFIN setup tokens may point (#91). Defaults to the Bridge's hosts. */
  simplefin?: SimpleFinInstanceConfig | undefined;
  /**
   * The server's mail settings (SMTP_URL, MAIL_FROM; D16), or undefined without them. The worker
   * sends notifications; the api only says whether it can, and sends the admin's test.
   */
  mail?: MailConfig | undefined;
  /** Tests only: a stub in place of the SMTP transport. */
  mailTransport?: MailTransport | undefined;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
