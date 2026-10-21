// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Instance settings (#400, migration 0035): the api and the worker read them as fiscus_app; only an
 * instance admin changes one, through fiscus_set_instance_setting().
 */
describe('instance settings', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;
  let maintenance: pg.Client;

  const admin = randomUUID();
  const disabledAdmin = randomUUID();
  const someone = randomUUID();
  const household = randomUUID();

  /** One rolled-back transaction as `client`, for `user` (and optionally inside a household). */
  async function as<T>(
    client: pg.Client,
    ctx: { user?: string; household?: string },
    fn: (q: pg.Client) => Promise<T>,
  ) {
    await client.query('BEGIN');
    try {
      await client.query(
        `SELECT set_config('app.user_id', $1, true), set_config('app.household_id', $2, true)`,
        [ctx.user ?? '', ctx.household ?? ''],
      );
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
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
  const set = (q: pg.Client, key: string, value: unknown) =>
    q.query(`SELECT fiscus_set_instance_setting($1, $2::jsonb) AS old`, [
      key,
      JSON.stringify(value),
    ]);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    worker = new pg.Client({ connectionString: tdb.workerUrl });
    maintenance = new pg.Client({ connectionString: tdb.maintenanceUrl });
    await Promise.all([owner, app, worker, maintenance].map((c) => c.connect()));
    await owner.query(
      `INSERT INTO users (id, email, display_name, is_instance_admin, disabled_at) VALUES
         ($1, 'admin@settings.test', 'Ada', true, null),
         ($2, 'gone@settings.test', 'Gil', true, now()),
         ($3, 'someone@settings.test', 'Sam', false, null)`,
      [admin, disabledAdmin, someone],
    );
    await owner.query(
      `INSERT INTO instance_settings (key, value) VALUES ('sync.intervalHours', '6'::jsonb)`,
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner, app, worker, maintenance].map((c) => c?.end()));
    await tdb?.stop();
  });

  it('is readable by the api and the worker', async () => {
    for (const client of [app, worker]) {
      const { rows } = await client.query(`SELECT key, value FROM instance_settings`);
      expect(rows).toEqual([{ key: 'sync.intervalHours', value: 6 }]);
    }
  });

  it('is not writable directly, by the api, the worker, or maintenance jobs', async () => {
    for (const client of [app, worker, maintenance]) {
      await as(client, { user: admin }, async (q) => {
        expect(
          await error(() =>
            q.query(`INSERT INTO instance_settings (key, value) VALUES ('x.y', 'true')`),
          ),
        ).toMatch(/permission denied/);
      });
      for (const statement of [
        `UPDATE instance_settings SET value = '1'`,
        `DELETE FROM instance_settings`,
        `TRUNCATE instance_settings`,
      ]) {
        await as(client, { user: admin }, async (q) => {
          expect(await error(() => q.query(statement))).toMatch(/permission denied/);
        });
      }
    }
  });

  it('lets an instance admin set one, returning what it was', async () => {
    await as(app, { user: admin }, async (q) => {
      expect((await set(q, 'sync.intervalHours', 8)).rows[0].old).toBe(6);
      expect((await set(q, 'simplefin.enabled', false)).rows[0].old).toBeNull();
      const { rows } = await q.query(
        `SELECT key, value, updated_by_user_id FROM instance_settings ORDER BY key`,
      );
      expect(rows).toEqual([
        { key: 'simplefin.enabled', value: false, updated_by_user_id: admin },
        { key: 'sync.intervalHours', value: 8, updated_by_user_id: admin },
      ]);
    });
  });

  it('refuses anyone else, a disabled admin, a household context, the worker, or a null', async () => {
    const refusals: [pg.Client, { user?: string; household?: string }][] = [
      [app, {}],
      [app, { user: someone }],
      [app, { user: disabledAdmin }],
      [app, { user: admin, household }],
      [worker, { user: admin }],
    ];
    for (const [client, ctx] of refusals) {
      await as(client, ctx, async (q) => {
        expect(await error(() => set(q, 'sync.intervalHours', 1))).toMatch(
          /needs an instance admin/,
        );
      });
    }
    await as(app, { user: admin }, async (q) => {
      expect(await error(() => set(q, 'sync.intervalHours', null))).toMatch(/needs a value/);
    });
  });
});
