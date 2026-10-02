import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. */
export const randomToken = (): string => randomBytes(32).toString('base64url');

export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
