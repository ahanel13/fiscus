import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { DecryptionError, FieldCrypto, MasterKey } from '@fiscus/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { HouseholdKeyNotFoundError, HouseholdKeyStore } from './household-key-store.js';
import { households } from './schema/households.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

describe('HouseholdKeyStore', () => {
  let tdb: TestDatabase;
  let handle: DbHandle;
  const master = MasterKey.fromBase64(randomBytes(32).toString('base64'), 1);
  const ctx = (householdId: string) => ({
    householdId,
    table: 'transaction_notes',
    column: 'body_enc',
    rowId: randomUUID(),
  });

  // household_keys references households, so each test needs a real household row.
  const newHousehold = async () => {
    const [row] = await handle.db
      .insert(households)
      .values({ name: 'Test', baseCurrency: 'USD', timezone: 'UTC' })
      .returning({ id: households.id });
    return row!.id;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    handle = createDb(tdb.appUrl);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await tdb?.stop();
  });

  it('creates a wrapped key that the app role can use end to end', async () => {
    const store = new HouseholdKeyStore(handle.db, master);
    const householdId = await newHousehold();
    await store.createForHousehold(householdId);

    const crypto = new FieldCrypto(store, master);
    const c = ctx(householdId);
    const ct = await crypto.encrypt(c, 'note');
    expect(await crypto.decrypt(c, ct)).toBe('note');

    const { rows } = await handle.pool.query(
      'SELECT wrapped_key, master_key_version FROM household_keys WHERE household_id = $1',
      [householdId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].master_key_version).toBe(1);
    expect((rows[0].wrapped_key as Buffer).length).toBe(1 + 4 + 12 + 32 + 16);
  });

  it('cannot unwrap with a different master key', async () => {
    const householdId = await newHousehold();
    await new HouseholdKeyStore(handle.db, master).createForHousehold(householdId);
    const otherMaster = MasterKey.fromBase64(randomBytes(32).toString('base64'), 1);
    await expect(
      new HouseholdKeyStore(handle.db, otherMaster).activeKey(householdId),
    ).rejects.toThrow(DecryptionError);
  });

  it('crypto-shred makes existing ciphertext permanently unreadable', async () => {
    const store = new HouseholdKeyStore(handle.db, master);
    const householdId = await newHousehold();
    await store.createForHousehold(householdId);
    const crypto = new FieldCrypto(store, master);
    const c = ctx(householdId);
    const ct = await crypto.encrypt(c, 'gone soon');

    await store.cryptoShred(householdId);

    await expect(crypto.decrypt(c, ct)).rejects.toThrow(HouseholdKeyNotFoundError);
    // A fresh process (empty cache) can't read it either.
    await expect(
      new FieldCrypto(new HouseholdKeyStore(handle.db, master), master).decrypt(c, ct),
    ).rejects.toThrow(HouseholdKeyNotFoundError);
  });

  it('serves cached keys until the TTL expires', async () => {
    let now = 0;
    const store = new HouseholdKeyStore(handle.db, master, { ttlMs: 1000, now: () => now });
    const householdId = await newHousehold();
    await store.createForHousehold(householdId);
    const first = await store.keyVersion(householdId, 1);
    expect(await store.keyVersion(householdId, 1)).toBe(first);
    now = 1001;
    const refreshed = await store.keyVersion(householdId, 1);
    expect(refreshed).not.toBe(first);
    expect(first.bytes.every((b) => b === 0)).toBe(true); // evicted key was wiped
  });

  it('reports a missing household key clearly', async () => {
    await expect(new HouseholdKeyStore(handle.db, master).activeKey(randomUUID())).rejects.toThrow(
      HouseholdKeyNotFoundError,
    );
  });
});
