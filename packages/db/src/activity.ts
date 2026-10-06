// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Executor } from './client.js';
import { auditChainHeads, auditEvents } from './schema/identity.js';

// Tamper-evident activity history (ADR 0013 §4). Each scope (a household, or the instance) is a
// hash chain: entry_hash(n) = SHA-256(entry_hash(n-1) ‖ canonical(entry n)). Changing, inserting,
// reordering, or deleting any past entry breaks every later hash.

export const INSTANCE_SCOPE = '00000000-0000-0000-0000-000000000000';
const GENESIS = Buffer.alloc(32);

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

export function entryHash(previous: Buffer, fields: HashedFields): Buffer {
  return createHash('sha256').update(previous).update(canonical(fields)).digest();
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
  const hash = entryHash(head.headHash, fields);
  const { scopeId: _scope, ...columns } = fields;
  await tx.insert(auditEvents).values({ ...columns, entryHash: hash });
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
 * context: a member can't see events about accounts hidden from them, which would look like gaps.
 */
export async function verifyChain(tx: Executor, scopeId: string): Promise<ChainVerification> {
  const rows = await tx
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.scopeId, scopeId), isNotNull(auditEvents.seq)))
    .orderBy(asc(auditEvents.seq));
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
    const hash = entryHash(previous, {
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
    });
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
