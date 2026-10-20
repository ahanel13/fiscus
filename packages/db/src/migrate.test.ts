// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

const query = async (url: string, sql: string) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
};

describe('migrations', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await startTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await tdb?.stop();
  });

  it('creates the service roles with the right attributes', async () => {
    const rows = await query(
      tdb.ownerUrl,
      `SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles
       WHERE rolname IN ('fiscus_app', 'fiscus_worker', 'fiscus_maintenance', 'fiscus_steward')
       ORDER BY rolname`,
    );
    expect(rows).toEqual([
      { rolname: 'fiscus_app', rolcanlogin: true, rolbypassrls: false },
      { rolname: 'fiscus_maintenance', rolcanlogin: true, rolbypassrls: true },
      { rolname: 'fiscus_steward', rolcanlogin: false, rolbypassrls: true },
      { rolname: 'fiscus_worker', rolcanlogin: true, rolbypassrls: false },
    ]);
  });

  // A dump doesn't carry role memberships, so a restore into a fresh server loses this one.
  it("gives the worker the app's privileges again on every run (#271)", async () => {
    const member = `SELECT pg_has_role('fiscus_worker', 'fiscus_app', 'MEMBER') AS m`;
    await query(tdb.ownerUrl, 'REVOKE fiscus_app FROM fiscus_worker');
    expect(await query(tdb.ownerUrl, member)).toEqual([{ m: false }]);
    await runMigrations(tdb.ownerUrl);
    expect(await query(tdb.ownerUrl, member)).toEqual([{ m: true }]);
  });

  it('is idempotent and safe to run concurrently', async () => {
    await expect(
      Promise.all([runMigrations(tdb.ownerUrl), runMigrations(tdb.ownerUrl)]),
    ).resolves.toBeDefined();
  });

  it('grants the app role DML on tables the owner creates later, but not DDL', async () => {
    await query(tdb.ownerUrl, 'CREATE TABLE probe (id int PRIMARY KEY)');
    await query(tdb.appUrl, 'INSERT INTO probe VALUES (1)');
    expect(await query(tdb.appUrl, 'SELECT id FROM probe')).toEqual([{ id: 1 }]);
    await expect(query(tdb.appUrl, 'CREATE TABLE nope (id int)')).rejects.toThrow(
      /permission denied/,
    );
    await query(tdb.ownerUrl, 'DROP TABLE probe');
  });
});

/**
 * Test databases are empty, so a migration that only fails on real rows passes every other test.
 * (0018 did: its backfill queued deferred trigger events, and creating an index after that fails
 * with "pending trigger events".) This stops partway, adds rows like a household's, and applies
 * the rest. Extend the seed when a migration touches tables it doesn't fill.
 */
describe('migrations on a database with data in it', () => {
  const SEEDED_AT = 17; // the last migration applied before seeding (0017_imports_rls)
  let container: StartedPostgreSqlContainer;
  let folder: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('fiscus')
      .withUsername('fiscus_owner')
      .withPassword('test-owner-password')
      .start();
    folder = mkdtempSync(join(tmpdir(), 'fiscus-migrations-'));
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((e) => e.idx <= SEEDED_AT);
    writeFileSync(journalPath, JSON.stringify(journal));
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('applies later migrations to a household with accounts, imports, and transactions', async () => {
    const url = container.getConnectionUri();
    await runMigrations(url, { migrationsFolder: folder });
    const [h, u, m, a, b, t] = Array.from({ length: 6 }, () => randomUUID());
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(
        `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
        [h],
      );
      await db.query(`INSERT INTO users (id, email, display_name) VALUES ($1, 'a@x.test', 'A')`, [
        u,
      ]);
      await db.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, 'owner', 'A', '#000')`,
        [m, h, u],
      );
      await db.query(
        `INSERT INTO accounts (id, household_id, name, type, currency, visibility, balance_mode)
         VALUES ($1, $2, 'Checking', 'depository', 'USD', 'full', 'transactions')`,
        [a, h],
      );
      await db.query(
        `INSERT INTO account_owners (account_id, member_id, household_id, share_bps)
         VALUES ($1, $2, $3, 10000)`,
        [a, m, h],
      );
      await db.query(
        `INSERT INTO import_batches (id, household_id, account_id, member_id, run_id, format,
           filename, transaction_count, balance_count, mapping)
         VALUES ($1, $2, $3, $4, $1, 'csv', 'bank.csv', 1, 0, '{"categories":{},"members":{}}')`,
        [b, h, a, m],
      );
      await db.query(
        `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency,
           authorized_date, posted_date, original_description, display_name, source,
           import_batch_id, dedupe_key)
         VALUES ($1, $2, $3, -450, 'USD', '2026-01-02', '2026-01-02', 'COFFEE', 'Coffee',
           'import', $4, 'x:1')`,
        [t, h, a, b],
      );
      await db.query('COMMIT');

      await runMigrations(url);

      const { rows } = await db.query(`SELECT import_account_id FROM transactions WHERE id = $1`, [
        t,
      ]);
      expect(rows).toEqual([{ import_account_id: a }]);
    } finally {
      await db.end();
    }
  }, 120_000);
});
