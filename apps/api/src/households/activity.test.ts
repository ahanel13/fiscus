// SPDX-License-Identifier: AGPL-3.0-or-later
import { households, INSTANCE_SCOPE, verifyChain } from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../database/database.module.js';
import { createTestApp, TestClient } from '../testing/test-app.js';
import type { HouseholdContext } from './household-context.js';
import { HouseholdScope, UnrecordedWriteError } from './household-scope.js';

/** ADR 0013: every household change is recorded, and tampering is detectable. */
describe('activity history', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client; // superuser: plays the operator editing the database directly
  let ann: TestClient;
  let ben: TestClient;
  let hid: string;
  let ctx: HouseholdContext;

  const sql = async (text: string, params: unknown[] = []) =>
    (await owner.query(text, params)).rows;
  // The API reports only ok/broken to members; the details are checked against the chain itself.
  const verifyApi = async () =>
    (await ann.get(`/api/v1/households/${hid}/activity/verify`)).body.data;
  const verify = async () =>
    app
      .get(HouseholdScope)
      .asSystem(hid, { kind: 'system', userId: null, memberId: null }, (tx) =>
        verifyChain(tx, hid),
      );
  const feed = async () => (await ann.get(`/api/v1/households/${hid}/activity`)).body.data;
  const ifMatch = (v: number) => ({ headers: { 'if-match': `"v${v}"` } });

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@act.test`,
        password: 'activity test Password1!',
        displayName: name,
      });
      return c;
    };
    ann = await signup('ann');
    ben = await signup('ben');
    const created = (
      await ann.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data;
    hid = created.id;
    ctx = {
      householdId: hid,
      memberId: created.you.memberId,
      role: 'owner',
      userId: (await ann.get('/api/v1/me')).body.data.id,
    };

    await ann.request(
      'PATCH',
      `/api/v1/households/${hid}`,
      { name: 'Our Home', weekStart: 0 },
      ifMatch(1),
    );
    const invite = await ann.post(`/api/v1/households/${hid}/invites`, {
      email: 'ben@act.test',
      role: 'member',
    });
    const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
    await ben.post('/api/v1/invites/accept', { token });
  }, 180_000);

  afterAll(async () => {
    await Promise.all([app?.close(), owner?.end()]);
    await tdb?.stop();
  });

  describe('recording', () => {
    it('records every change in order, with encrypted before/after values', async () => {
      const items = await feed();
      expect(items.map((i: { action: string }) => i.action)).toEqual([
        'member.joined',
        'invite.created',
        'household.updated',
        'household.created',
      ]);
      // Ids are opaque: no chain positions leak to members.
      const ids = items.map((i: { id: string }) => i.id);
      expect(new Set(ids).size).toBe(4);
      expect(ids.every((id: string) => !/^\d+$/.test(id))).toBe(true);
      const updated = items.find((i: { action: string }) => i.action === 'household.updated');
      expect(updated.changes).toEqual({
        before: { name: 'Home', weekStart: 1 },
        after: { name: 'Our Home', weekStart: 0 },
      });
      // At rest, the values are ciphertext, never plaintext.
      const [row] = await sql(
        "SELECT changes_enc, metadata FROM audit_events WHERE household_id = $1 AND action = 'household.updated'",
        [hid],
      );
      expect(row.changes_enc.toString('latin1')).not.toContain('Our Home');
      expect(row.metadata).toEqual({ fields: ['name', 'weekStart'] });
    });

    it('rolls back a household write that records no activity', async () => {
      const scope = app.get(HouseholdScope);
      await expect(
        scope.run(ctx, (tx) =>
          tx.update(households).set({ name: 'Sneaky' }).where(eq(households.id, hid)),
        ),
      ).rejects.toThrow(UnrecordedWriteError);
      const [row] = await sql('SELECT name FROM households WHERE id = $1', [hid]);
      expect(row.name).toBe('Our Home');
    });

    it('allows reads and row locks without activity, and writes that record it', async () => {
      const scope = app.get(HouseholdScope);
      await expect(
        scope.run(ctx, (tx) =>
          tx.select().from(households).where(eq(households.id, hid)).for('update'),
        ),
      ).resolves.toHaveLength(1);
      await scope.run(ctx, async (tx, activity) => {
        await tx.update(households).set({ name: 'Our Home' }).where(eq(households.id, hid));
        await activity.record({
          action: 'household.touched',
          targetType: 'household',
          targetId: hid,
        });
      });
    });

    it('chains instance-level events (sign-ups, sign-ins) too', async () => {
      const db = app.get<{ db: Parameters<typeof verifyChain>[0] }>(DB).db;
      const result = await verifyChain(db, INSTANCE_SCOPE);
      expect(result.ok).toBe(true);
      expect(result.seq).toBeGreaterThanOrEqual(2); // two sign-ups
    });
  });

  describe('tamper evidence', () => {
    it('verifies an untouched chain and reports its head', async () => {
      expect(await verifyApi()).toEqual({ ok: true, checkedAt: expect.any(String) });
      const result = await verify();
      expect(result).toMatchObject({ ok: true, seq: 5 });
      expect(result.headHash).toMatch(/^[0-9a-f]{64}$/);
      const [head] = await sql(
        'SELECT seq, encode(head_hash, $2) AS h FROM audit_chain_heads WHERE scope_id = $1',
        [hid, 'hex'],
      );
      expect(head).toEqual({ seq: '5', h: result.headHash });
    });

    it('detects an edited past entry (even by a database superuser)', async () => {
      await sql(
        'UPDATE audit_events SET metadata = \'{"fields":["name"]}\' WHERE household_id = $1 AND seq = 2',
        [hid],
      );
      expect(await verify()).toMatchObject({ ok: false, brokenAt: 2, reason: 'hash_mismatch' });
      expect(await verifyApi()).toEqual({ ok: false, checkedAt: expect.any(String) });
      await sql(
        'UPDATE audit_events SET metadata = \'{"fields":["name","weekStart"]}\' WHERE household_id = $1 AND seq = 2',
        [hid],
      );
      expect((await verify()).ok).toBe(true); // restoring the exact bytes restores the chain
    });

    it('detects a deleted entry in the middle and a truncated tail', async () => {
      const [saved] = await sql('SELECT * FROM audit_events WHERE household_id = $1 AND seq = 3', [
        hid,
      ]);
      await sql('DELETE FROM audit_events WHERE household_id = $1 AND seq = 3', [hid]);
      expect(await verify()).toMatchObject({ ok: false, brokenAt: 3, reason: 'gap' });

      await sql('DELETE FROM audit_events WHERE household_id = $1 AND seq >= 3', [hid]);
      expect(await verify()).toMatchObject({ ok: false, reason: 'head_mismatch', seq: 2 });
      expect(saved.seq).toBe('3');
    });
  });
});
