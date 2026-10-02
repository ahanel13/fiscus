import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

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
