// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAINTENANCE_JOBS, runMaintenanceJob } from './maintenance.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Row-level security on its own, with no application code involved: the database alone keeps
 * households apart (ADR 0005), even when the context is forged.
 */
describe('row-level security', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  const A = { household: randomUUID(), user: randomUUID(), member: randomUUID() };
  const B = { household: randomUUID(), user: randomUUID(), member: randomUUID() };
  const TABLES = ['households', 'household_members', 'invites', 'household_keys', 'audit_events'];
  // Household tables with their own visibility suites (accounts, ledger, connections, budgets
  // tests; activity_transactions in the api's history tests).
  const COVERED_ELSEWHERE = [
    'account_groups',
    'account_liabilities',
    'account_owner_periods',
    'activity_transactions',
    'aggregation_credentials',
    'account_placements',
    'accounts',
    'account_owners',
    'balance_snapshots',
    'budget_amounts',
    'budget_categories',
    'budget_strategies',
    'budgets',
    'categories',
    'connection_secrets',
    'connections',
    'category_groups',
    'import_batches',
    'import_profiles',
    'member_preferences',
    'rules',
    'sync_holds',
    'tags',
    'transaction_attributions',
    'transaction_notes',
    'transaction_tags',
    'transactions',
  ];

  /** Runs statements as fiscus_app inside one transaction with the given context. */
  async function asApp<T>(
    ctx: Partial<Record<'household' | 'member' | 'user' | 'system', string>>,
    fn: () => Promise<T>,
  ) {
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [ctx.household ?? '', ctx.member ?? '', ctx.user ?? '', ctx.system ?? 'off'],
      );
      return await fn();
    } finally {
      await app.query('ROLLBACK');
    }
  }
  const ids = async (table: string) =>
    (
      await app.query(`SELECT ${table === 'households' ? 'id' : 'household_id'} AS h FROM ${table}`)
    ).rows
      .map((r) => r.h)
      .filter(Boolean);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    await Promise.all([owner.connect(), app.connect()]);
    for (const x of [A, B]) {
      await owner.query(
        `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U');
         INSERT INTO households (id, name, base_currency, timezone) VALUES ($3, 'H', 'USD', 'UTC');
         INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
           VALUES ($4, $3, $1, 'owner', 'U', '#000');
         INSERT INTO invites (id, household_id, email, role, token_hash, expires_at)
           VALUES (gen_random_uuid(), $3, 'x@y.z', 'member', sha256(gen_random_uuid()::text::bytea), now() + interval '1 day');
         INSERT INTO household_keys (household_id, version, wrapped_key, master_key_version)
           VALUES ($3, 1, decode(repeat('00', 69), 'hex'), 1);
         INSERT INTO audit_events (actor_kind, household_id, action) VALUES ('system', $3, 'test');`
          .replaceAll('$1', `'${x.user}'`)
          .replaceAll('$2', `'${x.user}@rls.test'`)
          .replaceAll('$3', `'${x.household}'`)
          .replaceAll('$4', `'${x.member}'`),
      );
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
    await tdb?.stop();
  });

  it('enables and forces RLS with policies on every household-scoped table (fails on new tables)', async () => {
    const { rows } = await owner.query(`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND (
        c.relname = 'households' OR EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'household_id' AND NOT a.attisdropped))
      ORDER BY 1`);
    expect(rows.map((r) => r.table).sort()).toEqual([...TABLES, ...COVERED_ELSEWHERE].sort());
    const unprotected = rows.filter((r) => !r.enabled || !r.forced || r.policies === 0);
    expect(unprotected, 'Add ENABLE + FORCE ROW LEVEL SECURITY and policies').toEqual([]);
  });

  it('marks writes on every household table, so unrecorded changes are caught (ADR 0013)', async () => {
    const { rows } = await owner.query(`
      SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'audit_events'
        AND (c.relname = 'households' OR EXISTS (SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'household_id' AND NOT a.attisdropped))
        AND NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE t.tgrelid = c.oid AND p.proname = 'fiscus_mark_household_write')`);
    expect(rows, 'Add the fiscus_mark_household_write trigger').toEqual([]);
  });

  it('fails closed: no context, no rows', async () => {
    await asApp({}, async () => {
      for (const t of TABLES.filter((t) => t !== 'audit_events')) expect(await ids(t)).toEqual([]);
    });
  });

  it("a member's context sees only their household", async () => {
    await asApp({ household: A.household, member: A.member, user: A.user }, async () => {
      for (const t of TABLES) expect(new Set(await ids(t))).toEqual(new Set([A.household]));
    });
  });

  it('a forged context (member of A claiming household B) sees and changes nothing of B', async () => {
    await asApp({ household: B.household, member: A.member, user: A.user }, async () => {
      // Only A's own household/membership remain visible (via the user branch), nothing of B's.
      for (const t of TABLES) expect(await ids(t)).not.toContain(B.household);
      expect(
        (await app.query(`UPDATE households SET name = 'pwned' WHERE id = '${B.household}'`))
          .rowCount,
      ).toBe(0);
      expect(
        (await app.query(`DELETE FROM invites WHERE household_id = '${B.household}'`)).rowCount,
      ).toBe(0);
      // Last: an expected error aborts the transaction.
      await expect(
        app.query(
          `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
           VALUES (gen_random_uuid(), '${B.household}', '${A.user}', 'owner', 'X', '#000')`,
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('cannot write into another household from a valid context', async () => {
    await asApp({ household: A.household, member: A.member, user: A.user }, async () => {
      expect(
        (
          await app.query(
            `UPDATE household_members SET role = 'viewer' WHERE household_id = '${B.household}'`,
          )
        ).rowCount,
      ).toBe(0);
      // Last: an expected error aborts the transaction.
      await expect(
        app.query(
          `INSERT INTO invites (id, household_id, email, role, token_hash, expires_at)
           VALUES (gen_random_uuid(), '${B.household}', 'evil@x.y', 'owner',
                   sha256(gen_random_uuid()::text::bytea), now() + interval '1 day')`,
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('user context lists only your own memberships across households', async () => {
    await asApp({ user: A.user }, async () => {
      expect(await ids('household_members')).toEqual([A.household]);
      expect(await ids('households')).toEqual([A.household]);
      expect(await ids('invites')).toEqual([]);
    });
  });

  it('a member who left loses access immediately', async () => {
    await owner.query(`UPDATE household_members SET left_at = now() WHERE id = '${A.member}'`);
    try {
      await asApp({ household: A.household, member: A.member, user: A.user }, async () => {
        expect(await ids('households')).toEqual([]);
        expect(await ids('invites')).toEqual([]);
      });
    } finally {
      await owner.query(`UPDATE household_members SET left_at = NULL WHERE id = '${A.member}'`);
    }
  });

  it('runs definer functions as a role that can read, but never write', async () => {
    const { rows: owners } = await owner.query(`
      SELECT p.proname, r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname IN ('fiscus_context_valid', 'fiscus_find_invite') ORDER BY 1`);
    expect(owners).toEqual([
      { proname: 'fiscus_context_valid', rolname: 'fiscus_definer' },
      { proname: 'fiscus_find_invite', rolname: 'fiscus_definer' },
    ]);
    const { rows } = await owner.query(`
      SELECT t, p, has_table_privilege('fiscus_definer', t, p) AS granted
      FROM unnest(ARRAY['households', 'household_members', 'invites', 'household_keys', 'users']) t,
           unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p`);
    const granted = rows.filter((r) => r.granted).map((r) => `${r.p} ${r.t}`);
    expect(granted.sort()).toEqual([
      'SELECT household_keys', // wrapped with the master key (fiscus_household_key, #271)
      'SELECT household_members',
      'SELECT households',
      'SELECT invites',
    ]);
  });

  describe('maintenance role', () => {
    it('runs only allow-listed jobs, records each run, and bypasses RLS', async () => {
      await expect(
        runMaintenanceJob(tdb.maintenanceUrl, { job: 'anything' as never }, async () => 1),
      ).rejects.toThrow(/not an allow-listed/);

      const seen = await runMaintenanceJob(
        tdb.maintenanceUrl,
        { job: MAINTENANCE_JOBS[0], householdId: A.household, reason: 'test' },
        async (db) => (await db.execute('SELECT count(*)::int AS n FROM households')).rows[0],
      );
      expect(seen).toEqual({ n: 2 });
      const { rows } = await owner.query(
        "SELECT household_id, metadata FROM audit_events WHERE action = 'maintenance.crypto-shred'",
      );
      expect(rows).toEqual([{ household_id: A.household, metadata: { reason: 'test' } }]);
    });
  });
});
