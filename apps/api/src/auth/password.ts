import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

// OWASP Password Storage Cheat Sheet minimum for argon2id: 19 MiB, 2 passes, 1 lane.
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

async function derive(
  password: string,
  salt: Buffer,
  m: number,
  t: number,
  p: number,
  len: number,
) {
  return argon2Async('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    memory: m,
    passes: t,
    parallelism: p,
    tagLength: len,
  });
}

/** Hashes with argon2id and returns a standard PHC string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { memory: m, passes: t, parallelism: p, tagLength } = PARAMS;
  const tag = await derive(password, salt, m, t, p, tagLength);
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(tag)}`;
}

export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  const match = PHC.exec(phc);
  if (!match) return false;
  const [, m, t, p, salt, hash] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), +m, +t, +p, expected.length);
  return timingSafeEqual(actual, expected);
}

/** True when the hash was made with weaker parameters than today's, so it should be upgraded. */
export function needsRehash(phc: string): boolean {
  const match = PHC.exec(phc);
  if (!match) return true;
  return +match[1]! < PARAMS.memory || +match[2]! < PARAMS.passes;
}

let dummyHash: Promise<string> | undefined;
/** A real hash to verify against when the user doesn't exist, so timing doesn't reveal it. */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
