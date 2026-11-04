// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  connections,
  type Database,
  enqueueNotification,
  householdMembers,
  institutions,
  systemContext,
  withContext,
} from '@fiscus/db';
import { NOT_WORKING_AFTER_MS } from '@fiscus/shared';
import { eq } from 'drizzle-orm';

// "A bank connection needs you" (D18): told to whoever linked the connection, the only one who
// can fix it (ACC-03, D11). As Accounts shows it (bank sync walkthrough D10): at once when it
// needs them to sign in again, and only after 3 days of failures otherwise, since most failures
// Fiscus retries away on its own. Once per run of failures: the key names when it began.

export type ConnectionTrouble = 'needs_sign_in' | 'not_working';

/** What the connection's owner is told, at full and summary detail (D17). */
export function connectionTroubleText(trouble: ConnectionTrouble, bank: string | null) {
  const name = bank ?? 'your bank';
  return trouble === 'needs_sign_in'
    ? {
        title: `Sign in to ${name} again`,
        body: `Fiscus can’t sync ${bank ?? 'one of your banks'} until you sign in to it again. Your other banks keep syncing.`,
        summary: 'A bank connection needs you to sign in again.',
      }
    : {
        title: `${bank ?? 'A bank connection'} hasn’t synced for 3 days`,
        body: `Fiscus has been retrying ${bank ?? 'it'} since it stopped working. Reconnecting it from Accounts usually fixes it.`,
        summary: 'A bank connection has stopped working.',
      };
}

/**
 * After a connection's job failed: writes the notification for its owner if it needs them now.
 * Returns what it wrote about, or null. Writing it again for the same run of failures does
 * nothing (D20). The rules engine (#127) checks the owner can still see it; here the owner is the
 * one who linked it, who always can.
 */
export async function notifyConnectionTrouble(
  db: Database,
  householdId: string,
  connectionId: string,
  now = new Date(),
): Promise<ConnectionTrouble | null> {
  return withContext(db, systemContext(householdId), async (tx) => {
    const [c] = await tx
      .select({
        status: connections.status,
        firstFailedAt: connections.firstFailedAt,
        ownerMemberId: connections.ownerMemberId,
        provider: connections.provider,
        bank: institutions.name,
        ownerLeftAt: householdMembers.leftAt,
      })
      .from(connections)
      .innerJoin(householdMembers, eq(householdMembers.id, connections.ownerMemberId))
      .leftJoin(institutions, eq(institutions.id, connections.institutionId))
      .where(eq(connections.id, connectionId));
    if (!c?.firstFailedAt || c.ownerLeftAt) return null;
    const trouble: ConnectionTrouble | null =
      c.status === 'login_required'
        ? 'needs_sign_in'
        : c.status === 'error' && now.getTime() - c.firstFailedAt.getTime() >= NOT_WORKING_AFTER_MS
          ? 'not_working'
          : null;
    if (!trouble) return null;
    const bank = c.bank ?? (c.provider === 'simplefin' ? 'SimpleFIN' : null);
    const written = await enqueueNotification(tx, {
      householdId,
      memberId: c.ownerMemberId,
      kind: 'connection_needs_you',
      dedupeKey: `connection_needs_you:${connectionId}:${trouble}:${c.firstFailedAt.toISOString()}`,
      ...connectionTroubleText(trouble, bank),
      link: `/h/${householdId}/accounts`,
    });
    return written ? trouble : null;
  });
}
