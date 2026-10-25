// SPDX-License-Identifier: AGPL-3.0-or-later
import { DecryptionError, type FieldCrypto, type HouseholdFieldContext } from '@fiscus/crypto';
import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Executor } from './client.js';
import { aggregationCredentials, connections } from './schema/connections.js';

// A household's own Plaid keys (ADR 0008 §Credentials 2, #83). The secret is encrypted with the
// household key and bound to its row; it's write-only through the api, and never returned, logged
// or recorded. A household has at most one active set (`revoked_at` null): replacing it revokes
// the old one, which keeps serving the connections made with it until each is connected again or
// ended; then its secret is shredded (emptied), and the row stays for the connections that name it.

const secretContext = (householdId: string, id: string): HouseholdFieldContext => ({
  householdId,
  table: 'aggregation_credentials',
  column: 'secret_enc',
  rowId: id,
});

const SHREDDED = Buffer.alloc(0);

export interface PlaidKeySet {
  clientId: string;
  secret: string;
  env: 'sandbox' | 'production';
}

/** Stores a new set. The caller revokes any active set first. */
export async function savePlaidKeySet(
  tx: Executor,
  crypto: FieldCrypto,
  input: PlaidKeySet & { id: string; householdId: string; createdByMemberId: string },
): Promise<void> {
  await tx.insert(aggregationCredentials).values({
    id: input.id,
    householdId: input.householdId,
    provider: 'plaid',
    clientId: input.clientId,
    env: input.env,
    createdByMemberId: input.createdByMemberId,
    secretEnc: await crypto.encrypt(secretContext(input.householdId, input.id), input.secret),
  });
}

/**
 * A set's keys, revoked or not; null when it's gone, shredded, unreadable (a damaged or moved
 * ciphertext), or not the household's: in each case the keys can't be used.
 */
export async function readPlaidKeySet(
  tx: Executor,
  crypto: FieldCrypto,
  householdId: string,
  id: string,
): Promise<PlaidKeySet | null> {
  const [row] = await tx
    .select({
      clientId: aggregationCredentials.clientId,
      env: aggregationCredentials.env,
      secretEnc: aggregationCredentials.secretEnc,
    })
    .from(aggregationCredentials)
    .where(
      and(eq(aggregationCredentials.id, id), eq(aggregationCredentials.householdId, householdId)),
    );
  if (!row || row.secretEnc.length === 0) return null;
  if (row.env !== 'sandbox' && row.env !== 'production') return null;
  try {
    return {
      clientId: row.clientId,
      env: row.env,
      secret: await crypto.decrypt(secretContext(householdId, id), row.secretEnc),
    };
  } catch (err) {
    if (err instanceof DecryptionError) return null;
    throw err;
  }
}

/** The household's active Plaid set, without its secret; undefined when it has none. */
export async function activePlaidKeySet(tx: Executor, householdId: string) {
  const [row] = await tx
    .select({
      id: aggregationCredentials.id,
      clientId: aggregationCredentials.clientId,
      env: aggregationCredentials.env,
      createdAt: aggregationCredentials.createdAt,
    })
    .from(aggregationCredentials)
    .where(
      and(
        eq(aggregationCredentials.householdId, householdId),
        eq(aggregationCredentials.provider, 'plaid'),
        isNull(aggregationCredentials.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

/** Revokes a set; with `shred`, its secret goes too (nothing still needs it). */
export async function revokePlaidKeySet(tx: Executor, id: string, shred: boolean): Promise<void> {
  await tx
    .update(aggregationCredentials)
    .set({ revokedAt: new Date(), ...(shred && { secretEnc: SHREDDED }), updatedAt: new Date() })
    .where(eq(aggregationCredentials.id, id));
}

/** Empties a revoked set's secret, once no connection needs it any more. */
export async function shredPlaidKeySet(tx: Executor, id: string): Promise<void> {
  await tx
    .update(aggregationCredentials)
    .set({ secretEnc: SHREDDED, updatedAt: new Date() })
    .where(and(eq(aggregationCredentials.id, id), isNotNull(aggregationCredentials.revokedAt)));
}

/**
 * How many connections still need a set: live ones, and disconnected ones the worker hasn't ended
 * at Plaid yet (ending one calls `/item/remove` with the keys that made it).
 */
export async function plaidKeySetUses(tx: Executor, id: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(connections)
    .where(
      and(
        eq(connections.credentialSetId, id),
        or(ne(connections.status, 'disconnected'), eq(connections.disconnectRequested, true)),
      ),
    );
  return row?.n ?? 0;
}
