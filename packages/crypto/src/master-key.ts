import { hkdfSync, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { z } from 'zod';
import { decrypt, encrypt } from './aead.js';
import { SecretKey } from './secret-key.js';

const decodeKey = (value: string): Buffer | undefined => {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return undefined;
  const bytes = Buffer.from(trimmed, 'base64');
  return bytes.length === 32 ? bytes : undefined;
};

/** Env spec for APP_ENCRYPTION_KEY (usable with defineEnv). */
export const encryptionKeyEnv = {
  schema: z
    .string()
    .refine((v) => decodeKey(v) !== undefined, 'must be 32 random bytes, base64-encoded'),
  description:
    'Master encryption key: 32 random bytes, base64 (`openssl rand -base64 32`). ' +
    'Back it up separately from database dumps; without it, encrypted data is unrecoverable.',
  secret: true,
};

export const encryptionKeyVersionEnv = {
  schema: z.coerce.number().int().min(1).max(0xffffffff).default(1),
  description: 'Version number of APP_ENCRYPTION_KEY. Increase it when rotating the key.',
  example: '1',
};

/**
 * The instance master key (KEK). It never encrypts data directly: purpose-specific subkeys are
 * derived from it with HKDF, so a weakness in one use can't spill into another.
 */
export class MasterKey {
  readonly #wrapKey: SecretKey;
  readonly #instanceKey: SecretKey;
  readonly #csrfKey: SecretKey;

  private constructor(
    readonly version: number,
    root: Buffer,
  ) {
    const derive = (info: string) =>
      new SecretKey(Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), info, 32)));
    this.#wrapKey = derive('fiscus/household-key-wrap/v1');
    this.#instanceKey = derive('fiscus/instance-secrets/v1');
    this.#csrfKey = derive('fiscus/csrf/v1');
    root.fill(0);
  }

  static fromBase64(value: string, version: number): MasterKey {
    const bytes = decodeKey(value);
    if (!bytes) throw new RangeError('APP_ENCRYPTION_KEY must be 32 random bytes, base64-encoded');
    return new MasterKey(version, bytes);
  }

  /** Encrypts a household data key for storage. Bound to its household and key version. */
  wrapHouseholdKey(dek: SecretKey, householdId: string, dekVersion: number): Buffer {
    return encrypt(this.#wrapKey, this.version, dek.bytes, wrapContext(householdId, dekVersion));
  }

  unwrapHouseholdKey(wrapped: Buffer, householdId: string, dekVersion: number): SecretKey {
    return new SecretKey(decrypt(this.#wrapKey, wrapped, wrapContext(householdId, dekVersion)));
  }

  /** Key for secrets that belong to a user rather than a household (e.g. TOTP seeds). */
  get instanceKey(): SecretKey {
    return this.#instanceKey;
  }

  /** HMAC key for signed CSRF tokens. */
  get csrfKey(): SecretKey {
    return this.#csrfKey;
  }

  toString(): string {
    return `MasterKey(v${this.version}, [redacted])`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export function generateDataKey(): SecretKey {
  return new SecretKey(randomBytes(32));
}

const wrapContext = (householdId: string, dekVersion: number) =>
  Buffer.from(`fiscus:dek:${householdId}:${dekVersion}`, 'utf8');
