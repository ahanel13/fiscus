import { type DbHandle, type Executor, systemContext, withContext } from '@fiscus/db';
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../database/database.module.js';
import type { HouseholdContext } from './household-context.js';

/**
 * The only way household feature code reaches the database: every query runs in a transaction
 * carrying the household context, which row-level security enforces (#19). Enforced by
 * architecture.test.ts.
 */
@Injectable()
export class HouseholdScope {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  run<T>(ctx: HouseholdContext, fn: (tx: Executor) => Promise<T>): Promise<T> {
    return withContext(
      this.db.db,
      { householdId: ctx.householdId, memberId: ctx.memberId, userId: ctx.userId, system: false },
      fn,
    );
  }

  /** For acting in a household before a membership exists (creating it, joining it). */
  asSystem<T>(householdId: string, fn: (tx: Executor) => Promise<T>): Promise<T> {
    return withContext(this.db.db, systemContext(householdId), fn);
  }
}
