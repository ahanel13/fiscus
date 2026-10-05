// SPDX-License-Identifier: AGPL-3.0-or-later
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. */
export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  max?: number;
  /** Called when an idle connection fails (e.g. the database restarts). */
  onIdleError?: (err: Error) => void;
}

export function createDb(
  url: string,
  {
    max = 10,
    onIdleError = (err) => console.warn(`[db] idle connection error: ${err.message}`),
  }: CreateDbOptions = {},
): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max });
  // Without a listener, an idle client dropped by the server (restart, failover, admin
  // termination) emits an unhandled 'error' and crashes the process. The pool discards that
  // client and reconnects on the next query.
  pool.on('error', onIdleError);
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}
