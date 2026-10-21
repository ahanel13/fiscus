// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto, HouseholdFieldContext } from '@fiscus/crypto';
import { eq } from 'drizzle-orm';
import type { Executor } from './client.js';
import { connectionSecrets } from './schema/connections.js';

// A connection's provider secret (Plaid access token, SimpleFIN access URL), encrypted with the
// household key and bound to its connection: a ciphertext copied to another connection's row, or
// another household's, doesn't decrypt. Row-level security lets only the connection's owner and
// the worker read or write it (migration 0037). Never return, log, or record it in activity.

const secretContext = (householdId: string, connectionId: string): HouseholdFieldContext => ({
  householdId,
  table: 'connection_secrets',
  column: 'secret_enc',
  rowId: connectionId,
});

/** Stores (or replaces, after re-auth) a connection's secret. */
export async function saveConnectionSecret(
  tx: Executor,
  crypto: FieldCrypto,
  householdId: string,
  connectionId: string,
  secret: string,
): Promise<void> {
  const secretEnc = await crypto.encrypt(secretContext(householdId, connectionId), secret);
  await tx
    .insert(connectionSecrets)
    .values({ connectionId, householdId, secretEnc })
    .onConflictDoUpdate({
      target: connectionSecrets.connectionId,
      set: { secretEnc, updatedAt: new Date() },
    });
}

/** The secret, or null when there is none or it isn't the caller's to read. */
export async function readConnectionSecret(
  tx: Executor,
  crypto: FieldCrypto,
  householdId: string,
  connectionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ secretEnc: connectionSecrets.secretEnc })
    .from(connectionSecrets)
    .where(eq(connectionSecrets.connectionId, connectionId));
  return row ? crypto.decrypt(secretContext(householdId, connectionId), row.secretEnc) : null;
}
