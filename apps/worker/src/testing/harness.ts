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
  /** Another household, with an owner, a data key and the default categories. */
  household(): Promise<{ householdId: string; memberId: string }>;
  /** Another member of a household. */
  member(householdId: string, name?: string): Promise<string>;
  /** An account, owned by `owners` (equal shares). */
  account(opts: AccountOptions): Promise<string>;
  /** Adds a connection, due a minute ago unless `next` says otherwise (a Postgres interval). */
  connection(opts?: ConnectionOptions): Promise<string>;
  /** The connection's row, as the runner left it. */
  row(id: string): Promise<ConnectionRow>;
  /** Makes the connection due now, as if its next sync time had come. */
  due(id: string): Promise<void>;
  close(): Promise<void>;
}

export interface AccountOptions {
  householdId: string;
  owners: string[];
  name?: string;
  type?: string;
  currency?: string;
  visibility?: 'full' | 'view_only' | 'balance_only' | 'private';
  connectionId?: string | null;
  providerAccountId?: string | null;
  syncFrom?: string | null;
}

export interface ConnectionOptions {
  householdId?: string;
  ownerMemberId?: string;
  provider?: 'plaid' | 'simplefin';
  status?: string;
  /** Relative to now; null = never. */
  next?: string | null;
  lease?: string | null;
  disconnectRequested?: boolean;
  /** Stored encrypted, as the link flow does; null = none. Defaults to the fake's. */
  secret?: string | null;
  /** The Plaid keys it was made with (#82), as the exchange records them. Default null. */
  providerEnv?: string | null;
  providerClientId?: string | null;
  /** The household key set it was made with (#83). Default null: the server's keys. */
  credentialSetId?: string | null;
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
  const worker = createDb(tdb.workerUrl);
  const master = new MasterKeys(MasterKey.fromBase64(randomBytes(32).toString('base64'), 1));
  const keys = new HouseholdKeyStore(worker.db, master);
  const crypto = new FieldCrypto(keys, master);

  const member = async (householdId: string, name = 'A', role = 'member') => {
    const memberId = randomUUID();
    const userId = randomUUID();
    await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
      userId,
      `${userId}@worker.test`,
      name,
    ]);
    await owner.query(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
       VALUES ($1, $2, $3, $4, $5, '#000')`,
      [memberId, householdId, userId, role, name],
    );
    return memberId;
  };
  const household = async () => {
    const householdId = randomUUID();
    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
      [householdId],
    );
    await owner.query('SELECT fiscus_seed_default_categories($1)', [householdId]);
    const memberId = await member(householdId, 'A', 'owner');
    await keys.createForHousehold(householdId);
    return { householdId, memberId };
  };
  const { householdId, memberId } = await household();

  return {
    tdb,
    owner,
    worker,
    crypto,
    householdId,
    memberId,
    household,
    member: (id, name) => member(id, name),
    async account(opts) {
      const id = randomUUID();
      // With its owners in one transaction: an account without any is refused at commit.
      await owner.query('BEGIN');
      await owner.query(
        `INSERT INTO accounts (id, household_id, connection_id, provider_account_id, sync_from, name,
           type, currency, visibility, balance_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'transactions')`,
        [
          id,
          opts.householdId,
          opts.connectionId ?? null,
          opts.providerAccountId ?? null,
          opts.syncFrom ?? null,
          opts.name ?? 'Account',
          opts.type ?? 'depository',
          opts.currency ?? 'USD',
          opts.visibility ?? 'full',
        ],
      );
      const share = Math.floor(10000 / opts.owners.length);
      for (const [i, m] of opts.owners.entries()) {
        await owner.query(
          `INSERT INTO account_owners (account_id, member_id, household_id, share_bps)
           VALUES ($1, $2, $3, $4)`,
          [id, m, opts.householdId, i === 0 ? 10000 - share * (opts.owners.length - 1) : share],
        );
      }
      await owner.query('COMMIT');
      return id;
    },
    async connection(opts = {}) {
      const id = randomUUID();
      const next = opts.next === undefined ? '-1 minute' : opts.next;
      await owner.query(
        `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id,
           status, next_sync_at, lease_until, disconnect_requested, provider_env, provider_client_id,
           credential_set_id)
         VALUES ($1, $2, $3, $4, $5, $6, now() + $7::interval, now() + $8::interval, $9, $10, $11,
           $12)`,
        [
          id,
          opts.householdId ?? householdId,
          opts.ownerMemberId ?? memberId,
          opts.provider ?? 'plaid',
          `item-${id}`,
          opts.status ?? 'ok',
          next,
          opts.lease ?? null,
          opts.disconnectRequested ?? false,
          opts.providerEnv ?? null,
          opts.providerClientId ?? null,
          opts.credentialSetId ?? null,
        ],
      );
      const secret = opts.secret === undefined ? 'fake-secret' : opts.secret;
      if (secret !== null) {
        const hh = opts.householdId ?? householdId;
        await withContext(worker.db, systemContext(hh), (tx) =>
          saveConnectionSecret(tx, crypto, hh, id, secret),
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
