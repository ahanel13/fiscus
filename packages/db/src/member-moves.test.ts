// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { startMaintenance } from './maintenance.js';
import { MEMBER_MOVE_ENCRYPTED, MEMBER_MOVE_TABLES } from './member-move.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Moving out (#253, migrations 0120–0122) in the database alone: a move is seen only in the
 * household it moves into, started only by the person moving, for a membership of their own, and
 * changed only by the worker as fiscus_maintenance. Everything the move job touches is listed.
 */

const OLD = randomUUID();
const NEW = randomUUID();
const sam = { user: randomUUID(), old: randomUUID(), new: randomUUID() };
const ada = { user: randomUUID(), old: randomUUID() };

describe('member moves', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;
  let workerDb: DbHandle;

  async function as<T>(
    q: pg.Client,
    ctx: { household: string; member?: string; user?: string; system?: boolean },
    fn: (q: pg.Client) => Promise<T>,
  ): Promise<T> {
    await q.query('BEGIN');
    try {
      await q.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [ctx.household, ctx.member ?? '', ctx.user ?? '', ctx.system ? 'on' : 'off'],
      );
      return await fn(q);
    } finally {
      await q.query('ROLLBACK');
    }
  }
  const error = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };
  const insert = (q: pg.Client, from = sam.old, extra = '') =>
    q.query(
      `INSERT INTO member_moves (id, household_id, member_id, from_household_id, from_member_id${extra ? ', step' : ''})
       VALUES (gen_random_uuid(), $1, $2, $3, $4${extra ? `, ${extra}` : ''}) RETURNING id`,
      [NEW, sam.new, OLD, from],
    );
  const asSam = { household: NEW, member: sam.new, user: sam.user };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    worker = new pg.Client({ connectionString: tdb.workerUrl });
    await Promise.all([owner.connect(), app.connect(), worker.connect()]);
    workerDb = createDb(tdb.workerUrl, { max: 2 });
    await owner.query(
      `INSERT INTO users (id, email, display_name) VALUES ($1, 'sam@move.test', 'Sam'), ($2, 'ada@move.test', 'Ada');
       INSERT INTO households (id, name, base_currency, timezone) VALUES ($3, 'Old', 'USD', 'UTC'), ($4, 'New', 'USD', 'UTC');
       INSERT INTO household_members (id, household_id, user_id, role, display_name, color) VALUES
         ($5, $3, $1, 'member', 'Sam', '#111111'), ($6, $3, $2, 'owner', 'Ada', '#222222'),
         ($7, $4, $1, 'owner', 'Sam', '#111111');`
        .replaceAll('$1', `'${sam.user}'`)
        .replaceAll('$2', `'${ada.user}'`)
        .replaceAll('$3', `'${OLD}'`)
        .replaceAll('$4', `'${NEW}'`)
        .replaceAll('$5', `'${sam.old}'`)
        .replaceAll('$6', `'${ada.old}'`)
        .replaceAll('$7', `'${sam.new}'`),
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end(), workerDb?.close()]);
    await tdb?.stop();
  });

  it('lets you start a move only as the new household’s member, for a membership of yours', async () => {
    await as(app, asSam, async (q) => {
      expect((await insert(q)).rowCount).toBe(1);
      expect((await q.query('SELECT 1 FROM member_moves')).rowCount).toBe(1);
    });
    // Someone else's membership, a step already done, or from the household you're in: refused.
    expect(await as(app, asSam, (q) => error(() => insert(q, ada.old)))).toMatch(/row-level/);
    expect(await as(app, asSam, (q) => error(() => insert(q, sam.old, '3')))).toMatch(/row-level/);
    expect(
      await as(app, asSam, (q) =>
        error(() =>
          q.query(
            `INSERT INTO member_moves (id, household_id, member_id, from_household_id, from_member_id)
             VALUES (gen_random_uuid(), $1, $2, $1, $2)`,
            [NEW, sam.new],
          ),
        ),
      ),
    ).toMatch(/row-level|member_moves_households/);
  });

  it('shows it only in the new household, and never lets the api change it', async () => {
    const [{ id }] = (await insert(owner)).rows as [{ id: string }];
    try {
      await as(app, { household: OLD, member: ada.old, user: ada.user }, async (q) =>
        expect((await q.query('SELECT 1 FROM member_moves')).rowCount).toBe(0),
      );
      await as(app, { household: OLD, member: sam.old, user: sam.user }, async (q) => {
        expect((await q.query('SELECT 1 FROM member_moves')).rowCount).toBe(0);
        // In the household you're leaving, you learn only that you're moving, and where to.
        const { rows } = await q.query('SELECT fiscus_open_member_move($1) AS h', [sam.old]);
        expect(rows).toEqual([{ h: NEW }]);
      });
      await as(app, { household: OLD, member: ada.old, user: ada.user }, async (q) => {
        const { rows } = await q.query('SELECT fiscus_open_member_move($1) AS h', [sam.old]);
        expect(rows).toEqual([{ h: null }]);
      });
      await as(app, asSam, async (q) => {
        expect(
          (await q.query(`UPDATE member_moves SET status = 'done', finished_at = now()`)).rowCount,
        ).toBe(0);
        expect((await q.query('DELETE FROM member_moves')).rowCount).toBe(0);
      });
      // One move at a time.
      expect(await error(() => insert(owner))).toMatch(/member_moves_open/);
    } finally {
      await owner.query('DELETE FROM member_moves WHERE id = $1', [id]);
    }
  });

  it('gives the worker due moves as ids only, leased, and nobody else', async () => {
    const [{ id }] = (await insert(owner)).rows as [{ id: string }];
    try {
      await as(app, asSam, async (q) =>
        expect(
          (await q.query(`SELECT * FROM fiscus_claim_member_moves(5, interval '1 minute')`))
            .rowCount,
        ).toBe(0),
      );
      const { rows } = await worker.query(
        `SELECT * FROM fiscus_claim_member_moves(5, interval '1 minute')`,
      );
      expect(rows).toEqual([{ move_id: id, household_id: NEW }]);
      // Leased: not again until it runs out.
      expect(
        (await worker.query(`SELECT * FROM fiscus_claim_member_moves(5, interval '1 minute')`))
          .rowCount,
      ).toBe(0);
    } finally {
      await owner.query('DELETE FROM member_moves WHERE id = $1', [id]);
    }
  });

  it('lets the worker become fiscus_maintenance, recording the run, and not the app', async () => {
    const session = await startMaintenance(workerDb.db, { job: 'member-move', reason: 'test' });
    const { rows } = await owner.query(
      `SELECT metadata FROM audit_events WHERE action = 'maintenance.member-move'`,
    );
    expect(rows).toEqual([{ metadata: { reason: 'test' } }]);
    // Across households, as nothing else can.
    const seen = await session.transaction(async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`SELECT count(DISTINCT household_id)::int AS n FROM household_members`,
      );
      return r.rows[0]?.n;
    });
    expect(seen).toBe(2);
    expect(await error(() => app.query('SET ROLE fiscus_maintenance'))).toMatch(/permission/);
    await expect(startMaintenance(workerDb.db, { job: 'anything' as never })).rejects.toThrow(
      /allow-listed/,
    );
  });

  it('makes every key that keeps a row in its household deferrable (fails on new ones)', async () => {
    const { rows } = await owner.query(`
      SELECT c.conrelid::regclass::text || '.' || c.conname AS key
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND NOT c.condeferrable
        AND cardinality(c.conkey) > 1
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid
                    AND a.attnum = ANY (c.conkey) AND a.attname = 'household_id')`);
    expect(rows, 'Make it DEFERRABLE INITIALLY IMMEDIATE, as migration 0122 does').toEqual([]);
  });

  it('says what moving does with every household table and encrypted column (fails on new ones)', async () => {
    const { rows: tables } = await owner.query(`
      SELECT DISTINCT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT a.attisdropped
        AND (a.attname = 'household_id' OR c.relname = 'households')
      ORDER BY 1`);
    expect(
      tables.map((r) => r.t),
      'Add the table to MEMBER_MOVE_TABLES (member-move.ts) and the move job',
    ).toEqual(Object.keys(MEMBER_MOVE_TABLES).sort());
    const { rows: columns } = await owner.query(`
      SELECT c.table_name || '.' || c.column_name AS c FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name LIKE '%\\_enc' AND c.table_name IN (
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'household_id')
      ORDER BY 1`);
    expect(
      columns.map((r) => r.c),
      'Add the column to MEMBER_MOVE_ENCRYPTED (member-move.ts) and re-encrypt it in the move job',
    ).toEqual(Object.keys(MEMBER_MOVE_ENCRYPTED).sort());
  });
});
