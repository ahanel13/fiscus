// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

describe('audit_events', () => {
  let tdb: TestDatabase;
  let app: pg.Client;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = new pg.Client({ connectionString: tdb.appUrl });
    await app.connect();
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    await tdb?.stop();
  });

  it('is append-only for the app role', async () => {
    await app.query(
      "INSERT INTO audit_events (actor_kind, action) VALUES ('system', 'test.event')",
    );
    expect((await app.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n).toBe(1);
    await expect(app.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query('DELETE FROM audit_events')).rejects.toThrow(/permission denied/);
    await expect(app.query('TRUNCATE audit_events')).rejects.toThrow(/permission denied/);
  });

  it('keeps the hash format columns (#264) as append-only as the rest', async () => {
    for (const set of ['hash_version = 2', "leaf = '\\x00'", 'hash_version = 1, leaf = NULL']) {
      await expect(app.query(`UPDATE audit_events SET ${set}`)).rejects.toThrow(
        /permission denied/,
      );
    }
    const { rows } = await app.query(`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_name = 'audit_events' AND grantee = 'fiscus_app' AND privilege_type = 'UPDATE'`);
    expect(rows).toEqual([]);
  });

  it('has a leaf exactly when an entry is version 2', async () => {
    // Version 1 is what the previous release writes, without naming the column.
    const { rows } = await app.query(
      "INSERT INTO audit_events (actor_kind, action) VALUES ('system', 'v1') RETURNING hash_version, leaf",
    );
    expect(rows).toEqual([{ hash_version: 1, leaf: null }]);
    const insert = (version: number, leaf: string | null, seq: number | null) =>
      app.query(
        `INSERT INTO audit_events (actor_kind, action, hash_version, leaf, seq, entry_hash)
         VALUES ('system', 'x', $1, $2, $3, '\\x00')`,
        [version, leaf === null ? null : Buffer.from(leaf, 'hex'), seq],
      );
    await expect(insert(2, null, 900)).rejects.toThrow(/audit_events_hash_version/);
    await expect(insert(2, '00', 901)).rejects.toThrow(/audit_events_hash_version/);
    await expect(insert(1, '00'.repeat(32), 902)).rejects.toThrow(/audit_events_hash_version/);
    await expect(insert(3, '00'.repeat(32), 903)).rejects.toThrow(/audit_events_hash_version/);
    await expect(insert(2, '00'.repeat(32), null)).rejects.toThrow(/audit_events_hash_version/);
    await expect(insert(2, '00'.repeat(32), 904)).resolves.toBeDefined();
  });
});
