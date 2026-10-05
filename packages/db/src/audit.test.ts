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
});
