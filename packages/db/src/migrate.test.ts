// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
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
       WHERE rolname IN ('fiscus_app', 'fiscus_maintenance') ORDER BY rolname`,
    );
    expect(rows).toEqual([
      { rolname: 'fiscus_app', rolcanlogin: true, rolbypassrls: false },
      { rolname: 'fiscus_maintenance', rolcanlogin: true, rolbypassrls: true },
    ]);
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
