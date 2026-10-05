import { appendActivity, auditEvents, type DbHandle } from '@fiscus/db';
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../database/database.module.js';

export interface AuditEntry {
  actorKind: (typeof auditEvents.$inferInsert)['actorKind'];
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** IDs and field names only, never financial plaintext or secrets. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Instance-level events (sign-in, setup, password resets) on the instance activity chain.
 * Household events are recorded inside their own transaction via HouseholdScope (ADR 0013).
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.db.transaction((tx) =>
      appendActivity(tx, {
        ...entry,
        householdId: null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
      }),
    );
  }
}
