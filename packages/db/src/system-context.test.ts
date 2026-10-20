// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const COLORS = ['#111111', '#222222', '#333333'];

/**
 * #271: what the api used system context for is a handful of definer functions (migration 0028),
 * each checking the context it's called in, and the worker has a login of its own. That system
 * context then works only for that login is the contract step, #376, with its tests.
 */
describe('system context belongs to the worker', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;

  const H = randomUUID();
  const X = randomUUID();
  const person = (role: 'owner' | 'member' | 'viewer', household: string) => ({
    user: randomUUID(),
    member: randomUUID(),
    email: `${randomUUID()}@system.test`,
    role,
    household,
  });
  const people = {
    a: person('owner', H),
    b: person('member', H),
    v: person('viewer', H),
    z: person('owner', X),
  };
  const newcomer = { user: randomUUID(), email: `${randomUUID()}@system.test` };
  const hidden = randomUUID(); // a's private account
  const shared = randomUUID();
  const token = 'invite-token';
  let c1: string;
  let c2: string;
  let cx: string;

  type Ctx = { household?: string; member?: string; user?: string; system?: boolean };
  /** One rolled-back transaction as `client`, in the given context. */
  async function as<T>(client: pg.Client, ctx: Ctx, fn: (q: pg.Client) => Promise<T>) {
    await client.query('BEGIN');
    try {
      await client.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [ctx.household ?? '', ctx.member ?? '', ctx.user ?? '', ctx.system ? 'on' : 'off'],
      );
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
    }
  }
  const member = (p: (typeof people)[keyof typeof people]): Ctx => ({
    household: p.household,
    member: p.member,
    user: p.user,
  });
  const count = async (q: pg.Client, table: string) =>
    (await q.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
  const error = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    worker = new pg.Client({ connectionString: tdb.workerUrl });
    await Promise.all([owner.connect(), app.connect(), worker.connect()]);

    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC'), ($2, 'X', 'USD', 'UTC')`,
      [H, X],
    );
    for (const p of [...Object.values(people), newcomer]) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Name')`, [
        p.user,
        p.email,
      ]);
    }
    for (const p of Object.values(people)) {
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, 'Name', $5)`,
        [p.member, p.household, p.user, p.role, COLORS[0]],
      );
    }
    await owner.query(
      `SELECT fiscus_seed_default_categories($1), fiscus_seed_default_categories($2)`,
      [H, X],
    );
    const categories = async (h: string) =>
      (
        await owner.query(
          `SELECT id FROM categories WHERE household_id = $1 AND system_key IS NULL ORDER BY name LIMIT 2`,
          [h],
        )
      ).rows.map((r) => r.id as string);
    [c1, c2] = (await categories(H)) as [string, string];
    [cx] = (await categories(X)) as [string];

    for (const [id, visibility] of [
      [hidden, 'private'],
      [shared, 'full'],
    ]) {
      await owner.query('BEGIN');
      await owner.query(
        `INSERT INTO accounts (id, household_id, name, type, currency, visibility, balance_mode)
         VALUES ($1, $2, 'acct', 'depository', 'USD', $3, 'transactions')`,
        [id, H, visibility],
      );
      await owner.query(
        `INSERT INTO account_owners (account_id, member_id, household_id, share_bps) VALUES ($1, $2, $3, 10000)`,
        [id, people.a.member, H],
      );
      await owner.query('COMMIT');
      await owner.query(
        `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency, authorized_date,
           original_description, display_name, source, category_id)
         VALUES (gen_random_uuid(), $1, $2, -1000, 'USD', '2026-01-01', 'desc', 'name', 'manual', $3)`,
        [H, id, c1],
      );
    }
    await owner.query(
      `INSERT INTO invites (id, household_id, email, role, token_hash, expires_at, invited_by_member_id)
       VALUES (gen_random_uuid(), $1, $2, 'member', $3, now() + interval '1 day', $4)`,
      [H, newcomer.email, sha256(token), people.a.member],
    );
    for (const h of [H, X]) {
      await owner.query(
        `INSERT INTO household_keys (household_id, version, wrapped_key, master_key_version)
         VALUES ($1, 1, '\\x00', 1)`,
        [h],
      );
    }
    // Two chained events in H, one about the account b can't see.
    await owner.query(
      `INSERT INTO audit_events (actor_kind, household_id, action, seq, entry_hash, account_id, visible_to_household)
       VALUES ('system', $1, 'one', 1, '\\x00', NULL, true), ('system', $1, 'two', 2, '\\x00', $2, true)`,
      [H, hidden],
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
    await tdb?.stop();
  });

  it("gives the worker the whole household in system context, and only that household's", async () => {
    await as(worker, { household: H, system: true }, async (q) => {
      expect(await count(q, 'households')).toBe(1);
      expect(await count(q, 'household_members')).toBe(3);
      expect(await count(q, 'accounts')).toBe(2);
      expect(await count(q, 'transactions')).toBe(2);
      expect(await count(q, 'household_keys')).toBe(1);
    });
    await as(worker, { household: H }, async (q) => expect(await count(q, 'transactions')).toBe(0));
  });

  it("doesn't let the app role become the worker", async () => {
    expect(await error(() => as(app, {}, (q) => q.query('SET ROLE fiscus_worker')))).toMatch(
      /permission denied/,
    );
  });

  describe('fiscus_create_household', () => {
    const create = (q: pg.Client) =>
      q.query(`SELECT fiscus_create_household('New', 'USD', 'UTC', NULL, $1) AS m`, [COLORS[0]]);

    it('makes the context user the owner of a new household', async () => {
      const id = randomUUID();
      await as(app, { household: id, user: newcomer.user }, async (q) => {
        const m = (await create(q)).rows[0].m;
        await q.query(`SELECT set_config('app.member_id', $1, true)`, [m]);
        expect(
          (await q.query('SELECT role FROM household_members WHERE id = $1', [m])).rows,
        ).toEqual([{ role: 'owner' }]);
      });
    });

    it('never adds an owner to an existing household', async () => {
      expect(await error(() => as(app, { household: H, user: newcomer.user }, create))).toMatch(
        /duplicate key/,
      );
    });

    it('needs a user, and no member', async () => {
      expect(await error(() => as(app, { household: randomUUID() }, create))).toMatch(/needs/);
      expect(await error(() => as(app, member(people.a), create))).toMatch(/needs/);
    });
  });

  describe('fiscus_join_household', () => {
    const join = (q: pg.Client, t = token) =>
      q.query('SELECT member_id, invite_id FROM fiscus_join_household($1, $2)', [
        sha256(t),
        COLORS,
      ]);

    it('joins the invited user, once, with a free color', async () => {
      await as(app, { household: H, user: newcomer.user }, async (q) => {
        const { rows } = await join(q);
        expect(rows).toHaveLength(1);
        await q.query(`SELECT set_config('app.member_id', $1, true)`, [rows[0].member_id]);
        expect(
          (
            await q.query('SELECT role, color FROM household_members WHERE id = $1', [
              rows[0].member_id,
            ])
          ).rows,
        ).toEqual([{ role: 'member', color: COLORS[1] }]);
        // The invite is used now (and the user's a member anyway).
        await q.query(`SELECT set_config('app.member_id', '', true)`);
        expect((await join(q)).rows).toEqual([]);
      });
    });

    it('needs the token, for the invite household, and the invited email', async () => {
      await as(app, { household: H, user: newcomer.user }, async (q) =>
        expect((await join(q, 'wrong')).rows).toEqual([]),
      );
      await as(app, { household: X, user: newcomer.user }, async (q) =>
        expect((await join(q)).rows).toEqual([]),
      );
      expect(await error(() => as(app, { household: H, user: people.z.user }, join))).toMatch(
        /another email/,
      );
    });
  });

  describe('deleting a category', () => {
    const reassign = (q: pg.Client, to = c2) =>
      q.query('SELECT fiscus_reassign_category($1, $2) AS n', [c1, to]);

    it("moves every transaction, including ones the member can't see", async () => {
      await as(app, member(people.b), async (q) => {
        expect(await count(q, 'transactions')).toBe(1);
        expect((await q.query('SELECT fiscus_category_in_use($1) AS u', [c1])).rows[0].u).toBe(
          true,
        );
        expect((await reassign(q)).rows[0].n).toBe(2);
        expect((await q.query('SELECT fiscus_category_in_use($1) AS u', [c1])).rows[0].u).toBe(
          false,
        );
      });
    });

    it('only for an owner or member of the household, between its own categories', async () => {
      expect(await error(() => as(app, member(people.v), reassign))).toMatch(/may edit/);
      expect(await error(() => as(app, { household: H }, reassign))).toMatch(/may edit/);
      expect(await error(() => as(app, member(people.b), (q) => reassign(q, cx)))).toMatch(
        /household's/,
      );
      expect(await error(() => as(app, member(people.z), reassign))).toMatch(/household's/);
      await as(app, member(people.z), async (q) =>
        expect((await q.query('SELECT fiscus_category_in_use($1) AS u', [c1])).rows[0].u).toBe(
          false,
        ),
      );
    });
  });

  it("gives a member the household's whole activity chain to verify, and no one else", async () => {
    await as(app, member(people.b), async (q) => {
      expect(
        (await q.query('SELECT 1 FROM audit_events WHERE household_id = $1', [H])).rowCount,
      ).toBe(1);
      expect(
        (await q.query('SELECT seq FROM fiscus_household_chain()')).rows.map((r) => Number(r.seq)),
      ).toEqual([1, 2]);
    });
    await as(app, { household: H }, async (q) =>
      expect((await q.query('SELECT 1 FROM fiscus_household_chain()')).rowCount).toBe(0),
    );
  });

  it('reads wrapped household keys by household (useless without the master key)', async () => {
    await as(app, {}, async (q) => {
      const { rows } = await q.query('SELECT version FROM fiscus_household_key($1, NULL)', [X]);
      expect(rows).toEqual([{ version: 1 }]);
    });
  });

  it('runs the writing functions as a role that can change only what they need', async () => {
    const { rows: owners } = await owner.query(`
      SELECT p.proname, r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname IN ('fiscus_create_household', 'fiscus_join_household', 'fiscus_reassign_category')
      ORDER BY 1`);
    expect(owners.map((o) => o.rolname)).toEqual([
      'fiscus_steward',
      'fiscus_steward',
      'fiscus_steward',
    ]);
    const { rows } = await owner.query(`
      SELECT t, p FROM unnest(ARRAY['households', 'household_members', 'invites', 'transactions',
                                    'categories', 'household_keys', 'audit_events', 'users']) t,
                       unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      WHERE has_table_privilege('fiscus_steward', t, p)`);
    expect(rows.map((r) => `${r.p} ${r.t}`).sort()).toEqual([
      'INSERT household_members',
      'INSERT households',
    ]);
    const { rows: columns } = await owner.query(`
      SELECT table_name || '.' || column_name AS c FROM information_schema.column_privileges
      WHERE grantee = 'fiscus_steward' AND privilege_type = 'UPDATE' ORDER BY 1`);
    expect(columns.map((r) => r.c)).toEqual([
      'invites.accepted_at',
      'invites.accepted_by_user_id',
      'transactions.category_id',
      'transactions.updated_at',
      'transactions.version',
    ]);
  });
});
