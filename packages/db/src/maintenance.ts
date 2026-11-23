// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import { createDb, type Database, type Executor } from './client.js';
import { auditEvents } from './schema/identity.js';

/**
 * The only jobs allowed to connect as fiscus_maintenance, the role that bypasses row-level
 * security (data model §4.1). Each run is recorded in the audit log before the job starts.
 */
export const MAINTENANCE_JOBS = [
  'crypto-shred',
  'master-key-rewrap',
  'member-move',
  'audit-retention',
  'backup',
] as const;
export type MaintenanceJob = (typeof MAINTENANCE_JOBS)[number];

export interface MaintenanceRun {
  job: MaintenanceJob;
  /** Household the job affects, if any (shown in that household's activity). */
  householdId?: string;
  reason?: string;
}

export async function runMaintenanceJob<T>(
  maintenanceUrl: string,
  run: MaintenanceRun,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  if (!(MAINTENANCE_JOBS as readonly string[]).includes(run.job)) {
    throw new Error(`"${run.job}" is not an allow-listed maintenance job`);
  }
  const handle = createDb(maintenanceUrl, { max: 2 });
  try {
    await handle.db.insert(auditEvents).values({
      actorKind: 'system',
      householdId: run.householdId ?? null,
      action: `maintenance.${run.job}`,
      visibleToHousehold: Boolean(run.householdId),
      metadata: run.reason ? { reason: run.reason } : {},
    });
    return await fn(handle.db);
  } finally {
    await handle.close();
  }
}

/** A maintenance run on the worker's own connection: see startMaintenance. */
export interface MaintenanceSession {
  /** Runs `fn` in one transaction as fiscus_maintenance. */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
}

/**
 * For the worker, whose login may become fiscus_maintenance (migration 0122) for the jobs that
 * cross households: moving out (#253). Records the run in the audit log first, as
 * runMaintenanceJob does, then each transaction runs as fiscus_maintenance with SET LOCAL ROLE,
 * which ends with it. The api's login isn't a member of the role, so this fails there.
 */
export async function startMaintenance(
  db: Database,
  run: MaintenanceRun,
): Promise<MaintenanceSession> {
  if (!(MAINTENANCE_JOBS as readonly string[]).includes(run.job)) {
    throw new Error(`"${run.job}" is not an allow-listed maintenance job`);
  }
  const asMaintenance = <T>(fn: (tx: Executor) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE fiscus_maintenance`);
      return fn(tx);
    });
  await asMaintenance((tx) =>
    tx.insert(auditEvents).values({
      actorKind: 'system',
      householdId: run.householdId ?? null,
      action: `maintenance.${run.job}`,
      visibleToHousehold: Boolean(run.householdId),
      metadata: run.reason ? { reason: run.reason } : {},
    }),
  );
  return { transaction: asMaintenance };
}
