// SPDX-License-Identifier: AGPL-3.0-or-later
import { foldLeaves, GENESIS_HASH } from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * A member's browser checks the activity history for itself (#264, ADR 0013 §4): from its last
 * verified point, the server proves the chain only grew, with hashes alone.
 */
describe('activity history proofs', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client; // superuser: plays the operator editing the database directly
  let ann: TestClient;
  let ben: TestClient;
  let vic: TestClient;
  let hid: string;
  let annMember: string;
  let annUser: string;

  const sql = async (text: string, params: unknown[] = []) =>
    (await owner.query(text, params)).rows;
  const url = (path: string, h = hid) => `/api/v1/households/${h}/activity${path}`;
  const proof = (c: TestClient, from?: { seq: number; hash: string }, h = hid) =>
    c.get(url(from ? `/proof?after=${from.seq}&hash=${from.hash}` : '/proof', h));
  const hashAt = async (seq: number, h = hid) =>
    (
      await sql(
        `SELECT encode(entry_hash, 'hex') AS h FROM audit_events WHERE scope_id = $1 AND seq = $2`,
        [h, seq],
      )
    )[0].h as string;
  const report = (c: TestClient, body: unknown) => c.post(url('/integrity-reports'), body);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@proof.test`,
        password: 'proof test Password1!',
        displayName: name,
      });
      return c;
    };
    ann = await signup('ann');
    ben = await signup('ben');
    vic = await signup('vic');
    const created = (
      await ann.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data;
    hid = created.id;
    annMember = created.you.memberId;
    annUser = (await ann.get('/api/v1/me')).body.data.id;
    for (const [c, email, role] of [
      [ben, 'ben@proof.test', 'member'],
      [vic, 'vic@proof.test', 'viewer'],
    ] as const) {
      const invite = await ann.post(`/api/v1/households/${hid}/invites`, { email, role });
      const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
      await c.post('/api/v1/invites/accept', { token });
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all([app?.close(), owner?.end()]);
    await tdb?.stop();
  });

  it('gives a device with no point yet just the head, to start from', async () => {
    const r = await proof(ben);
    expect(r.status).toBe(200);
    const [head] = await sql(
      `SELECT seq::int, encode(head_hash, 'hex') AS hash FROM audit_chain_heads WHERE scope_id = $1`,
      [hid],
    );
    expect(r.body).toEqual({ data: { head, leaves: [] } });
  });

  it('proves the whole history of a new household from genesis', async () => {
    const r = await proof(ben, { seq: 0, hash: GENESIS_HASH });
    expect(r.status).toBe(200);
    expect(r.body.data.leaves).toHaveLength(r.body.data.head.seq);
    expect(foldLeaves(GENESIS_HASH, r.body.data.leaves)).toBe(r.body.data.head.hash);
  });

  it('includes events about accounts hidden from the caller, and nothing else about them', async () => {
    const from = (await proof(ben)).body.data.head;
    const account = (
      await ann.post(`/api/v1/households/${hid}/accounts`, {
        name: 'Secret Savings',
        type: 'depository',
        visibility: 'private',
      })
    ).body.data.id as string;
    expect(account).toBeTruthy();
    const hidden = await sql(
      `SELECT seq::int, account_id, encode(leaf, 'hex') AS leaf FROM audit_events
       WHERE scope_id = $1 AND seq > $2 ORDER BY seq`,
      [hid, from.seq],
    );
    // Every one of them is about the account Ben can't see.
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((e) => e.account_id === account)).toBe(true);

    const r = await proof(ben, from);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data).sort()).toEqual(['head', 'leaves']);
    expect(r.body.data.leaves).toEqual(hidden.map((e) => e.leaf));
    expect(foldLeaves(from.hash, r.body.data.leaves)).toBe(r.body.data.head.hash);
    expect(r.body.data.head.seq).toBe(from.seq + hidden.length);
    // Ben can't see those events in the feed, and the proof says nothing of what they were.
    const feed = JSON.stringify((await ben.get(url('?limit=200'))).body);
    expect(feed).not.toContain(account);
    const json = JSON.stringify(r.body);
    for (const secret of [account, 'account', 'Secret', annMember, annUser, '127.0.0.1', '"id"']) {
      expect(json).not.toContain(secret);
    }
    // Only the leaves and the head: 64 hex characters each, and numbers.
    expect(r.body.data.leaves.every((l: string) => /^[0-9a-f]{64}$/.test(l))).toBe(true);
    expect(json.replace(/"[0-9a-f]{64}"/g, '').replace(/\d+/g, '')).toBe(
      '{"data":{"head":{"seq":,"hash":},"leaves":[' + ','.repeat(hidden.length - 1) + ']}}',
    );
  });

  it('says the history diverged when the point is not in it', async () => {
    const head = (await proof(ben)).body.data.head;
    const diverged = async (from: { seq: number; hash: string }) => {
      const r = await proof(ben, from);
      expect(r.status, JSON.stringify(from)).toBe(409);
      expect(r.body.code).toBe('history_diverged');
    };
    await diverged({ seq: head.seq - 1, hash: head.hash }); // another entry's hash
    await diverged({ seq: head.seq + 1, hash: head.hash }); // beyond the head: history shrank
    await diverged({ seq: 0, hash: head.hash }); // not genesis
    // A database rewrite of the remembered entry, even with its chain recomputed after it.
    await sql(
      `UPDATE audit_events SET entry_hash = sha256(entry_hash) WHERE scope_id = $1 AND seq = $2`,
      [hid, head.seq],
    );
    await diverged(head);
    await sql(`UPDATE audit_events SET entry_hash = $3 WHERE scope_id = $1 AND seq = $2`, [
      hid,
      head.seq,
      Buffer.from(head.hash, 'hex'),
    ]);
    expect((await proof(ben, head)).status).toBe(200);
  });

  it("can't prove a range with entries in the older format", async () => {
    // An entry recorded before #264 (version 1, no leaf); here, one made so by the superuser.
    const [entry] = await sql(`SELECT leaf FROM audit_events WHERE scope_id = $1 AND seq = 2`, [
      hid,
    ]);
    await sql(
      `UPDATE audit_events SET hash_version = 1, leaf = NULL WHERE scope_id = $1 AND seq = 2`,
      [hid],
    );
    try {
      const r = await proof(ben, { seq: 1, hash: await hashAt(1) });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('proof_unavailable');
      // From that entry on, it can.
      expect((await proof(ben, { seq: 2, hash: await hashAt(2) })).status).toBe(200);
    } finally {
      await sql(
        `UPDATE audit_events SET hash_version = 2, leaf = $2 WHERE scope_id = $1 AND seq = 2`,
        [hid, entry.leaf],
      );
    }
    expect((await ann.get(url('/verify'))).body.data.ok).toBe(true);
  });

  it('refuses a malformed point', async () => {
    for (const query of [
      `?hash=${GENESIS_HASH}`,
      '?after=1',
      '?after=1&hash=abc',
      `?after=-1&hash=${GENESIS_HASH}`,
      `?after=x&hash=${GENESIS_HASH}`,
      `?after=1&hash=${GENESIS_HASH}&extra=1`,
    ]) {
      const r = await ben.get(url(`/proof${query}`));
      expect(r.status, query).toBe(422);
    }
  });

  it('pages a proof at 5 000 leaves', async () => {
    // A second household with a long history: the operator appends 5 001 entries (valid links,
    // made-up leaves; proofs don't look inside).
    const h2 = (
      await ann.post('/api/v1/households', { name: 'Big', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id as string;
    const start = (await proof(ann, undefined, h2)).body.data.head;
    const leaves: string[] = [];
    const hashes: string[] = [];
    let hash = start.hash;
    for (let i = 0; i < 5001; i++) {
      const leaf = foldLeaves(GENESIS_HASH, [i.toString(16).padStart(64, '0')]);
      hash = foldLeaves(hash, [leaf]);
      leaves.push(leaf);
      hashes.push(hash);
    }
    await sql(
      `INSERT INTO audit_events (actor_kind, household_id, action, seq, hash_version, leaf, entry_hash)
       SELECT 'system', $1, 'bulk', $2::bigint + n, 2, decode(l, 'hex'), decode(e, 'hex')
       FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS t(l, e, n)`,
      [h2, start.seq, leaves, hashes],
    );
    await sql(
      `UPDATE audit_chain_heads SET seq = $2, head_hash = decode($3, 'hex') WHERE scope_id = $1`,
      [h2, start.seq + 5001, hash],
    );

    const first = await proof(ann, start, h2);
    expect(first.status).toBe(200);
    expect(first.body.data.leaves).toHaveLength(5000);
    expect(first.body.data.next).toBe(start.seq + 5000);
    expect(first.body.data.head).toEqual({ seq: start.seq + 5001, hash });
    const reached = foldLeaves(start.hash, first.body.data.leaves);
    const second = await proof(ann, { seq: first.body.data.next, hash: reached }, h2);
    expect(second.body).toEqual({
      data: { head: { seq: start.seq + 5001, hash }, leaves: [leaves[5000]] },
    });
    expect(foldLeaves(reached, second.body.data.leaves)).toBe(hash);
  });

  describe('reports of a failed check', () => {
    const body = (reason = 'fold_mismatch') => ({
      lastVerified: { seq: 3, hash: GENESIS_HASH.replace(/0/g, 'a') },
      observed: { seq: 9, hash: GENESIS_HASH.replace(/0/g, 'b') },
      reason,
    });

    it('records a household-visible event, as a device’s claim, with the server’s own check', async () => {
      const r = await report(vic, body());
      expect(r.status, JSON.stringify(r.body)).toBe(204);
      const [event] = (await ann.get(url('?limit=1'))).body.data;
      const vicMember = (await vic.get(`/api/v1/households/${hid}`)).body.data.you.memberId;
      expect(event).toMatchObject({
        action: 'history.integrity_check_failed',
        actorMemberId: vicMember,
        targetType: 'household',
        targetId: hid,
        metadata: {
          claim: 'device',
          reason: 'fold_mismatch',
          lastVerified: body().lastVerified,
          observed: body().observed,
          serverCheck: { ok: true, checkedAt: expect.any(String) },
        },
      });
      // Every member sees it.
      for (const c of [ben, vic]) {
        const feed = (await c.get(url('?limit=1'))).body.data;
        expect(feed[0].action).toBe('history.integrity_check_failed');
      }
    });

    it("notes when the server's own check fails too", async () => {
      const [saved] = await sql(`SELECT action FROM audit_events WHERE scope_id = $1 AND seq = 2`, [
        hid,
      ]);
      await sql(`UPDATE audit_events SET action = 'edited' WHERE scope_id = $1 AND seq = 2`, [hid]);
      try {
        expect((await report(ann, body('history_diverged'))).status).toBe(204);
        const [event] = (await ann.get(url('?limit=1'))).body.data;
        expect(event.metadata).toMatchObject({
          reason: 'history_diverged',
          serverCheck: { ok: false },
        });
      } finally {
        await sql(`UPDATE audit_events SET action = $2 WHERE scope_id = $1 AND seq = 2`, [
          hid,
          saved.action,
        ]);
      }
      expect((await ann.get(url('/verify'))).body.data.ok).toBe(true);
    });

    it('takes only the documented shape', async () => {
      for (const bad of [
        { ...body(), reason: 'because' },
        { ...body(), lastVerified: { seq: 1 } },
        { ...body(), lastVerified: { seq: -1, hash: GENESIS_HASH } },
        { ...body(), observed: { hash: 'xyz' } },
        { ...body(), note: 'free text' },
      ]) {
        expect((await report(ben, bad)).status, JSON.stringify(bad)).toBe(422);
      }
      // `observed` is optional: the device may have nothing to show (a 409, or no response body).
      const { observed: _o, ...minimal } = body('proof_unavailable');
      expect((await report(ben, minimal)).status).toBe(204);
    });

    it('limits how often a member reports', async () => {
      // Ben has reported once already; four more, then no more for now.
      for (let i = 0; i < 4; i++) expect((await report(ben, body())).status).toBe(204);
      const limited = await report(ben, body());
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Per member: others still can.
      expect((await report(vic, body())).status).toBe(204);
    });
  });
});
