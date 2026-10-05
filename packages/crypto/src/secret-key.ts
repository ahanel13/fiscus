// SPDX-License-Identifier: AGPL-3.0-or-later
import { inspect } from 'node:util';

/**
 * Key material that refuses to be printed, logged, or serialized. Use `bytes` only at the
 * point of a cryptographic operation.
 */
export class SecretKey {
  readonly #bytes: Buffer;

  constructor(bytes: Buffer) {
    if (bytes.length !== 32) throw new RangeError(`Keys must be 32 bytes, got ${bytes.length}`);
    this.#bytes = Buffer.from(bytes);
  }

  get bytes(): Buffer {
    return this.#bytes;
  }

  /** Best-effort wipe when a key is evicted from memory. */
  destroy(): void {
    this.#bytes.fill(0);
  }

  toString(): string {
    return 'SecretKey([redacted])';
  }

  toJSON(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return this.toString();
  }
}
