// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  connections,
  instanceSettings,
  systemContext,
  withContext,
  type Database,
} from '@fiscus/db';
import { instanceSettingValue } from '@fiscus/shared';
import { eq, sql } from 'drizzle-orm';
import type { JobTarget } from './jobs.js';

// The runner's queue, in Postgres (migrations 0037 and connection_jobs): claiming due
// connections and finishing them happen outside any household's context, by id, through definer
// functions that work only for a session logged in as fiscus_worker. Only reading a claimed
// connection uses its household's system context.

export interface Claimed {
  connectionId: string;
  householdId: string;
}

const interval = (ms: number) => `${Math.max(0, Math.round(ms))} milliseconds`;

/** Up to `limit` due connections, leased for `leaseMs`. */
export async function claimDue(db: Database, limit: number, leaseMs: number): Promise<Claimed[]> {
  const { rows } = await db.execute<{ connection_id: string; household_id: string }>(
    sql`SELECT connection_id, household_id
        FROM fiscus_claim_due_connections(${limit}, ${interval(leaseMs)}::interval)`,
  );
  return rows.map((r) => ({ connectionId: r.connection_id, householdId: r.household_id }));
}

/** The claimed connection, or null when it's gone. */
export async function readTarget(db: Database, claimed: Claimed): Promise<JobTarget | null> {
  const [row] = await withContext(db, systemContext(claimed.householdId), (tx) =>
    tx
      .select({
        provider: connections.provider,
        status: connections.status,
        disconnectRequested: connections.disconnectRequested,
        consecutiveFailures: connections.consecutiveFailures,
        credentialSetId: connections.credentialSetId,
        providerEnv: connections.providerEnv,
        providerClientId: connections.providerClientId,
      })
      .from(connections)
      .where(eq(connections.id, claimed.connectionId)),
  );
  return row ? { ...claimed, ...row } : null;
}

export type Finish =
  | { outcome: 'synced'; nextInMs: number }
  | { outcome: 'failed'; nextInMs: number; status: 'error' | 'login_required'; code: string }
  | { outcome: 'done' | 'released' };

/** Ends a claimed connection's job; false when it wasn't leased any more. */
export async function finishJob(db: Database, connectionId: string, f: Finish): Promise<boolean> {
  const next = 'nextInMs' in f ? interval(f.nextInMs) : null;
  const status = f.outcome === 'failed' ? f.status : null;
  const code = f.outcome === 'failed' ? f.code : null;
  const { rows } = await db.execute<{ found: boolean }>(
    sql`SELECT fiscus_finish_connection_job(${connectionId}, ${f.outcome}, ${next}::interval,
                                            ${status}, ${code}) AS found`,
  );
  return rows[0]?.found ?? false;
}

/** `sync.intervalHours` as the instance admin set it (#400), or its default. */
export async function syncIntervalHours(db: Database): Promise<number> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, 'sync.intervalHours'));
  return instanceSettingValue('sync.intervalHours', row?.value);
}
