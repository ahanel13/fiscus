// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Executor } from './client.js';
import { auditChainHeads, auditEvents } from './schema/identity.js';

// Tamper-evident activity history (ADR 0013 §4). Each scope (a household, or the instance) is a
// hash chain. Changing, inserting, reordering, or deleting any past entry breaks every later hash.
// - Version 1: entry_hash(n) = SHA-256(entry_hash(n-1) ‖ canonical(entry n)).
// - Version 2 (#264): entry_hash(n) = SHA-256(entry_hash(n-1) ‖ leaf(n)), leaf(n) =
//   SHA-256(canonical(entry n)). Given the leaves, anyone can check that one head extends another
//   without seeing the entries (foldLeaves), which is what a member's browser does.
// New entries are version 2. Older ones stay version 1: rehashing them would rewrite history.

export const INSTANCE_SCOPE = '00000000-0000-0000-0000-000000000000';
const GENESIS = Buffer.alloc(32);
/** The chain's starting point, as hex: what entry 0's hash would be. */
export const GENESIS_HASH = GENESIS.toString('hex');
export const HASH_VERSION = 2;

type ActorKind = (typeof auditEvents.$inferInsert)['actorKind'];

export interface ActivityEntry {
  actorKind: ActorKind;
  actorUserId?: string | null;
  actorMemberId?: string | null;
  /** Null for instance-level events. */
  householdId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** The account the event concerns: only members who can see it see the event (RLS). */
  accountId?: string | null;
  visibleToHousehold?: boolean;
  /** IDs and field names only, never financial plaintext. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Deterministic JSON: object keys sorted at every level, Dates as ISO, Buffers as base64. */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString('base64'));
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface HashedFields {
  scopeId: string;
  seq: number;
  occurredAt: Date;
  actorKind: ActorKind;
  actorUserId: string | null;
  actorMemberId: string | null;
  householdId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** Hashed only when set (undefined is skipped), so chains recorded before it still verify. */
  accountId?: string;
  visibleToHousehold: boolean;
  metadata: Record<string, unknown>;
  ip: string | null;
  changesEnc: Buffer | null;
}

/** Version 1: the link hashes the previous hash and the canonical entry together. */
export function entryHash(previous: Buffer, fields: HashedFields): Buffer {
  return createHash('sha256').update(previous).update(canonical(fields)).digest();
}

/** Version 2's leaf: the canonical entry, version included, hashed on its own. */
export function leafHash(fields: HashedFields): Buffer {
  return createHash('sha256')
    .update(canonical({ ...fields, hashVersion: 2 }))
    .digest();
}

/** Version 2's link: SHA-256(previous hash ‖ leaf), 64 bytes in. */
export function linkHash(previous: Buffer, leaf: Buffer): Buffer {
  return createHash('sha256').update(previous).update(leaf).digest();
}

const HEX_HASH = /^[0-9a-f]{64}$/;

/**
 * The hash a chain reaches from `fromHex` after the given version 2 leaves, all lowercase hex.
 * This is the whole of checking a proof (GET …/activity/proof): the browser does the same with
 * crypto.subtle (#264), and the test vectors in activity.test.ts hold both to it.
 */
export function foldLeaves(fromHex: string, leavesHex: readonly string[]): string {
  if (!HEX_HASH.test(fromHex)) throw new Error('foldLeaves: the starting hash is not 32-byte hex');
  let hash: Buffer = Buffer.from(fromHex, 'hex');
  for (const leaf of leavesHex) {
    if (!HEX_HASH.test(leaf)) throw new Error('foldLeaves: a leaf is not 32-byte hex');
    hash = linkHash(hash, Buffer.from(leaf, 'hex'));
  }
  return hash.toString('hex');
}

/**
 * Appends an event to its scope's chain inside the caller's transaction. The head row is locked,
 * so concurrent appends serialize and the chain never forks. `encryptChanges` receives the row's
 * stable id (`scope:seq`) to bind the ciphertext to this exact entry.
 */
export async function appendActivity(
  tx: Executor,
  entry: ActivityEntry,
  encryptChanges?: (rowId: string) => Promise<Buffer>,
): Promise<{ seq: number; hash: Buffer }> {
  const scopeId = entry.householdId ?? INSTANCE_SCOPE;
  await tx
    .insert(auditChainHeads)
    .values({ scopeId, seq: 0, headHash: GENESIS })
    .onConflictDoNothing({ target: auditChainHeads.scopeId });
  const [head] = await tx
    .select()
    .from(auditChainHeads)
    .where(eq(auditChainHeads.scopeId, scopeId))
    .for('update');
  if (!head) throw new Error(`Activity chain head for ${scopeId} is not visible in this context`);

  const seq = head.seq + 1;
  // Store and hash exactly what Postgres will return later: normalized inet text, ms timestamps.
  const ip = entry.ip
    ? ((await tx.execute<{ ip: string }>(sql`SELECT ${entry.ip}::inet::text AS ip`)).rows[0]?.ip ??
      null)
    : null;
  const fields: HashedFields = {
    scopeId,
    seq,
    occurredAt: new Date(),
    actorKind: entry.actorKind,
    actorUserId: entry.actorUserId ?? null,
    actorMemberId: entry.actorMemberId ?? null,
    householdId: entry.householdId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    ...(entry.accountId ? { accountId: entry.accountId } : {}),
    visibleToHousehold: entry.visibleToHousehold ?? false,
    metadata: entry.metadata ?? {},
    ip,
    changesEnc: encryptChanges ? await encryptChanges(`${scopeId}:${seq}`) : null,
  };
  const leaf = leafHash(fields);
  const hash = linkHash(head.headHash, leaf);
  const { scopeId: _scope, ...columns } = fields;
  await tx
    .insert(auditEvents)
    .values({ ...columns, entryHash: hash, hashVersion: HASH_VERSION, leaf });
  await tx
    .update(auditChainHeads)
    .set({ seq, headHash: hash, updatedAt: new Date() })
    .where(eq(auditChainHeads.scopeId, scopeId));
  return { seq, hash };
}

export interface ChainVerification {
  ok: boolean;
  scopeId: string;
  /** Last verified position and its hash. */
  seq: number;
  headHash: string;
  /** First entry that doesn't match, when not ok. */
  brokenAt?: number;
  reason?: 'hash_mismatch' | 'gap' | 'head_mismatch';
}

/**
 * Recomputes a chain from genesis and compares every entry and the stored head. Run it in system
 * context (the worker, or a maintenance job): a member can't see events about accounts hidden from
 * them, which would look like gaps. For a member, use verifyHouseholdChain.
 */
export async function verifyChain(tx: Executor, scopeId: string): Promise<ChainVerification> {
  const rows = await tx
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.scopeId, scopeId), isNotNull(auditEvents.seq)))
    .orderBy(asc(auditEvents.seq));
  return checkChain(tx, scopeId, rows);
}

/**
 * The same check for a member of the household, in their own context: the whole chain comes from
 * fiscus_household_chain() (migration 0028), hidden events included, since the api has no system
 * context (#271). Callers report only whether it's intact.
 */
export async function verifyHouseholdChain(
  tx: Executor,
  householdId: string,
): Promise<ChainVerification> {
  const { rows } = await tx.execute<AuditEventRow>(sql`SELECT * FROM fiscus_household_chain()`);
  return checkChain(
    tx,
    householdId,
    rows.map((r) => ({
      id: Number(r.id),
      // Drizzle reads timestamps as text and maps them per column: the same here, so the hash
      // input matches verifyChain's exactly.
      occurredAt: auditEvents.occurredAt.mapFromDriverValue(r.occurred_at) as Date,
      actorKind: r.actor_kind,
      actorUserId: r.actor_user_id,
      actorMemberId: r.actor_member_id,
      householdId: r.household_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      visibleToHousehold: r.visible_to_household,
      metadata: r.metadata,
      ip: r.ip,
      scopeId: r.scope_id,
      seq: r.seq === null ? null : Number(r.seq),
      entryHash: r.entry_hash,
      accountId: r.account_id,
      changesEnc: r.changes_enc,
      hashVersion: r.hash_version,
      leaf: r.leaf,
    })),
  );
}

/** audit_events as Postgres returns it through Drizzle: bigints and timestamps as strings. */
interface AuditEventRow extends Record<string, unknown> {
  id: string;
  occurred_at: string;
  actor_kind: AuditEvent['actorKind'];
  actor_user_id: string | null;
  actor_member_id: string | null;
  household_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  visible_to_household: boolean;
  metadata: Record<string, unknown>;
  ip: string | null;
  scope_id: string;
  seq: string | null;
  entry_hash: Buffer | null;
  account_id: string | null;
  changes_enc: Buffer | null;
  hash_version: number;
  leaf: Buffer | null;
}

type AuditEvent = typeof auditEvents.$inferSelect;

async function checkChain(
  tx: Executor,
  scopeId: string,
  rows: AuditEvent[],
): Promise<ChainVerification> {
  let previous: Buffer = GENESIS;
  let expected = 1;
  const result = (extra: Partial<ChainVerification> = {}): ChainVerification => ({
    ok: true,
    scopeId,
    seq: expected - 1,
    headHash: previous.toString('hex'),
    ...extra,
  });

  for (const row of rows) {
    if (row.seq !== expected) return result({ ok: false, brokenAt: expected, reason: 'gap' });
    const fields: HashedFields = {
      scopeId,
      seq: row.seq,
      occurredAt: row.occurredAt,
      actorKind: row.actorKind,
      actorUserId: row.actorUserId,
      actorMemberId: row.actorMemberId,
      householdId: row.householdId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      ...(row.accountId ? { accountId: row.accountId } : {}),
      visibleToHousehold: row.visibleToHousehold,
      metadata: row.metadata,
      ip: row.ip,
      changesEnc: row.changesEnc,
    };
    let hash: Buffer;
    if (row.hashVersion === 2) {
      // The stored leaf is what proofs are made of, so it must be this entry's.
      const leaf = leafHash(fields);
      if (!row.leaf || !leaf.equals(row.leaf)) {
        return result({ ok: false, brokenAt: row.seq, reason: 'hash_mismatch' });
      }
      hash = linkHash(previous, leaf);
    } else if (row.hashVersion === 1 && row.leaf === null) {
      hash = entryHash(previous, fields);
    } else {
      return result({ ok: false, brokenAt: row.seq, reason: 'hash_mismatch' });
    }
    if (!row.entryHash || !hash.equals(row.entryHash)) {
      return result({ ok: false, brokenAt: row.seq, reason: 'hash_mismatch' });
    }
    previous = hash;
    expected++;
  }

  // The head must agree, or entries were removed from the end.
  const [head] = await tx
    .select()
    .from(auditChainHeads)
    .where(eq(auditChainHeads.scopeId, scopeId));
  if (head && (head.seq !== expected - 1 || !head.headHash.equals(previous))) {
    return result({ ok: false, brokenAt: expected, reason: 'head_mismatch' });
  }
  return result();
}

/** The most leaves one proof page carries (#264). */
export const PROOF_PAGE_SIZE = 5000;

export type HouseholdProof =
  | {
      ok: true;
      head: { seq: number; hash: string };
      /** Version 2 leaves of the entries after `from`, in order, as hex. */
      leaves: string[];
      /** More leaves follow: ask again from this seq, with the hash the fold reached. */
      next?: number;
    }
  | { ok: false; reason: 'history_diverged' | 'proof_unavailable' };

/**
 * A proof that the household's chain extends `from` (a member's last verified point): the leaves
 * of every entry after it, hidden ones included, and the head. Only hashes and positions, never
 * what the entries were (accounts-and-visibility §6). Without `from`, just the head: the starting
 * point for a device that has none. Runs in the member's own context, through
 * fiscus_household_chain_leaves() (migration 0033).
 */
export async function householdProof(
  tx: Executor,
  householdId: string,
  from?: { seq: number; hash: string },
  pageSize = PROOF_PAGE_SIZE,
): Promise<HouseholdProof> {
  // The head first, then leaves only up to it: an entry appended meanwhile can't make the proof
  // overshoot its own head.
  const [row] = await tx
    .select()
    .from(auditChainHeads)
    .where(eq(auditChainHeads.scopeId, householdId));
  const head = { seq: row?.seq ?? 0, hash: (row?.headHash ?? GENESIS).toString('hex') };
  if (!from) return { ok: true, head, leaves: [] };

  const diverged = { ok: false, reason: 'history_diverged' } as const;
  if (from.seq > head.seq) return diverged;
  if (from.seq === 0 && from.hash !== GENESIS_HASH) return diverged;
  const { rows } = await tx.execute<{
    seq: string;
    entry_hash: Buffer | null;
    leaf: Buffer | null;
    hash_version: number;
  }>(sql`SELECT * FROM fiscus_household_chain_leaves(${from.seq}, ${head.seq}, ${pageSize + 1})`);
  let after = rows;
  if (from.seq > 0) {
    // The entry at `from` must be the one the member verified.
    const [anchor, ...rest] = rows;
    if (
      !anchor ||
      Number(anchor.seq) !== from.seq ||
      !anchor.entry_hash?.equals(Buffer.from(from.hash, 'hex'))
    ) {
      return diverged;
    }
    after = rest;
  }
  after = after.slice(0, pageSize);
  // Version 1 entries have no leaf: their links need the whole entry.
  if (after.some((r) => r.hash_version !== 2 || !r.leaf)) {
    return { ok: false, reason: 'proof_unavailable' };
  }
  const last = after.length ? Number(after[after.length - 1]!.seq) : from.seq;
  return {
    ok: true,
    head,
    leaves: after.map((r) => r.leaf!.toString('hex')),
    ...(after.length === pageSize && last < head.seq ? { next: last } : {}),
  };
}
