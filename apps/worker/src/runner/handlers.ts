// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  connections,
  connectionSecrets,
  readConnectionSecret,
  systemContext,
  withContext,
} from '@fiscus/db';
import { guardActivity, type Actor } from '@fiscus/ledger';
import { and, eq } from 'drizzle-orm';
import { readSyncState, syncConnection } from '../sync/sync.js';
import { FAILURE, JobFailure, type JobContext, type JobHandler } from './jobs.js';

// The jobs the runner dispatches (#81). Secrets are decrypted here, passed to the provider, and
// dropped: never returned, logged, or recorded.

/** The instance itself, for what the worker records (ADR 0013). */
const WORKER: Actor = { kind: 'system', userId: null, memberId: null };

const readSecret = (job: JobContext) =>
  withContext(job.db, systemContext(job.householdId), (tx) =>
    readConnectionSecret(tx, job.crypto, job.householdId, job.connectionId),
  );

const providerFor = (job: JobContext) => {
  if (!job.providers.has(job.provider)) throw new JobFailure(FAILURE.providerUnavailable);
  return job.providers.get(job.provider);
};

/**
 * A scheduled sync (#80): the connection's new, changed and removed transactions, its balances,
 * and its card and loan details, written for its household in system context and recorded as
 * the system's, for the connection's owner. A connection whose owner has left isn't synced.
 */
export const syncJob: JobHandler = {
  kind: 'sync',
  async run(job) {
    const provider = providerFor(job);
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
    return 'synced';
  },
};

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
    if (secret !== null) await providerFor(job).remove(secret);
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

export const DEFAULT_JOB_HANDLERS = [syncJob, removeJob];
