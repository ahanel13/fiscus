// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendActivity,
  entryHash,
  foldLeaves,
  GENESIS_HASH,
  householdProof,
  leafHash,
  linkHash,
  verifyChain,
  verifyHouseholdChain,
} from './activity.js';
import { createDb, type DbHandle, type Executor } from './client.js';
import { systemContext, withContext } from './context.js';
import { auditChainHeads, auditEvents } from './schema/identity.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Chain format version 2 (#264) next to version 1: an upgraded household's chain starts with
 * version 1 entries the previous release wrote, and continues with version 2 ones.
 */
describe('activity chain, versions 1 and 2', () => {
  let tdb: TestDatabase;
  let owner: pg.Client; // superuser: plays the operator editing the database directly
  let worker: DbHandle;
  let app: DbHandle;

  const H = randomUUID();
  const user = randomUUID();
  const member = randomUUID();

  const sql = async (text: string, params: unknown[] = []) =>
    (await owner.query(text, params)).rows;
  const system = <T>(fn: (tx: Executor) => Promise<T>) =>
    withContext(worker.db, systemContext(H), fn);
  const asMember = <T>(fn: (tx: Executor) => Promise<T>) =>
    withContext(app.db, { householdId: H, memberId: member, userId: user, system: false }, fn);
  const verify = () => system((tx) => verifyChain(tx, H));
  const proof = (from?: { seq: number; hash: string }, pageSize?: number) =>
    asMember((tx) => householdProof(tx, H, from, pageSize));
  const hashAt = async (seq: number) =>
    (
      await sql(
        `SELECT encode(entry_hash, 'hex') AS h FROM audit_events WHERE scope_id = $1 AND seq = $2`,
        [H, seq],
      )
    )[0]?.h as string;
  const leafAt = async (seq: number) =>
    (
      await sql(
        `SELECT encode(leaf, 'hex') AS l FROM audit_events WHERE scope_id = $1 AND seq = $2`,
        [H, seq],
      )
    )[0]?.l as string;

  /** What the previous release's appendActivity did: a version 1 entry, hash_version unnamed. */
  const appendV1 = (action: string) =>
    system(async (tx) => {
      await tx
        .insert(auditChainHeads)
        .values({ scopeId: H, seq: 0, headHash: Buffer.alloc(32) })
        .onConflictDoNothing();
      const [head] = await tx
        .select()
        .from(auditChainHeads)
        .where(eq(auditChainHeads.scopeId, H))
        .for('update');
      const seq = head!.seq + 1;
      const fields = {
        scopeId: H,
        seq,
        occurredAt: new Date(),
        actorKind: 'system' as const,
        actorUserId: null,
        actorMemberId: null,
        householdId: H,
        action,
        targetType: null,
        targetId: null,
        visibleToHousehold: true,
        metadata: {},
        ip: null,
        changesEnc: null,
      };
      const hash = entryHash(head!.headHash, fields);
      const { scopeId: _scope, ...columns } = fields;
      await tx.insert(auditEvents).values({ ...columns, entryHash: hash });
      await tx
        .update(auditChainHeads)
        .set({ seq, headHash: hash })
        .where(eq(auditChainHeads.scopeId, H));
    });
  const append = (action: string) =>
    system((tx) =>
      appendActivity(tx, { actorKind: 'system', householdId: H, action, visibleToHousehold: true }),
    );

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    worker = createDb(tdb.workerUrl, { max: 1 });
    app = createDb(tdb.appUrl, { max: 1 });
    await sql(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
      [H],
    );
    await sql(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Ann')`, [
      user,
      `${user}@chain.test`,
    ]);
    await sql(
      `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
       VALUES ($1, $2, $3, 'member', 'Ann', '#111111')`,
      [member, H, user],
    );
    // Two entries from before the upgrade, then three after it.
    await appendV1('old.one');
    await appendV1('old.two');
    for (const action of ['new.three', 'new.four', 'new.five']) await append(action);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.close(), app?.close()]);
    await tdb?.stop();
  });

  it('writes version 2 entries, with their leaf, and keeps version 1 ones as they were', async () => {
    const rows = await sql(
      `SELECT seq::int, hash_version, leaf IS NOT NULL AS has_leaf FROM audit_events
       WHERE scope_id = $1 ORDER BY seq`,
      [H],
    );
    expect(rows).toEqual([
      { seq: 1, hash_version: 1, has_leaf: false },
      { seq: 2, hash_version: 1, has_leaf: false },
      { seq: 3, hash_version: 2, has_leaf: true },
      { seq: 4, hash_version: 2, has_leaf: true },
      { seq: 5, hash_version: 2, has_leaf: true },
    ]);
  });

  it('verifies a mixed chain, as the worker and as a member', async () => {
    expect(await verify()).toMatchObject({ ok: true, seq: 5, headHash: await hashAt(5) });
    expect(await asMember((tx) => verifyHouseholdChain(tx, H))).toMatchObject({ ok: true, seq: 5 });
  });

  it('proves the version 2 part from a version 1 point, by leaves alone', async () => {
    const p = await proof({ seq: 2, hash: await hashAt(2) });
    expect(p).toEqual({
      ok: true,
      head: { seq: 5, hash: await hashAt(5) },
      leaves: [await leafAt(3), await leafAt(4), await leafAt(5)],
    });
    if (!p.ok) throw new Error('no proof');
    expect(foldLeaves(await hashAt(2), p.leaves)).toBe(p.head.hash);
    // From the head itself: nothing to add.
    expect(await proof({ seq: 5, hash: await hashAt(5) })).toMatchObject({ ok: true, leaves: [] });
    // With no point yet: the head, to start from.
    expect(await proof()).toEqual({ ok: true, head: p.head, leaves: [] });
  });

  it('pages a long proof, each page folding to the next one’s start', async () => {
    const first = await proof({ seq: 2, hash: await hashAt(2) }, 2);
    expect(first).toMatchObject({ ok: true, next: 4 });
    if (!first.ok) throw new Error('no proof');
    expect(first.leaves).toHaveLength(2);
    const at4 = foldLeaves(await hashAt(2), first.leaves);
    expect(at4).toBe(await hashAt(4));
    const second = await proof({ seq: 4, hash: at4 }, 2);
    expect(second).toEqual({ ok: true, head: first.head, leaves: [await leafAt(5)] });
    // A page that ends exactly at the head has no next.
    expect(await proof({ seq: 3, hash: await hashAt(3) }, 2)).not.toHaveProperty('next');
  });

  it("can't prove a range with version 1 entries", async () => {
    expect(await proof({ seq: 1, hash: await hashAt(1) })).toEqual({
      ok: false,
      reason: 'proof_unavailable',
    });
    expect(await proof({ seq: 0, hash: GENESIS_HASH })).toEqual({
      ok: false,
      reason: 'proof_unavailable',
    });
  });

  it('says the history diverged when the point is not in it', async () => {
    const diverged = { ok: false, reason: 'history_diverged' };
    expect(await proof({ seq: 3, hash: await hashAt(4) })).toEqual(diverged);
    expect(await proof({ seq: 0, hash: await hashAt(1) })).toEqual(diverged);
    expect(await proof({ seq: 6, hash: await hashAt(5) })).toEqual(diverged); // ahead of the head
  });

  it('detects an edited version 2 entry, or its stored leaf, or its link', async () => {
    const [saved] = await sql(
      `SELECT action, leaf, entry_hash FROM audit_events WHERE scope_id = $1 AND seq = 4`,
      [H],
    );
    const restore = () =>
      sql(
        `UPDATE audit_events SET action = $2, hash_version = 2, leaf = $3, entry_hash = $4 WHERE scope_id = $1 AND seq = 4`,
        [H, saved.action, saved.leaf, saved.entry_hash],
      );
    const broken = { ok: false, brokenAt: 4, reason: 'hash_mismatch' };

    await sql(`UPDATE audit_events SET action = 'edited' WHERE scope_id = $1 AND seq = 4`, [H]);
    expect(await verify()).toMatchObject(broken);
    await restore();

    // A leaf that isn't the entry's: proofs would carry it, so verification checks it.
    await sql(`UPDATE audit_events SET leaf = sha256(leaf) WHERE scope_id = $1 AND seq = 4`, [H]);
    expect(await verify()).toMatchObject(broken);
    await restore();

    // A downgrade to version 1 doesn't dodge the check either.
    await sql(
      `UPDATE audit_events SET hash_version = 1, leaf = NULL WHERE scope_id = $1 AND seq = 4`,
      [H],
    );
    expect(await verify()).toMatchObject(broken);
    await restore();

    await sql(
      `UPDATE audit_events SET entry_hash = sha256(entry_hash) WHERE scope_id = $1 AND seq = 4`,
      [H],
    );
    expect(await verify()).toMatchObject(broken);
    await restore();
    expect((await verify()).ok).toBe(true);
  });

  it('catches a consistent rewrite only against a remembered point', async () => {
    // The operator rewrites entry 4 and recomputes every leaf and link after it: the chain itself
    // verifies again, but a member who remembered 4 or 5 sees that history diverged.
    const remembered = { seq: 5, hash: await hashAt(5) };
    const before = await sql(
      `SELECT seq, action, leaf, entry_hash FROM audit_events WHERE scope_id = $1 AND seq >= 4 ORDER BY seq`,
      [H],
    );
    await sql(`UPDATE audit_events SET action = 'rewritten' WHERE scope_id = $1 AND seq = 4`, [H]);
    const rows = await system((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.scopeId, H)),
    );
    let previous: Buffer = Buffer.from(await hashAt(3), 'hex');
    for (const row of rows.filter((r) => r.seq! >= 4).sort((a, b) => a.seq! - b.seq!)) {
      const leaf = leafHash({
        scopeId: H,
        seq: row.seq!,
        occurredAt: row.occurredAt,
        actorKind: row.actorKind,
        actorUserId: row.actorUserId,
        actorMemberId: row.actorMemberId,
        householdId: row.householdId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        visibleToHousehold: row.visibleToHousehold,
        metadata: row.metadata,
        ip: row.ip,
        changesEnc: row.changesEnc,
      });
      previous = linkHash(previous, leaf);
      await sql(
        `UPDATE audit_events SET leaf = $3, entry_hash = $4 WHERE scope_id = $1 AND seq = $2`,
        [H, row.seq, leaf, previous],
      );
    }
    await sql(`UPDATE audit_chain_heads SET head_hash = $2 WHERE scope_id = $1`, [H, previous]);
    expect((await verify()).ok).toBe(true);
    expect(await proof(remembered)).toEqual({ ok: false, reason: 'history_diverged' });

    for (const row of before) {
      await sql(
        `UPDATE audit_events SET action = $3, leaf = $4, entry_hash = $5 WHERE scope_id = $1 AND seq = $2`,
        [H, row.seq, row.action, row.leaf, row.entry_hash],
      );
    }
    await sql(`UPDATE audit_chain_heads SET head_hash = $2 WHERE scope_id = $1`, [
      H,
      Buffer.from(remembered.hash, 'hex'),
    ]);
    expect((await verify()).ok).toBe(true);
  });

  it('gives a proof only to a member of the household', async () => {
    const outsider = await withContext(
      app.db,
      { householdId: H, memberId: randomUUID(), userId: user, system: false },
      (tx) => householdProof(tx, H, { seq: 2, hash: GENESIS_HASH }),
    );
    // No head and no leaves are visible: from the outside, nothing to compare against.
    expect(outsider).toEqual({ ok: false, reason: 'history_diverged' });
  });
});
