// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { systemContext, withContext } from './context.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

describe('withContext', () => {
  let tdb: TestDatabase;
  let handle: DbHandle;

  const settings = async (exec: { execute: DbHandle['db']['execute'] }) => {
    const res = await exec.execute(sql`
      SELECT current_setting('app.household_id', true) AS household,
             current_setting('app.member_id', true) AS member,
             current_setting('app.user_id', true) AS "user",
             current_setting('app.system', true) AS system`);
    return res.rows[0];
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    handle = createDb(tdb.appUrl, { max: 1 }); // one connection proves nothing leaks across uses
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    await tdb?.stop();
  });

  it('sets the context for the transaction only', async () => {
    const ctx = {
      householdId: randomUUID(),
      memberId: randomUUID(),
      userId: randomUUID(),
      system: false,
    };
    const inside = await withContext(handle.db, ctx, (tx) => settings(tx));
    expect(inside).toEqual({
      household: ctx.householdId,
      member: ctx.memberId,
      user: ctx.userId,
      system: 'off',
    });
    // Same pooled connection afterwards: nothing left behind.
    const after = await settings(handle.db);
    expect(after?.household ?? '').toBe('');
    expect(after?.member ?? '').toBe('');
  });

  it('marks system context and clears member/user', async () => {
    const id = randomUUID();
    expect(await withContext(handle.db, systemContext(id), (tx) => settings(tx))).toEqual({
      household: id,
      member: '',
      user: '',
      system: 'on',
    });
  });

  it('does not leak context when the transaction fails', async () => {
    await expect(
      withContext(handle.db, systemContext(randomUUID()), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await settings(handle.db))?.household ?? '').toBe('');
  });
});
