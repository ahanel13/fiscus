// SPDX-License-Identifier: AGPL-3.0-or-later
import { MasterKey } from './master-key.js';

/** A key setting that can't work, found before anything is read or written with it. */
export class KeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyConfigError';
  }
}

/** Data protected by a master key version that isn't loaded: refuse, don't guess (#307). */
export class MasterKeyNotLoadedError extends Error {
  constructor(
    readonly version: number,
    loaded: number[],
  ) {
    super(
      `Master key version ${version} isn't loaded (loaded: ${loaded.join(', ')}). Data it protects ` +
        `can't be read until APP_ENCRYPTION_KEY_PREVIOUS holds that key, with ` +
        `APP_ENCRYPTION_KEY_PREVIOUS_VERSION=${version} (docs/security/encryption.md).`,
    );
    this.name = 'MasterKeyNotLoadedError';
  }
}

/**
 * The master keys an instance holds (ADR 0005 §3, #25): the current one, which wraps new data
 * keys and encrypts, and during a rotation the previous one, which only unwraps and decrypts
 * what it protected until `fiscus-rotate-key` has moved that to the current key.
 */
export class MasterKeys {
  readonly #byVersion = new Map<number, MasterKey>();

  constructor(
    readonly current: MasterKey,
    previous: MasterKey[] = [],
  ) {
    for (const key of [current, ...previous]) {
      if (this.#byVersion.has(key.version)) {
        throw new KeyConfigError(
          `Two master keys have version ${key.version}: give the new key a higher APP_ENCRYPTION_KEY_VERSION.`,
        );
      }
      if ([...this.#byVersion.values()].some((k) => k.sameKeyAs(key))) {
        throw new KeyConfigError(
          'APP_ENCRYPTION_KEY_PREVIOUS is the same key as APP_ENCRYPTION_KEY: rotate to a newly generated key (openssl rand -base64 32).',
        );
      }
      this.#byVersion.set(key.version, key);
    }
  }

  /** The key with this version, or MasterKeyNotLoadedError. */
  version(version: number): MasterKey {
    const key = this.#byVersion.get(version);
    if (!key) throw new MasterKeyNotLoadedError(version, this.versions);
    return key;
  }

  /** Every loaded key, the current one first. */
  get all(): MasterKey[] {
    return [...this.#byVersion.values()];
  }

  get versions(): number[] {
    return [...this.#byVersion.keys()];
  }

  toString(): string {
    return `MasterKeys(current v${this.current.version}, loaded ${this.versions.join(', ')})`;
  }
}

/**
 * Where master keys come from (ADR 0014 §2.2, #307), so a KMS can supply them later without
 * changing the code that uses them. Loading fails closed: a missing or unusable key is a
 * KeyConfigError, and nothing starts.
 */
export interface KeyProvider {
  masterKeys(): Promise<MasterKeys>;
}

export interface EnvKeys {
  APP_ENCRYPTION_KEY: string;
  APP_ENCRYPTION_KEY_VERSION: number;
  APP_ENCRYPTION_KEY_PREVIOUS?: string | undefined;
  APP_ENCRYPTION_KEY_PREVIOUS_VERSION?: number | undefined;
}

/**
 * Keys from the environment, or from files: every variable can be `NAME_FILE` (Docker or Proxmox
 * secrets), read by `loadEnv` before this sees it. The self-hosting backend.
 */
export function envKeyProvider(env: EnvKeys): KeyProvider {
  return {
    masterKeys: async () => {
      const previous = env.APP_ENCRYPTION_KEY_PREVIOUS;
      const previousVersion = env.APP_ENCRYPTION_KEY_PREVIOUS_VERSION;
      if ((previous === undefined) !== (previousVersion === undefined)) {
        throw new KeyConfigError(
          'Set APP_ENCRYPTION_KEY_PREVIOUS and APP_ENCRYPTION_KEY_PREVIOUS_VERSION together, or neither.',
        );
      }
      const load = (value: string, version: number, name: string) => {
        try {
          return MasterKey.fromBase64(value, version);
        } catch {
          throw new KeyConfigError(`${name} must be 32 random bytes, base64-encoded`);
        }
      };
      return new MasterKeys(
        load(env.APP_ENCRYPTION_KEY, env.APP_ENCRYPTION_KEY_VERSION, 'APP_ENCRYPTION_KEY'),
        previous === undefined
          ? []
          : [load(previous, previousVersion!, 'APP_ENCRYPTION_KEY_PREVIOUS')],
      );
    },
  };
}
