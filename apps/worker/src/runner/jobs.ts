// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ProviderUnavailableError,
  UnknownProviderError,
  type ProviderRegistry,
} from '@fiscus/aggregation';
import { DecryptionError, type FieldCrypto } from '@fiscus/crypto';
import type { Database } from '@fiscus/db';
import { ProviderError } from '@fiscus/domain';

// What the runner does with a claimed connection: one job, chosen by the connection's state and
// run by the handler registered for that kind.

/** `sync` for a connection that's polled; `remove` to end a disconnected one at its provider. */
export type JobKind = 'sync' | 'remove';

/** The connection a job runs for, as the runner read it in its household's system context. */
export interface JobTarget {
  connectionId: string;
  householdId: string;
  /** `connections.provider`: which adapter in the registry talks to it. */
  provider: string;
  status: string;
  disconnectRequested: boolean;
  consecutiveFailures: number;
  /** The keys it was made with (ADR 0008): null = the server's. Never the secret. */
  credentialSetId: string | null;
  providerEnv: string | null;
  providerClientId: string | null;
}

export interface JobContext extends JobTarget {
  /** Logged in as fiscus_worker: household data only through `systemContext(householdId)`. */
  db: Database;
  crypto: FieldCrypto;
  providers: ProviderRegistry;
}

/**
 * `synced`: next due after the interval. `done`: never due again (ended at the provider). A job
 * that fails throws; the runner backs it off.
 */
export type JobOutcome = 'synced' | 'done';

export interface JobHandler {
  readonly kind: JobKind;
  run(job: JobContext): Promise<JobOutcome>;
}

/** The job a claimed connection gets, or null when there's nothing left to do for it. */
export function jobKindFor(
  target: Pick<JobTarget, 'status' | 'disconnectRequested'>,
): JobKind | null {
  if (target.status === 'disconnected') return target.disconnectRequested ? 'remove' : null;
  return target.status === 'ok' || target.status === 'error' ? 'sync' : null;
}

/** The handlers this worker runs, by kind. */
export class JobHandlers {
  readonly #handlers = new Map<JobKind, JobHandler>();

  constructor(handlers: Iterable<JobHandler>) {
    for (const handler of handlers) {
      if (this.#handlers.has(handler.kind)) {
        throw new Error(`A handler is already registered for ${handler.kind} jobs`);
      }
      this.#handlers.set(handler.kind, handler);
    }
  }

  get(kind: JobKind): JobHandler | undefined {
    return this.#handlers.get(kind);
  }
}

/**
 * A job that failed for a reason with a code. The code is stored as `last_error_code` and logged,
 * so it's never a message or a value: the provider's code, or one of the worker's own.
 */
export class JobFailure extends Error {
  constructor(
    readonly code: string,
    /** `login_required` stops polling until its owner signs in again (D11). */
    readonly status: 'error' | 'login_required' = 'error',
    /** The provider's id for the failed request (Plaid's `request_id`), for its support. */
    readonly requestId?: string,
  ) {
    super(code);
    this.name = 'JobFailure';
  }
}

/** The worker's own codes. */
export const FAILURE = {
  /** No adapter for this connection's provider in this build or configuration. */
  providerUnavailable: 'provider_unavailable',
  /** Made with another Plaid client id or environment than this server's keys: reconnect (#82). */
  credentialsChanged: 'credentials_changed',
  /** Made with a household's own Plaid keys, which this server can't use yet (#83). */
  householdKeysUnavailable: 'household_keys_unavailable',
  secretMissing: 'secret_missing',
  secretUnreadable: 'secret_unreadable',
  timeout: 'timeout',
  /** The member who linked it has left the household: only a household owner disconnects it. */
  ownerLeft: 'owner_left',
  /** Another run moved the connection's cursor while this one was syncing it. */
  syncConflict: 'sync_conflict',
  /** Anything else: a bug, or the database. Logged with `describeError`. */
  internal: 'internal',
} as const;

const PROVIDER_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** What a failure is stored and logged as; `expected` is false for the ones worth a stack. */
export function failureOf(error: unknown): JobFailure & { expected: boolean } {
  const failure = (
    code: string,
    status: 'error' | 'login_required' = 'error',
    expected = true,
    requestId?: string,
  ) => Object.assign(new JobFailure(code, status, requestId), { expected });
  if (error instanceof JobFailure) return failure(error.code, error.status);
  if (error instanceof UnknownProviderError) return failure(FAILURE.providerUnavailable);
  if (error instanceof ProviderUnavailableError) {
    if (error.reason === 'credentials_changed') return failure(FAILURE.credentialsChanged);
    if (error.reason === 'household_keys_unavailable') {
      return failure(FAILURE.householdKeysUnavailable);
    }
    return failure(FAILURE.providerUnavailable);
  }
  if (error instanceof DecryptionError) return failure(FAILURE.secretUnreadable, 'error', false);
  if (error instanceof ProviderError) {
    const code = PROVIDER_CODE.test(error.providerCode) ? error.providerCode : error.kind;
    const signIn = error.kind === 'login_required' || error.kind === 'consent_expired';
    return failure(code, signIn ? 'login_required' : 'error', true, error.providerRequestId);
  }
  return failure(FAILURE.internal, 'error', false);
}
