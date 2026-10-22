// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, randomUUID } from 'node:crypto';
import { FieldCrypto, MasterKey, MasterKeys } from '@fiscus/crypto';
import {
  createDb,
  type DbHandle,
  HouseholdKeyStore,
  saveConnectionSecret,
  systemContext,
  withContext,
} from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import pg from 'pg';

/** One household with an owner and a data key, and the worker's view of the database. */
export interface WorkerHarness {
  tdb: TestDatabase;
  /** The schema owner, for arranging rows and reading them back. */
  owner: pg.Client;
  /** Logged in as fiscus_worker, as the runner is. */
  worker: DbHandle;
  crypto: FieldCrypto;
  householdId: string;
  memberId: string;
  /** Adds a connection, due a minute ago unless `next` says otherwise (a Postgres interval). */
  connection(opts?: ConnectionOptions): Promise<string>;
  /** The connection's row, as the runner left it. */
  row(id: string): Promise<ConnectionRow>;
  /** Makes the connection due now, as if its next sync time had come. */
  due(id: string): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectionOptions {
  provider?: 'plaid' | 'simplefin';
  status?: string;
  /** Relative to now; null = never. */
  next?: string | null;
  lease?: string | null;
  disconnectRequested?: boolean;
  /** Stored encrypted, as the link flow does; null = none. Defaults to the fake's. */
  secret?: string | null;
}

export interface ConnectionRow {
  status: string;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  firstFailedAt: Date | null;
  lastSyncedAt: Date | null;
  leased: boolean;
  disconnectRequested: boolean;
  /** Minutes from now, rounded; null when never due. */
  nextInMinutes: number | null;
  hasSecret: boolean;
}

export async function startWorkerHarness(): Promise<WorkerHarness> {
  const tdb = await startTestDatabase();
  const owner = new pg.Client({ connectionString: tdb.ownerUrl });
  await owner.connect();
  const householdId = randomUUID();
  const memberId = randomUUID();
  const userId = randomUUID();
  await owner.query(
    `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
    [householdId],
  );
  await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'A')`, [
    userId,
    `${userId}@worker.test`,
  ]);
  await owner.query(
    `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
     VALUES ($1, $2, $3, 'owner', 'A', '#000')`,
    [memberId, householdId, userId],
  );
  const worker = createDb(tdb.workerUrl);
  const master = new MasterKeys(MasterKey.fromBase64(randomBytes(32).toString('base64'), 1));
  const keys = new HouseholdKeyStore(worker.db, master);
  await keys.createForHousehold(householdId);
  const crypto = new FieldCrypto(keys, master);

  return {
    tdb,
    owner,
    worker,
    crypto,
    householdId,
    memberId,
    async connection(opts = {}) {
      const id = randomUUID();
      const next = opts.next === undefined ? '-1 minute' : opts.next;
      await owner.query(
        `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id,
           status, next_sync_at, lease_until, disconnect_requested)
         VALUES ($1, $2, $3, $4, $5, $6, now() + $7::interval, now() + $8::interval, $9)`,
        [
          id,
          householdId,
          memberId,
          opts.provider ?? 'plaid',
          `item-${id}`,
          opts.status ?? 'ok',
          next,
          opts.lease ?? null,
          opts.disconnectRequested ?? false,
        ],
      );
      const secret = opts.secret === undefined ? 'fake-secret' : opts.secret;
      if (secret !== null) {
        await withContext(worker.db, systemContext(householdId), (tx) =>
          saveConnectionSecret(tx, crypto, householdId, id, secret),
        );
      }
      return id;
    },
    async row(id) {
      const { rows } = await owner.query(
        `SELECT c.status, c.last_error_code, c.consecutive_failures, c.first_failed_at,
                c.last_synced_at, c.lease_until IS NOT NULL AS leased, c.disconnect_requested,
                round(extract(epoch FROM c.next_sync_at - now()) / 60)::int AS next_in_minutes,
                EXISTS (SELECT 1 FROM connection_secrets s WHERE s.connection_id = c.id) AS has_secret
         FROM connections c WHERE c.id = $1`,
        [id],
      );
      const r = rows[0];
      return {
        status: r.status,
        lastErrorCode: r.last_error_code,
        consecutiveFailures: r.consecutive_failures,
        firstFailedAt: r.first_failed_at,
        lastSyncedAt: r.last_synced_at,
        leased: r.leased,
        disconnectRequested: r.disconnect_requested,
        nextInMinutes: r.next_in_minutes,
        hasSecret: r.has_secret,
      };
    },
    async due(id) {
      await owner.query(
        `UPDATE connections SET next_sync_at = now() - interval '1 second' WHERE id = $1`,
        [id],
      );
    },
    async close() {
      await worker.close();
      await owner.end();
      await tdb.stop();
    },
  };
}

/** Waits until `check` holds, polling. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
