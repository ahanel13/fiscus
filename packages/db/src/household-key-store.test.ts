// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, randomUUID } from 'node:crypto';
import {
  DecryptionError,
  FieldCrypto,
  MasterKey,
  MasterKeyNotLoadedError,
  MasterKeys,
} from '@fiscus/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import {
  HouseholdKeyNotFoundError,
  HouseholdKeyStore,
  masterKeyUsage,
  rewrapHouseholdKeys,
} from './household-key-store.js';
import { runMaintenanceJob } from './maintenance.js';
import { systemContext, withContext } from './context.js';
import { householdKeys } from './schema/household-keys.js';
import { households } from './schema/households.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

describe('HouseholdKeyStore', () => {
  let tdb: TestDatabase;
  // Creating households and keys outside a request, and crypto-shredding, are worker jobs (system
  // context, #271); the api reads keys as fiscus_app, through fiscus_household_key().
  let handle: DbHandle;
  let app: DbHandle;
  const newKey = (version: number) =>
    MasterKey.fromBase64(randomBytes(32).toString('base64'), version);
  const v1 = newKey(1);
  const master = new MasterKeys(v1);
  const ctx = (householdId: string) => ({
    householdId,
    table: 'transaction_notes',
    column: 'body_enc',
    rowId: randomUUID(),
  });

  // household_keys references households, so each test needs a real household row.
  // Row-level security requires the household's own (system) context to create it.
  const newHousehold = async () => {
    const id = randomUUID();
    await withContext(handle.db, systemContext(id), (tx) =>
      tx.insert(households).values({ id, name: 'Test', baseCurrency: 'USD', timezone: 'UTC' }),
    );
    return id;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    handle = createDb(tdb.workerUrl);
    app = createDb(tdb.appUrl);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await app?.close();
    await tdb?.stop();
  });

  it('creates a wrapped key that the app role can use end to end', async () => {
    const store = new HouseholdKeyStore(handle.db, master);
    const householdId = await newHousehold();
    await store.createForHousehold(householdId);

    const crypto = new FieldCrypto(new HouseholdKeyStore(app.db, master), master);
    const c = ctx(householdId);
    const ct = await crypto.encrypt(c, 'note');
    expect(await crypto.decrypt(c, ct)).toBe('note');

    const rows = await withContext(handle.db, systemContext(householdId), (tx) =>
      tx.select().from(householdKeys),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.masterKeyVersion).toBe(1);
    expect(rows[0]!.wrappedKey.length).toBe(1 + 4 + 12 + 32 + 16);
  });

  it('cannot unwrap with a different master key', async () => {
    const householdId = await newHousehold();
    await new HouseholdKeyStore(handle.db, master).createForHousehold(householdId);
    const otherMaster = new MasterKeys(newKey(1));
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

  // Last: it moves every household key in this database to the new master key.
  it('rotates the master key: reads with either meanwhile, then only the new one (#25)', async () => {
    const before = new HouseholdKeyStore(handle.db, master);
    const householdId = await newHousehold();
    await before.createForHousehold(householdId);
    const c = ctx(householdId);
    const ct = await new FieldCrypto(before, master).encrypt(c, 'kept through rotation');

    // Mid-rotation: v2 is current, v1 still loaded. Existing keys unwrap with v1; new ones use v2.
    const v2 = newKey(2);
    const rotating = new MasterKeys(v2, [v1]);
    const during = new HouseholdKeyStore(handle.db, rotating);
    expect(await new FieldCrypto(during, rotating).decrypt(c, ct)).toBe('kept through rotation');
    const later = await newHousehold();
    await during.createForHousehold(later);

    // A key wrapped with a master key nobody loaded (v9) is reported, not guessed at.
    const lost = await newHousehold();
    await new HouseholdKeyStore(handle.db, new MasterKeys(newKey(9))).createForHousehold(lost);

    const rewrap = () =>
      runMaintenanceJob(tdb.maintenanceUrl, { job: 'master-key-rewrap' }, (db) =>
        rewrapHouseholdKeys(db, rotating),
      );
    const result = await rewrap();
    expect(result.rewrapped).toBeGreaterThanOrEqual(1);
    expect(result.missing).toEqual([{ version: 9, keys: 1 }]);
    const usage = await runMaintenanceJob(tdb.maintenanceUrl, { job: 'master-key-rewrap' }, (db) =>
      masterKeyUsage(db),
    );
    expect([...usage.keys()].sort()).toEqual([2, 9]);
    // Again: nothing left to do but the lost one.
    expect(await rewrap()).toEqual({ rewrapped: 0, missing: [{ version: 9, keys: 1 }] });

    // Afterwards v1 can go: v2 alone reads what v1 wrapped, in a fresh process (empty cache).
    const after = new MasterKeys(v2);
    expect(
      await new FieldCrypto(new HouseholdKeyStore(handle.db, after), after).decrypt(c, ct),
    ).toBe('kept through rotation');
    // Without the key that wrapped it, a household's data stays shut, with a clear reason.
    await expect(new HouseholdKeyStore(handle.db, after).activeKey(lost)).rejects.toThrow(
      MasterKeyNotLoadedError,
    );
  });
});
