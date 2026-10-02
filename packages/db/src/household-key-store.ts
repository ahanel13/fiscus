import {
  type DataKeySource,
  generateDataKey,
  type MasterKey,
  type SecretKey,
} from '@fiscus/crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
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
 * cached briefly in memory. Keys are never logged (SecretKey redacts itself).
 */
export class HouseholdKeyStore implements DataKeySource {
  readonly #cache = new Map<string, CachedKey>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(
    private readonly db: Database,
    private readonly master: MasterKey,
    { ttlMs = 5 * 60_000, maxEntries = 1000, now = Date.now }: HouseholdKeyStoreOptions = {},
  ) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  /** Generates and stores version 1 of a new household's data key. */
  async createForHousehold(householdId: string, tx: Database = this.db): Promise<void> {
    const dek = generateDataKey();
    try {
      await tx.insert(householdKeys).values({
        householdId,
        version: 1,
        wrappedKey: this.master.wrapHouseholdKey(dek, householdId, 1),
        masterKeyVersion: this.master.version,
      });
    } finally {
      dek.destroy();
    }
  }

  async activeKey(householdId: string): Promise<{ version: number; key: SecretKey }> {
    const [row] = await this.db
      .select({ version: householdKeys.version })
      .from(householdKeys)
      .where(and(eq(householdKeys.householdId, householdId), isNull(householdKeys.retiredAt)))
      .orderBy(desc(householdKeys.version))
      .limit(1);
    if (!row) throw new HouseholdKeyNotFoundError(householdId);
    return { version: row.version, key: await this.keyVersion(householdId, row.version) };
  }

  async keyVersion(householdId: string, version: number): Promise<SecretKey> {
    const cacheKey = `${householdId}:${version}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > this.#now()) return cached.key;
    if (cached) this.#evict(cacheKey);

    const [row] = await this.db
      .select({ wrappedKey: householdKeys.wrappedKey })
      .from(householdKeys)
      .where(and(eq(householdKeys.householdId, householdId), eq(householdKeys.version, version)))
      .limit(1);
    if (!row) throw new HouseholdKeyNotFoundError(householdId, version);

    const key = this.master.unwrapHouseholdKey(row.wrappedKey, householdId, version);
    if (this.#cache.size >= this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest) this.#evict(oldest);
    }
    this.#cache.set(cacheKey, { key, expiresAt: this.#now() + this.#ttlMs });
    return key;
  }

  /**
   * Destroys every data key for the household. Its encrypted data, including copies in old
   * backups, becomes permanently unreadable (ADR 0005).
   */
  async cryptoShred(householdId: string): Promise<void> {
    await this.db.delete(householdKeys).where(eq(householdKeys.householdId, householdId));
    for (const cacheKey of [...this.#cache.keys()]) {
      if (cacheKey.startsWith(`${householdId}:`)) this.#evict(cacheKey);
    }
  }

  #evict(cacheKey: string): void {
    this.#cache.get(cacheKey)?.key.destroy();
    this.#cache.delete(cacheKey);
  }
}
