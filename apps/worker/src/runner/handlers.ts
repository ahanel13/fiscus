// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  aggregationCredentials,
  connections,
  connectionSecrets,
  plaidKeySetUses,
  readConnectionSecret,
  readPlaidKeySet,
  shredPlaidKeySet,
  systemContext,
  withContext,
} from '@fiscus/db';
import { guardActivity, type Actor } from '@fiscus/ledger';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { refreshInstitution } from '../sync/institution.js';
import { fetchMerchantLogos } from '../sync/merchant-logos.js';
import { readSyncState, syncConnection } from '../sync/sync.js';
import { FAILURE, JobFailure, type JobContext, type JobHandler } from './jobs.js';
import { readTarget } from './queue.js';

// The jobs the runner dispatches (#81). Secrets are decrypted here, passed to the provider, and
// dropped: never returned, logged, or recorded.

/** The instance itself, for what the worker records (ADR 0013). */
const WORKER: Actor = { kind: 'system', userId: null, memberId: null };

const readSecret = (job: JobContext) =>
  withContext(job.db, systemContext(job.householdId), (tx) =>
    readConnectionSecret(tx, job.crypto, job.householdId, job.connectionId),
  );

/**
 * The adapter for this connection, with the keys it was made with (ADR 0008; Plaid's per
 * connection, #82): the household's own set, decrypted for this job only, when it was made with
 * one (#83). Not enabled here: `provider_unavailable`; made with other keys:
 * `credentials_changed`; its household keys gone: `household_keys_unavailable` (failureOf).
 */
const providerFor = async (job: JobContext) =>
  job.providers.forConnection({
    ...job,
    householdKeys: job.credentialSetId
      ? await withContext(job.db, systemContext(job.householdId), (tx) =>
          readPlaidKeySet(tx, job.crypto, job.householdId, job.credentialSetId!),
        )
      : null,
  });

/**
 * Clears the webhook requests (#84) this job answers, at its start: only the ones it saw, so one
 * that arrives while it runs stays, and the connection is synced again after. Scheduling
 * bookkeeping, like finishing a job, so not recorded as activity. Compared to the millisecond, as
 * the job read them.
 */
async function answer(job: JobContext, which: ('sync' | 'check')[]): Promise<void> {
  const seen = {
    sync: which.includes('sync') ? job.syncRequestedAt : null,
    check: which.includes('check') ? job.checkRequestedAt : null,
  };
  if (!seen.sync && !seen.check) return;
  await withContext(job.db, systemContext(job.householdId), async (tx) => {
    if (seen.sync) {
      await tx
        .update(connections)
        .set({ syncRequestedAt: null })
        .where(
          and(
            eq(connections.id, job.connectionId),
            sql`date_trunc('milliseconds', ${connections.syncRequestedAt}) <= ${seen.sync}`,
          ),
        );
    }
    if (seen.check) {
      await tx
        .update(connections)
        .set({ checkRequestedAt: null })
        .where(
          and(
            eq(connections.id, job.connectionId),
            sql`date_trunc('milliseconds', ${connections.checkRequestedAt}) <= ${seen.check}`,
          ),
        );
    }
  });
}

/**
 * A scheduled sync (#80): the connection's new, changed and removed transactions, its balances,
 * and its card and loan details, written for its household in system context and recorded as
 * the system's, for the connection's owner. A connection whose owner has left isn't synced.
 */
export const syncJob: JobHandler = {
  kind: 'sync',
  async run(job) {
    await answer(job, ['sync']);
    const provider = await providerFor(job);
    const state = await readSyncState(job, job);
    if (!state) throw new JobFailure(FAILURE.internal);
    if (state.ownerLeft) throw new JobFailure(FAILURE.ownerLeft);
    const secret = await readSecret(job);
    if (secret === null) throw new JobFailure(FAILURE.secretMissing);
    await syncConnection(
      job,
      provider,
      secret,
      {
        householdId: job.householdId,
        connectionId: job.connectionId,
        ownerMemberId: state.ownerMemberId,
      },
      state,
    );
    await refreshInstitution(job, provider);
    // Best effort: the sync has succeeded whatever happens to a logo (#423).
    await fetchMerchantLogos(job.db, job.fetchLogo ? { fetchImpl: job.fetchLogo } : {}).catch(
      () => undefined,
    );
    return 'synced';
  },
};

/**
 * A verified webhook said the Item changed (#84, WEBHOOK-006): an error, a login fixed at the
 * bank, consent ending, permission revoked, or new accounts. The webhook itself is never trusted:
 * the provider is asked (`/item/get`). Its error, if it has one, is the job's failure, so a
 * broken login asks its owner to sign in again as a failed sync would. None: a connection waiting
 * for its owner is working again (recorded, for whoever sees its accounts), and it syncs, which
 * reads its accounts (`/accounts/get`) and so notices new ones.
 */
export const checkJob: JobHandler = {
  kind: 'check',
  async run(job) {
    await answer(job, ['check', 'sync']);
    const provider = await providerFor(job);
    const secret = await readSecret(job);
    if (secret === null) throw new JobFailure(FAILURE.secretMissing);
    await provider.checkStatus?.(secret);
    if (job.status === 'login_required') {
      await withContext(job.db, systemContext(job.householdId), (tx) =>
        guardActivity(tx, job.householdId, WORKER, job.crypto, async (tx, activity) => {
          const fixed = await tx
            .update(connections)
            .set({
              status: 'ok',
              lastErrorCode: null,
              firstFailedAt: null,
              consecutiveFailures: 0,
              updatedAt: new Date(),
            })
            .where(
              and(eq(connections.id, job.connectionId), eq(connections.status, 'login_required')),
            )
            .returning({ id: connections.id });
          if (fixed.length === 0) return;
          // Seen by whoever sees its accounts: they saw it break (D11).
          await activity.record({
            action: 'connection.repaired_at_bank',
            targetType: 'connection',
            targetId: job.connectionId,
            metadata: { provider: job.provider },
          });
        }),
      );
    }
    return syncJob.run({ ...job, status: 'ok', syncRequestedAt: null });
  },
};

/**
 * Moves a connection's Item to this server's webhook URL, or off webhooks (#84, WEBHOOK-002):
 * `/item/webhook/update` with the keys it was made with, household-key Items included. Plaid
 * confirms with WEBHOOK_UPDATE_ACKNOWLEDGED, which turns `webhook_enabled` on; until then it's
 * off. A failure is retried an hour later. Returns whether it moved.
 */
export async function moveWebhook(
  deps: Pick<JobContext, 'db' | 'crypto' | 'providers'>,
  claimed: { connectionId: string; householdId: string },
  url: string | null,
): Promise<boolean> {
  const mark = (set: Partial<typeof connections.$inferInsert>) =>
    withContext(deps.db, systemContext(claimed.householdId), (tx) =>
      tx.update(connections).set(set).where(eq(connections.id, claimed.connectionId)),
    );
  try {
    const target = await readTarget(deps.db, claimed);
    if (!target) return false;
    const job: JobContext = { ...target, ...deps };
    const provider = await providerFor(job);
    if (!provider.setWebhook) return false;
    const secret = await readSecret(job);
    if (secret === null) throw new JobFailure(FAILURE.secretMissing);
    await provider.setWebhook(secret, url);
  } catch (error) {
    await mark({ webhookMoveFailedAt: new Date() });
    throw error;
  }
  await mark({ webhookUrl: url, webhookEnabled: false, webhookMoveFailedAt: null });
  return true;
}

/**
 * Ending a disconnected connection at its provider (D14; Plaid's `/item/remove`, so the operator
 * stops paying for it), then deleting its secret and clearing `disconnect_requested`. The secret
 * goes only once the provider has it removed: if that fails, or the provider is unavailable here,
 * the job fails and is retried with the secret kept. A connection whose secret is already gone has
 * nothing to end.
 */
export const removeJob: JobHandler = {
  kind: 'remove',
  async run(job) {
    const secret = await readSecret(job);
    if (secret !== null) await (await providerFor(job)).remove(secret);
    await withContext(job.db, systemContext(job.householdId), (tx) =>
      guardActivity(tx, job.householdId, WORKER, job.crypto, async (tx, activity) => {
        await tx
          .delete(connectionSecrets)
          .where(eq(connectionSecrets.connectionId, job.connectionId));
        await tx
          .update(connections)
          .set({ disconnectRequested: false, updatedAt: new Date() })
          .where(
            and(eq(connections.id, job.connectionId), eq(connections.disconnectRequested, true)),
          );
        // Replaced household keys go once nothing needs them (#83): this was the last to end.
        if (job.credentialSetId) {
          const [revoked] = await tx
            .select({ id: aggregationCredentials.id })
            .from(aggregationCredentials)
            .where(
              and(
                eq(aggregationCredentials.id, job.credentialSetId),
                isNotNull(aggregationCredentials.revokedAt),
              ),
            );
          if (revoked && (await plaidKeySetUses(tx, revoked.id)) === 0) {
            await shredPlaidKeySet(tx, revoked.id);
          }
        }
        await activity.record({
          action: 'connection.ended_at_provider',
          targetType: 'connection',
          targetId: job.connectionId,
          metadata: { provider: job.provider, hadSecret: secret !== null },
          visibleToHousehold: false,
        });
      }),
    );
    return 'done';
  },
};

export const DEFAULT_JOB_HANDLERS = [syncJob, removeJob, checkJob];
