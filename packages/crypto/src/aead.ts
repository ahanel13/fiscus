// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretKey } from './secret-key.js';

// Ciphertext layout (all integers big-endian):
//   [0]      format version (FORMAT_V1)
//   [1..4]   key version that encrypted it (uint32)
//   [5..16]  96-bit random IV
//   [17..n]  AES-256-GCM ciphertext
//   [n..+16] GCM auth tag
const FORMAT_V1 = 0x01;
const HEADER_LENGTH = 5;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class DecryptionError extends Error {
  constructor(message = 'Decryption failed: wrong key, wrong context, or tampered data') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function encrypt(
  key: SecretKey,
  keyVersion: number,
  plaintext: Buffer,
  associatedData: Buffer,
): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt8(FORMAT_V1, 0);
  header.writeUInt32BE(keyVersion, 1);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  // The header is authenticated too, so the key version can't be swapped.
  cipher.setAAD(Buffer.concat([header, associatedData]));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, iv, body, cipher.getAuthTag()]);
}

/** Reads the key version from a ciphertext header without decrypting it. */
export function keyVersionOf(ciphertext: Buffer): number {
  if (ciphertext.length < HEADER_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new DecryptionError('Ciphertext is truncated');
  }
  if (ciphertext.readUInt8(0) !== FORMAT_V1) {
    throw new DecryptionError(`Unsupported ciphertext format ${ciphertext.readUInt8(0)}`);
  }
  return ciphertext.readUInt32BE(1);
}

export function decrypt(key: SecretKey, ciphertext: Buffer, associatedData: Buffer): Buffer {
  keyVersionOf(ciphertext);
  const header = ciphertext.subarray(0, HEADER_LENGTH);
  const iv = ciphertext.subarray(HEADER_LENGTH, HEADER_LENGTH + IV_LENGTH);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
  const body = ciphertext.subarray(HEADER_LENGTH + IV_LENGTH, ciphertext.length - TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv);
    decipher.setAAD(Buffer.concat([header, associatedData]));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}
