import { createDb, type Database } from './client.js';
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
