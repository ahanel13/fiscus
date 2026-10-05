// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

describe('createDb', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await startTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await tdb?.stop();
  });

  it('survives the server dropping idle connections, then reconnects', async () => {
    const errors: Error[] = [];
    const handle = createDb(tdb.appUrl, { onIdleError: (err) => errors.push(err) });
    try {
      await handle.pool.query('SELECT 1'); // leaves an idle client in the pool

      const admin = new pg.Client({ connectionString: tdb.ownerUrl });
      await admin.connect();
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'fiscus_app'",
      );
      await admin.end();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(errors.length).toBeGreaterThan(0);
      const { rows } = await handle.pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await handle.close();
    }
  });
});
