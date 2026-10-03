import { auditEvents, type DbHandle, systemContext, withContext } from '@fiscus/db';
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../database/database.module.js';

export interface AuditEntry {
  actorKind: (typeof auditEvents.$inferInsert)['actorKind'];
  actorUserId?: string | null;
  actorMemberId?: string | null;
  householdId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  visibleToHousehold?: boolean;
  /** IDs and field names only, never financial plaintext or secrets. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  async record(entry: AuditEntry): Promise<void> {
    const values = {
      actorKind: entry.actorKind,
      actorUserId: entry.actorUserId ?? null,
      actorMemberId: entry.actorMemberId ?? null,
      householdId: entry.householdId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      visibleToHousehold: entry.visibleToHousehold ?? false,
      metadata: entry.metadata ?? {},
      ip: entry.ip ?? null,
    };
    // Household events need the household's context under row-level security.
    if (values.householdId) {
      await withContext(this.db.db, systemContext(values.householdId), (tx) =>
        tx.insert(auditEvents).values(values),
      );
    } else {
      await this.db.db.insert(auditEvents).values(values);
    }
  }
}
