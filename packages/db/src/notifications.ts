// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto, HouseholdFieldContext } from '@fiscus/crypto';
import type { Executor } from './client.js';
import { type NotificationEmails, notifications } from './schema/notifications.js';

// Writing a notification into the outbox, and a channel's secrets. The worker routes what's
// written to the recipient's channels and delivers it (#125, #126, #130).

export interface NewNotification {
  householdId: string;
  /** Who it's for. Whoever writes it makes sure it mentions only what they can see (SYS-02). */
  memberId: string;
  /** A rule's kind (@fiscus/shared NOTIFICATION_KINDS), or 'test'. */
  kind: string;
  /**
   * Once per occurrence and rule (D20): writing the same key for the same member again does
   * nothing, even after a restart. `connection_needs_you:<connection>:<since>`.
   */
  dedupeKey: string;
  /** Full detail (D17). */
  title: string;
  body: string;
  /** Summary detail: no amounts, names or places. */
  summary: string;
  /** Where it's about, as an app path (`/h/<household>/accounts`). */
  link?: string | null;
  /** A test: sent through this channel only, and not shown in the bell. */
  testChannel?: string | null;
  /** Its own email at each detail level, in place of one made from the title and body. */
  email?: NotificationEmails | null;
}

/**
 * Writes a notification for the worker to deliver, unless one with its key was already written.
 * Returns its id, or null when it was a repeat. Runs in the caller's household context: the
 * recipient's own (a test), or the worker's system context.
 */
export async function enqueueNotification(
  tx: Executor,
  n: NewNotification,
): Promise<string | null> {
  const [row] = await tx
    .insert(notifications)
    .values({
      householdId: n.householdId,
      memberId: n.memberId,
      kind: n.kind,
      dedupeKey: n.dedupeKey,
      title: n.title.slice(0, 200),
      body: n.body.slice(0, 2000),
      summary: n.summary.slice(0, 500),
      link: n.link ?? null,
      testChannel: n.testChannel ?? null,
      email: n.email ?? null,
    })
    .onConflictDoNothing({ target: [notifications.memberId, notifications.dedupeKey] })
    .returning({ id: notifications.id });
  return row?.id ?? null;
}

/** A channel's secrets are bound to its row: copied to another row, they don't decrypt. */
export const channelSecretContext = (
  householdId: string,
  channelId: string,
): HouseholdFieldContext => ({
  householdId,
  table: 'notification_channels',
  column: 'secret_enc',
  rowId: channelId,
});

/** Encrypts a channel's secrets (a JSON object) with the household key. */
export function encryptChannelSecret(
  crypto: FieldCrypto,
  householdId: string,
  channelId: string,
  secret: Record<string, string>,
): Promise<Buffer> {
  return crypto.encrypt(channelSecretContext(householdId, channelId), JSON.stringify(secret));
}

/** A channel's secrets, decrypted. Never return, log, or record them. */
export async function decryptChannelSecret(
  crypto: FieldCrypto,
  householdId: string,
  channelId: string,
  secretEnc: Buffer,
): Promise<Record<string, string>> {
  const text = await crypto.decrypt(channelSecretContext(householdId, channelId), secretEnc);
  return JSON.parse(text) as Record<string, string>;
}
