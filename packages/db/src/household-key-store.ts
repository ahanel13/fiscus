// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DataKeySource,
  generateDataKey,
  type MasterKeys,
  MasterKeyNotLoadedError,
  type SecretKey,
} from '@fiscus/crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Database, Executor } from './client.js';
import { systemContext, withContext } from './context.js';
import { householdKeys } from './schema/household-keys.js';

export class HouseholdKeyNotFoundError extends Error {
  constructor(householdId: string, version?: number) {
    super(
      `No data key for household ${householdId}${version ? ` version ${version}` : ''} ` +
        '(never created, or crypto-shredded)',
    );
    this.name = 'HouseholdKeyNotFoundError';
  }
}

interface CachedKey {
  key: SecretKey;
  expiresAt: number;
}

export interface HouseholdKeyStoreOptions {
  /** How long unwrapped keys stay in memory. */
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Household data keys backed by the household_keys table, unwrapped with the master key and
 * cached briefly in memory. Keys are never logged (SecretKey redacts itself). Reads go through
 * fiscus_household_key() (migration 0028), since the api has no system context (#271): the rows
 * are wrapped with the master key, which is never in the database.
 */
export class HouseholdKeyStore implements DataKeySource {
  readonly #cache = new Map<string, CachedKey>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(
    private readonly db: Database,
    private readonly master: MasterKeys,
    { ttlMs = 5 * 60_000, maxEntries = 1000, now = Date.now }: HouseholdKeyStoreOptions = {},
  ) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  /**
   * Generates and stores version 1 of a new household's data key. Pass the caller's transaction,
   * in the household's context as its owner; without one it uses system context, which only the
   * worker has.
   */
  async createForHousehold(householdId: string, tx?: Executor): Promise<void> {
    const dek = generateDataKey();
    const insert = (exec: Executor) =>
      exec.insert(householdKeys).values({
        householdId,
        version: 1,
        wrappedKey: this.master.current.wrapHouseholdKey(dek, householdId, 1),
        masterKeyVersion: this.master.current.version,
      });
    try {
      if (tx) await insert(tx);
      else await withContext(this.db, systemContext(householdId), insert);
    } finally {
      dek.destroy();
    }
  }

  async activeKey(householdId: string): Promise<{ version: number; key: SecretKey }> {
    const row = await this.#read(householdId, null);
    if (!row) throw new HouseholdKeyNotFoundError(householdId);
    return { version: row.version, key: await this.keyVersion(householdId, row.version) };
  }

  async keyVersion(householdId: string, version: number): Promise<SecretKey> {
    const cacheKey = `${householdId}:${version}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > this.#now()) return cached.key;
    if (cached) this.#evict(cacheKey);

    const row = await this.#read(householdId, version);
    if (!row) throw new HouseholdKeyNotFoundError(householdId, version);

    // With whichever master key wrapped it: the previous one, until a rotation has re-wrapped it.
    const key = this.master
      .version(row.masterKeyVersion)
      .unwrapHouseholdKey(row.wrappedKey, householdId, version);
    if (this.#cache.size >= this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest) this.#evict(oldest);
    }
    this.#cache.set(cacheKey, { key, expiresAt: this.#now() + this.#ttlMs });
    return key;
  }

  /** The active version (null) or a given one. */
  async #read(
    householdId: string,
    version: number | null,
  ): Promise<{ version: number; wrappedKey: Buffer; masterKeyVersion: number } | undefined> {
    const { rows } = await this.db.execute<{
      version: number;
      wrapped_key: Buffer;
      master_key_version: number;
    }>(sql`SELECT * FROM fiscus_household_key(${householdId}, ${version}::integer)`);
    const row = rows[0];
    return row
      ? {
          version: row.version,
          wrappedKey: row.wrapped_key,
          masterKeyVersion: row.master_key_version,
        }
      : undefined;
  }

  /**
   * Destroys every data key for the household. A worker job (system context). Its encrypted data, including copies in old
   * backups, becomes permanently unreadable (ADR 0005).
   */
  async cryptoShred(householdId: string): Promise<void> {
    await withContext(this.db, systemContext(householdId), (tx) =>
      tx.delete(householdKeys).where(eq(householdKeys.householdId, householdId)),
    );
    for (const cacheKey of [...this.#cache.keys()]) {
      if (cacheKey.startsWith(`${householdId}:`)) this.#evict(cacheKey);
    }
  }

  #evict(cacheKey: string): void {
    this.#cache.get(cacheKey)?.key.destroy();
    this.#cache.delete(cacheKey);
  }
}

/** How many household data keys each master key version wraps. */
export async function masterKeyUsage(db: Database): Promise<Map<number, number>> {
  const rows = await db
    .select({ version: householdKeys.masterKeyVersion, n: sql<number>`count(*)::int` })
    .from(householdKeys)
    .groupBy(householdKeys.masterKeyVersion);
  return new Map(rows.map((r) => [r.version, r.n]));
}

export interface RewrapResult {
  rewrapped: number;
  /** Wrapped with a master key that isn't loaded: left as they are. */
  missing: { version: number; keys: number }[];
}

/**
 * Key rotation (#25): every household data key wrapped with an older master key is unwrapped
 * with it and wrapped again with the current one. The data keys themselves don't change, so no
 * encrypted field is touched. Each row is updated only if no one changed it meanwhile, so it's
 * safe to run while Fiscus is up, and again. Runs as a maintenance job (`master-key-rewrap`),
 * since it reaches every household.
 */
export async function rewrapHouseholdKeys(db: Database, keys: MasterKeys): Promise<RewrapResult> {
  const current = keys.current;
  const stale = await db
    .select({
      householdId: householdKeys.householdId,
      version: householdKeys.version,
      masterKeyVersion: householdKeys.masterKeyVersion,
      wrappedKey: householdKeys.wrappedKey,
    })
    .from(householdKeys)
    .where(ne(householdKeys.masterKeyVersion, current.version));
  let rewrapped = 0;
  const missing = new Map<number, number>();
  for (const row of stale) {
    let master;
    try {
      master = keys.version(row.masterKeyVersion);
    } catch (err) {
      if (!(err instanceof MasterKeyNotLoadedError)) throw err;
      missing.set(row.masterKeyVersion, (missing.get(row.masterKeyVersion) ?? 0) + 1);
      continue;
    }
    const dek = master.unwrapHouseholdKey(row.wrappedKey, row.householdId, row.version);
    try {
      const updated = await db
        .update(householdKeys)
        .set({
          wrappedKey: current.wrapHouseholdKey(dek, row.householdId, row.version),
          masterKeyVersion: current.version,
        })
        .where(
          and(
            eq(householdKeys.householdId, row.householdId),
            eq(householdKeys.version, row.version),
            eq(householdKeys.masterKeyVersion, row.masterKeyVersion),
          ),
        )
        .returning({ version: householdKeys.version });
      rewrapped += updated.length;
    } finally {
      dek.destroy();
    }
  }
  return {
    rewrapped,
    missing: [...missing].map(([version, n]) => ({ version, keys: n })),
  };
}
