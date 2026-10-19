// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { DecryptionError, decrypt, encrypt, keyVersionOf } from './aead.js';
import { type DataKeySource, FieldCrypto } from './field-crypto.js';
import { encryptionKeyEnv, generateDataKey, MasterKey } from './master-key.js';
import { SecretKey } from './secret-key.js';
import {
  type EnvKeys,
  envKeyProvider,
  KeyConfigError,
  MasterKeyNotLoadedError,
  MasterKeys,
  masterKeysOrExit,
} from './master-keys.js';

const masterB64 = () => randomBytes(32).toString('base64');
const aad = Buffer.from('ctx');

describe('AEAD format', () => {
  const key = generateDataKey();

  it('round-trips and records the key version in the header', () => {
    const ct = encrypt(key, 7, Buffer.from('hello'), aad);
    expect(keyVersionOf(ct)).toBe(7);
    expect(decrypt(key, ct, aad).toString()).toBe('hello');
  });

  it('uses a fresh IV each time', () => {
    const a = encrypt(key, 1, Buffer.from('same'), aad);
    const b = encrypt(key, 1, Buffer.from('same'), aad);
    expect(a.equals(b)).toBe(false);
  });

  it.each([
    ['format byte', 0],
    ['key version', 3],
    ['IV', 8],
    ['ciphertext', 18],
    ['auth tag', -1],
  ])('rejects tampering with the %s', (_, index) => {
    const ct = encrypt(key, 1, Buffer.from('secret data'), aad);
    const i = index < 0 ? ct.length + index : index;
    ct[i] = (ct[i] ?? 0) ^ 0x01;
    expect(() => decrypt(key, ct, aad)).toThrow(DecryptionError);
  });

  it('rejects the wrong key or the wrong associated data', () => {
    const ct = encrypt(key, 1, Buffer.from('x'), aad);
    expect(() => decrypt(generateDataKey(), ct, aad)).toThrow(DecryptionError);
    expect(() => decrypt(key, ct, Buffer.from('other'))).toThrow(DecryptionError);
  });

  it('rejects truncated input', () => {
    expect(() => keyVersionOf(Buffer.alloc(10))).toThrow(DecryptionError);
  });
});

describe('MasterKey', () => {
  it('rejects keys that are not 32 base64 bytes', () => {
    expect(() => MasterKey.fromBase64('', 1)).toThrow(RangeError);
    expect(() => MasterKey.fromBase64('not base64!!', 1)).toThrow(RangeError);
    expect(() => MasterKey.fromBase64(randomBytes(16).toString('base64'), 1)).toThrow(RangeError);
    expect(encryptionKeyEnv.schema.safeParse(randomBytes(31).toString('base64')).success).toBe(
      false,
    );
    expect(encryptionKeyEnv.schema.safeParse(masterB64()).success).toBe(true);
  });

  it('wraps a data key bound to its household and version', () => {
    const master = MasterKey.fromBase64(masterB64(), 1);
    const dek = generateDataKey();
    const wrapped = master.wrapHouseholdKey(dek, 'h1', 1);
    expect(master.unwrapHouseholdKey(wrapped, 'h1', 1).bytes.equals(dek.bytes)).toBe(true);
    expect(() => master.unwrapHouseholdKey(wrapped, 'h2', 1)).toThrow(DecryptionError);
    expect(() => master.unwrapHouseholdKey(wrapped, 'h1', 2)).toThrow(DecryptionError);
  });

  it('derives the same subkeys from the same root, different ones from a different root', () => {
    const root = masterB64();
    const a = MasterKey.fromBase64(root, 1);
    const b = MasterKey.fromBase64(root, 1);
    const c = MasterKey.fromBase64(masterB64(), 1);
    expect(a.instanceKey.bytes.equals(b.instanceKey.bytes)).toBe(true);
    expect(a.instanceKey.bytes.equals(c.instanceKey.bytes)).toBe(false);
  });
});

describe('key material never leaks into logs', () => {
  it('redacts SecretKey and MasterKey in every printable form', () => {
    const key = generateDataKey();
    const hex = key.bytes.toString('hex');
    const master = MasterKey.fromBase64(masterB64(), 3);
    for (const printed of [
      String(key),
      JSON.stringify({ key }),
      inspect(key),
      inspect({ nested: { key } }),
      String(master),
      inspect(master),
    ]) {
      expect(printed).not.toContain(hex);
      expect(printed).toMatch(/redacted/);
    }
  });

  it('wipes key bytes on destroy', () => {
    const key = new SecretKey(randomBytes(32));
    key.destroy();
    expect(key.bytes.every((b) => b === 0)).toBe(true);
  });
});

describe('FieldCrypto', () => {
  const master = new MasterKeys(MasterKey.fromBase64(masterB64(), 1));
  const keys = new Map([
    ['h1', generateDataKey()],
    ['h2', generateDataKey()],
  ]);
  const source: DataKeySource = {
    activeKey: async (h) => ({ version: 1, key: keys.get(h)! }),
    keyVersion: async (h) => keys.get(h)!,
  };
  const crypto = new FieldCrypto(source, master);
  const ctx = { householdId: 'h1', table: 'transaction_notes', column: 'body_enc', rowId: 'r1' };

  it('round-trips household fields', async () => {
    const ct = await crypto.encrypt(ctx, 'Anniversary dinner 🎉');
    expect(await crypto.decrypt(ctx, ct)).toBe('Anniversary dinner 🎉');
  });

  it.each([
    ['another household', { householdId: 'h2' }],
    ['another row', { rowId: 'r2' }],
    ['another column', { column: 'title_enc' }],
    ['another table', { table: 'accounts' }],
  ])('refuses to decrypt a value copied to %s', async (_, change) => {
    const ct = await crypto.encrypt(ctx, 'secret');
    await expect(crypto.decrypt({ ...ctx, ...change }, ct)).rejects.toThrow(DecryptionError);
  });

  it('encrypts instance-level secrets without a household', () => {
    const userCtx = { table: 'users', column: 'totp_secret_enc', rowId: 'u1' };
    const ct = crypto.encryptInstance(userCtx, 'JBSWY3DPEHPK3PXP');
    expect(crypto.decryptInstance(userCtx, ct)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => crypto.decryptInstance({ ...userCtx, rowId: 'u2' }, ct)).toThrow(DecryptionError);
  });
});

describe('master keys and the key provider (#25, #307)', () => {
  const b64 = () => randomBytes(32).toString('base64');
  const load = (env: Partial<EnvKeys>) =>
    envKeyProvider({
      APP_ENCRYPTION_KEY: b64(),
      APP_ENCRYPTION_KEY_VERSION: 1,
      ...env,
    }).masterKeys();

  it('loads the current key, and the previous one during a rotation', async () => {
    expect((await load({})).versions).toEqual([1]);
    const keys = await load({
      APP_ENCRYPTION_KEY_VERSION: 2,
      APP_ENCRYPTION_KEY_PREVIOUS: b64(),
      APP_ENCRYPTION_KEY_PREVIOUS_VERSION: 1,
    });
    expect(keys.current.version).toBe(2);
    expect(keys.versions).toEqual([2, 1]);
    expect(String(keys)).toBe('MasterKeys(current v2, loaded 2, 1)');
  });

  it('fails closed, with a reason and without the key, on settings that can’t work', async () => {
    const same = b64();
    for (const [env, reason] of [
      [{ APP_ENCRYPTION_KEY: 'not a key' }, /APP_ENCRYPTION_KEY must be 32 random bytes/],
      [{ APP_ENCRYPTION_KEY_PREVIOUS: b64() }, /together, or neither/],
      [{ APP_ENCRYPTION_KEY_PREVIOUS_VERSION: 1 }, /together, or neither/],
      [
        { APP_ENCRYPTION_KEY_PREVIOUS: b64(), APP_ENCRYPTION_KEY_PREVIOUS_VERSION: 1 },
        /Two master keys have version 1/,
      ],
      [
        {
          APP_ENCRYPTION_KEY: same,
          APP_ENCRYPTION_KEY_VERSION: 2,
          APP_ENCRYPTION_KEY_PREVIOUS: same,
          APP_ENCRYPTION_KEY_PREVIOUS_VERSION: 1,
        },
        /the same key as APP_ENCRYPTION_KEY/,
      ],
    ] as const) {
      const error = await load(env).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KeyConfigError);
      expect((error as Error).message).toMatch(reason);
      expect((error as Error).message).not.toContain(same);
    }
  });

  it('decrypts instance secrets with the key that encrypted them, and refuses an unloaded one', () => {
    const v1 = MasterKey.fromBase64(b64(), 1);
    const v2 = MasterKey.fromBase64(b64(), 2);
    const none: DataKeySource = {
      activeKey: async () => Promise.reject(new Error('unused')),
      keyVersion: async () => Promise.reject(new Error('unused')),
    };
    const userCtx = { table: 'users', column: 'totp_secret_enc', rowId: 'u1' };
    const old = new FieldCrypto(none, new MasterKeys(v1)).encryptInstance(userCtx, 'seed');

    const rotating = new FieldCrypto(none, new MasterKeys(v2, [v1]));
    expect(rotating.decryptInstance(userCtx, old)).toBe('seed');
    expect(keyVersionOf(rotating.encryptInstance(userCtx, 'seed'))).toBe(2);

    const after = new FieldCrypto(none, new MasterKeys(v2));
    expect(() => after.decryptInstance(userCtx, old)).toThrow(MasterKeyNotLoadedError);
    expect(() => after.decryptInstance(userCtx, old)).toThrow(/version 1 isn't loaded/);
  });
});

describe('masterKeysOrExit: how the api, worker, and rotate-key start (#307)', () => {
  const good = {
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    APP_ENCRYPTION_KEY_VERSION: 1,
  };

  it('returns the keys when they work', async () => {
    const fatal = vi.fn();
    const keys = await masterKeysOrExit(envKeyProvider(good), fatal);
    expect(keys.versions).toEqual([1]);
    expect(fatal).not.toHaveBeenCalled();
  });

  it('logs why and exits when they can’t, before anything else runs', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const fatal = vi.fn();
    try {
      await masterKeysOrExit(
        envKeyProvider({ ...good, APP_ENCRYPTION_KEY_PREVIOUS: good.APP_ENCRYPTION_KEY }),
        fatal,
      );
      expect(fatal).toHaveBeenCalledWith(expect.stringMatching(/together, or neither/));
      expect(fatal.mock.calls[0]![0]).not.toContain(good.APP_ENCRYPTION_KEY);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it('lets other errors through, for the unhandled-error handler', async () => {
    const boom = new Error('provider down');
    await expect(
      masterKeysOrExit({ masterKeys: () => Promise.reject(boom) }, vi.fn()),
    ).rejects.toBe(boom);
  });
});
