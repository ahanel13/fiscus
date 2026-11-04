// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldContext, FieldCrypto } from '@fiscus/crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from './client.js';
import { instanceSettings } from './schema/instance-settings.js';

// The mail server an instance admin set on the Server page (#125, D16), kept in instance settings
// under its own key, outside the registry of plain settings: its password is encrypted with the
// instance key (bound to this setting), and never returned, logged or in activity. SMTP_URL and
// MAIL_FROM, when set, win over it.

export const MAIL_SETTING_KEY = 'mail.smtp';

const passwordContext: FieldContext = {
  table: 'instance_settings',
  column: 'value',
  rowId: MAIL_SETTING_KEY,
};

const storedSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls', 'none']),
  username: z.string().nullable(),
  /** Base64 of the ciphertext. */
  passwordEnc: z.string().nullable(),
  from: z.string().min(1),
});
export type StoredMailValue = z.infer<typeof storedSchema>;

/** The stored mail server, with its password decrypted. */
export interface StoredMail {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string | null;
  password: string | null;
  from: string;
  /** A password is saved but couldn't be decrypted (a master key no longer here): set it again. */
  passwordUnreadable: boolean;
}

/** The stored value as it is, password still encrypted; null when none is set (or it's removed). */
export async function readStoredMailValue(tx: Executor): Promise<StoredMailValue | null> {
  const [row] = await tx
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, MAIL_SETTING_KEY));
  const parsed = storedSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

/** The stored mail server, decrypted, or null. */
export async function readStoredMail(
  tx: Executor,
  crypto: FieldCrypto,
): Promise<StoredMail | null> {
  const v = await readStoredMailValue(tx);
  if (!v) return null;
  const { passwordEnc, ...rest } = v;
  if (!passwordEnc) return { ...rest, password: null, passwordUnreadable: false };
  try {
    const password = crypto.decryptInstance(passwordContext, Buffer.from(passwordEnc, 'base64'));
    return { ...rest, password, passwordUnreadable: false };
  } catch {
    // Tampered with, or under a master key that's no longer loaded.
    return { ...rest, password: null, passwordUnreadable: true };
  }
}

/** The password, encrypted for storing in the setting (base64). */
export function encryptMailPassword(crypto: FieldCrypto, password: string): string {
  return crypto.encryptInstance(passwordContext, password).toString('base64');
}
