// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HistoryIntegrityReport, HistoryPoint } from '@fiscus/shared';
import { ApiError } from '../api/client.js';

// The browser's history witness (ADR 0013 §4, #264). This device remembers the last head of the
// household's activity chain it verified, and on each visit checks for itself that the server's
// chain extends it: it folds the proof's leaves from its stored hash, SHA-256(previous ‖ leaf)
// each, and must reach the server's head. `/verify` is the server's own word, so it's asked too,
// but it's never enough on its own.

/** What this device last verified, as stored under `fiscus.historyWitness.<householdId>`. */
export interface Witness {
  v: 1;
  seq: number;
  hash: string;
  verifiedAt: string;
}

export type FailureReason = HistoryIntegrityReport['reason'];

/** A failed check, kept on this device until a member accepts the current history. */
export interface Failure {
  reason: FailureReason;
  /** The witness at the time: the last verified point. */
  lastVerified: Witness;
  /** What the server showed instead, as far as it got. */
  observed: { seq?: number; hash?: string };
  failedAt: string;
  /** The report reached the server (once per device per stored head). */
  reported?: boolean;
}

/** A member accepted the current history as the new baseline, after a failure. */
export interface Rebaseline {
  failure: Failure;
  acceptedAt: string;
  baseline: HistoryPoint;
}

export type Outcome =
  /** No witness yet: the current head is trusted (trust on first use). */
  | { state: 'first'; witness: Witness }
  /** The chain extends the witness. `grew` entries were added since (0: unchanged). */
  | { state: 'verified'; witness: Witness; grew: number }
  | { state: 'failed'; failure: Failure }
  /** Network trouble, a 5xx, or an unexpected answer: tried again on the next load. */
  | { state: 'unreachable'; witness: Witness | null }
  /** This browser can't check: no SubtleCrypto (not a secure context), or no storage. */
  | { state: 'unavailable'; why: 'insecure' | 'storage' };

/** The api calls a check makes; each resolves to the response body, or throws (ApiError). */
export interface WitnessApi {
  proof(from?: HistoryPoint): Promise<unknown>;
  verify(): Promise<unknown>;
  report(body: HistoryIntegrityReport): Promise<unknown>;
}

const HEX_HASH = /^[0-9a-f]{64}$/;

function bytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The hash a chain reaches from `hashHex` after the given leaves, all 32-byte lowercase hex: the
 * same as `foldLeaves` in `@fiscus/db`, held to it by the same test vectors.
 */
export async function fold(
  hashHex: string,
  leavesHex: readonly string[],
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  if (!HEX_HASH.test(hashHex)) throw new Error('fold: the starting hash is not 32-byte hex');
  let hash = bytes(hashHex);
  const input = new Uint8Array(64);
  for (const leaf of leavesHex) {
    if (!HEX_HASH.test(leaf)) throw new Error('fold: a leaf is not 32-byte hex');
    input.set(hash, 0);
    input.set(bytes(leaf), 32);
    hash = new Uint8Array(await subtle.digest('SHA-256', input));
  }
  return hex(hash.buffer);
}

/** A head's short fingerprint, for comparing across devices: "8878 b15a". */
export function fingerprint(hash: string): string {
  return `${hash.slice(0, 4)} ${hash.slice(4, 8)}`;
}

const isSeq = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isHash = (v: unknown): v is string => typeof v === 'string' && HEX_HASH.test(v);

interface ProofPage {
  head: HistoryPoint;
  leaves: string[];
  next?: number;
}

/** The `{ data: ActivityProof }` body, checked field by field; null when malformed. */
function parseProof(body: unknown): ProofPage | null {
  const data = (body as { data?: unknown } | null)?.data as Record<string, unknown> | undefined;
  if (typeof data !== 'object' || data === null) return null;
  const head = data.head as Record<string, unknown> | undefined;
  if (typeof head !== 'object' || head === null || !isSeq(head.seq) || !isHash(head.hash)) {
    return null;
  }
  if (!Array.isArray(data.leaves) || !data.leaves.every(isHash)) return null;
  if (data.next !== undefined && !isSeq(data.next)) return null;
  return {
    head: { seq: head.seq, hash: head.hash },
    leaves: data.leaves as string[],
    ...(data.next !== undefined ? { next: data.next } : {}),
  };
}

/** A failure the server answered with (409), or null for "couldn't check". */
function refusal(e: unknown): FailureReason | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  return e.code === 'proof_unavailable' ? 'proof_unavailable' : 'history_diverged';
}

/** The proof's pages after this many: more than any real household, so a server can't loop us. */
const MAX_PAGES = 10_000;

/**
 * Checks the household's history against this device's witness, without touching storage: the
 * caller stores what comes back (runHistoryCheck). Without a witness, the current head is trusted.
 * With one, the proof is folded page by page from its hash, and the new head is accepted only if
 * the fold reaches it, its seq didn't go down, and `/verify` is ok. A 409, a malformed answer, a
 * lower seq, or a mismatch is a failure; network trouble or a 5xx is "couldn't check".
 */
export async function checkWitness(
  stored: Witness | null,
  api: WitnessApi,
  { subtle = globalThis.crypto?.subtle, now = () => new Date() } = {},
): Promise<Outcome> {
  if (!subtle) return { state: 'unavailable', why: 'insecure' };
  const witness = (point: HistoryPoint): Witness => ({
    v: 1,
    seq: point.seq,
    hash: point.hash,
    verifiedAt: now().toISOString(),
  });

  if (!stored) {
    try {
      const page = parseProof(await api.proof());
      if (!page) return { state: 'unreachable', witness: null };
      return { state: 'first', witness: witness(page.head) };
    } catch {
      return { state: 'unreachable', witness: null };
    }
  }

  const failed = (reason: FailureReason, observed: Failure['observed'] = {}): Outcome => ({
    state: 'failed',
    failure: { reason, lastVerified: stored, observed, failedAt: now().toISOString() },
  });

  let at: HistoryPoint = { seq: stored.seq, hash: stored.hash };
  let head: HistoryPoint | undefined;
  for (let pages = 0; !head; pages++) {
    if (pages >= MAX_PAGES) return failed('malformed_proof');
    let body: unknown;
    try {
      body = await api.proof(at);
    } catch (e) {
      const reason = refusal(e);
      return reason ? failed(reason) : { state: 'unreachable', witness: stored };
    }
    const page = parseProof(body);
    if (!page) return failed('malformed_proof');
    const observed = { seq: page.head.seq, hash: page.head.hash };
    if (page.head.seq < stored.seq) return failed('seq_regressed', observed);
    // Positions are contiguous: a page covers exactly as many entries as it has leaves.
    const reached = at.seq + page.leaves.length;
    if (page.next !== undefined) {
      if (page.leaves.length === 0 || page.next !== reached || page.next >= page.head.seq) {
        return failed('malformed_proof', observed);
      }
    } else if (reached !== page.head.seq) {
      return failed('malformed_proof', observed);
    }
    at = { seq: reached, hash: await fold(at.hash, page.leaves, subtle) };
    if (page.next === undefined) {
      if (at.hash !== page.head.hash) return failed('fold_mismatch', observed);
      head = page.head;
    }
  }

  let verification: unknown;
  try {
    verification = await api.verify();
  } catch {
    return { state: 'unreachable', witness: stored };
  }
  const ok = ((verification as { data?: { ok?: unknown } } | null)?.data ?? {}).ok;
  if (typeof ok !== 'boolean') return failed('malformed_proof', head);
  if (!ok) return failed('verify_failed', head);
  return { state: 'verified', witness: witness(head), grew: head.seq - stored.seq };
}

/** Where this device keeps a household's witness. Kept after sign-out. */
export const witnessKey = (householdId: string) => `fiscus.historyWitness.${householdId}`;
const failureKey = (householdId: string) => `${witnessKey(householdId)}.failure`;
const rebaselinesKey = (householdId: string) => `${witnessKey(householdId)}.rebaselines`;

/** localStorage, or null when it can't be written (private browsing, blocked site data). */
function storage(): Storage | null {
  try {
    const probe = 'fiscus.historyWitness.probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing more to do: the next visit checks from the last point that was stored.
  }
}

/** The stored witness, or null when there's none or it isn't one. */
export function storedWitness(householdId: string): Witness | null {
  const w = read<Record<string, unknown>>(witnessKey(householdId));
  if (!w || w.v !== 1 || !isSeq(w.seq) || !isHash(w.hash) || typeof w.verifiedAt !== 'string') {
    return null;
  }
  return { v: 1, seq: w.seq, hash: w.hash, verifiedAt: w.verifiedAt };
}

export function storedFailure(householdId: string): Failure | null {
  const f = read<Failure>(failureKey(householdId));
  return f && typeof f.reason === 'string' && f.lastVerified ? f : null;
}

/** Past failures that a member accepted on this device, newest last. */
export function storedRebaselines(householdId: string): Rebaseline[] {
  const list = read<Rebaseline[]>(rebaselinesKey(householdId));
  return Array.isArray(list) ? list : [];
}

/** Reports a failure, once per stored head: true once the server has it, or refused it for good. */
async function report(api: WitnessApi, failure: Failure): Promise<boolean> {
  try {
    await api.report({
      lastVerified: { seq: failure.lastVerified.seq, hash: failure.lastVerified.hash },
      observed: failure.observed,
      reason: failure.reason,
    });
    return true;
  } catch (e) {
    // A 4xx other than the rate limit won't change by asking again. Anything else: next load.
    return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
  }
}

/**
 * One check of a household on this device: storage in, the outcome out, and the witness moved
 * forward only on success. A failure is kept, with the old witness, until a member accepts the
 * current history (acceptCurrentHistory); it's reported once, and the warning never waits for it.
 */
export async function runHistoryCheck(
  householdId: string,
  api: WitnessApi,
  options: Parameters<typeof checkWitness>[2] = {},
): Promise<Outcome> {
  if (!(options.subtle ?? globalThis.crypto?.subtle)) {
    return { state: 'unavailable', why: 'insecure' };
  }
  if (!storage()) return { state: 'unavailable', why: 'storage' };

  let failure = storedFailure(householdId);
  if (!failure) {
    const outcome = await checkWitness(storedWitness(householdId), api, options);
    if (outcome.state === 'first' || outcome.state === 'verified') {
      // Another tab may have failed meanwhile: its failure wins.
      if (!storedFailure(householdId)) write(witnessKey(householdId), outcome.witness);
      return outcome;
    }
    if (outcome.state !== 'failed') return outcome;
    failure = outcome.failure;
    write(failureKey(householdId), failure);
  }
  if (!failure.reported && (await report(api, failure))) {
    failure = { ...failure, reported: true };
    write(failureKey(householdId), failure);
  }
  return { state: 'failed', failure };
}

/**
 * "Accept current history as the new baseline": a member's explicit choice after a failure. The
 * witness moves to the server's current head, and the failure is kept on this device, with when
 * it was accepted. The server records nothing of it (it has no endpoint for that yet).
 */
export async function acceptCurrentHistory(
  householdId: string,
  api: WitnessApi,
  now: () => Date = () => new Date(),
): Promise<Witness> {
  const page = parseProof(await api.proof());
  if (!page) throw new Error('The server’s answer wasn’t a history point');
  const witness: Witness = {
    v: 1,
    seq: page.head.seq,
    hash: page.head.hash,
    verifiedAt: now().toISOString(),
  };
  const failure = storedFailure(householdId);
  if (failure) {
    const rebaselines = [
      ...storedRebaselines(householdId),
      { failure, acceptedAt: witness.verifiedAt, baseline: page.head },
    ].slice(-10);
    write(rebaselinesKey(householdId), rebaselines);
  }
  write(witnessKey(householdId), witness);
  try {
    localStorage.removeItem(failureKey(householdId));
  } catch {
    // Storage went away: the failure stays, and so does the warning.
  }
  return witness;
}
