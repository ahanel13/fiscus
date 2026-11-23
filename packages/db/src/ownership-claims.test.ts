// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Ownership claims under row-level security and their trigger (migration 0116), with no
 * application code (#267, ADR 0012 §Departures item 7): who may take each step, and when.
 */

const H = randomUUID();
const X = randomUUID();
const people = {
  A: { user: randomUUID(), member: randomUUID(), household: H, role: 'owner' },
  O: { user: randomUUID(), member: randomUUID(), household: H, role: 'owner' },
  B: { user: randomUUID(), member: randomUUID(), household: H, role: 'member' },
  C: { user: randomUUID(), member: randomUUID(), household: H, role: 'member' },
  V: { user: randomUUID(), member: randomUUID(), household: H, role: 'viewer' },
  Z: { user: randomUUID(), member: randomUUID(), household: X, role: 'owner' },
};
type Who = keyof typeof people;

describe('ownership claims (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;

  async function as<T>(
    ctx: { household: string; member?: string; user?: string; system?: boolean },
    fn: (q: pg.Client) => Promise<T>,
  ): Promise<T> {
    const c = ctx.system ? worker : app;
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [ctx.household, ctx.member ?? '', ctx.user ?? '', ctx.system ? 'on' : 'off'],
      );
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  }
  const asMember = <T>(who: Who, fn: (q: pg.Client) => Promise<T>) =>
    as(
      { household: people[who].household, member: people[who].member, user: people[who].user },
      fn,
    );
  const asWorker = <T>(fn: (q: pg.Client) => Promise<T>) => as({ household: H, system: true }, fn);
  const error = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };
  const claim = (q: pg.Client, who: Who, extra = '') =>
    q.query(
      `INSERT INTO ownership_claims (id, household_id, claimant_member_id${extra ? ', ends_at' : ''})
       VALUES (gen_random_uuid(), $1, $2${extra ? `, ${extra}` : ''}) RETURNING *`,
      [people[who].household, people[who].member],
    );
  const ownersAway = (days: number) =>
    owner.query(
      `UPDATE users SET last_active_at = now() - make_interval(days => $1::int) WHERE id = ANY($2)`,
      [days, [people.A.user, people.O.user]],
    );
  /** A claim by B, made directly (no trigger), opened `daysAgo` days ago. */
  const existing = async (daysAgo: number, status = 'open') => {
    const id = randomUUID();
    await owner.query('SET session_replication_role = replica');
    try {
      await owner.query(
        `INSERT INTO ownership_claims (id, household_id, claimant_member_id, status, created_at,
           ends_at, closed_at, cancel_reason)
         VALUES ($1, $2, $3, $4::ownership_claim_status, now() - make_interval(days => $5::int),
           now() - make_interval(days => $5::int) + interval '30 days',
           CASE WHEN $4::text = 'open' THEN NULL ELSE now() END,
           CASE WHEN $4::text = 'cancelled' THEN 'owner_returned' END)`,
        [id, H, people.B.member, status, daysAgo],
      );
    } finally {
      await owner.query('SET session_replication_role = origin');
    }
    return id;
  };
  const end = (q: pg.Client, id: string, status: string, by: string | null, reason?: string) =>
    q.query(
      `UPDATE ownership_claims SET status = $2, closed_by_member_id = $3, cancel_reason = $4
       WHERE id = $1 RETURNING *`,
      [id, status, by, reason ?? null],
    );

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    worker = new pg.Client({ connectionString: tdb.workerUrl });
    await Promise.all([owner.connect(), app.connect(), worker.connect()]);
    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone)
       VALUES ($1, 'H', 'USD', 'UTC'), ($2, 'X', 'USD', 'UTC')`,
      [H, X],
    );
    for (const [k, p] of Object.entries(people)) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k.toLowerCase()}-${p.user}@claims.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, $5, '#000')`,
        [p.member, p.household, p.user, p.role, k],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
    await tdb?.stop();
  });

  it('starts only once every owner has been away for 30 days', async () => {
    await ownersAway(0);
    expect(await asMember('B', (q) => error(() => claim(q, 'B')))).toMatch(/last 30 days/);
    // One owner away isn't enough.
    await owner.query(
      `UPDATE users SET last_active_at = now() - interval '40 days' WHERE id = $1`,
      [people.A.user],
    );
    expect(await asMember('B', (q) => error(() => claim(q, 'B')))).toMatch(/last 30 days/);
    await ownersAway(29);
    expect(await asMember('B', (q) => error(() => claim(q, 'B')))).toMatch(/last 30 days/);
    await ownersAway(31);
    const row = await asMember('B', async (q) => (await claim(q, 'B')).rows[0]);
    expect(row.status).toBe('open');
  });

  it('sets the 30 days itself, and only a member claims, as themselves', async () => {
    await ownersAway(31);
    // An earlier end is replaced with 30 days.
    const row = await asMember('B', async (q) => (await claim(q, 'B', `now()`)).rows[0]);
    expect(row.ends_at.getTime() - row.created_at.getTime()).toBe(30 * 24 * 60 * 60_000);
    for (const who of ['A', 'V'] as const) {
      expect(await asMember(who, (q) => error(() => claim(q, who)))).toMatch(/as themselves/);
    }
    // Not for someone else.
    expect(
      await asMember('C', (q) =>
        error(() =>
          q.query(
            `INSERT INTO ownership_claims (id, household_id, claimant_member_id)
             VALUES (gen_random_uuid(), $1, $2)`,
            [H, people.B.member],
          ),
        ),
      ),
    ).toMatch(/as themselves/);
    expect(await asWorker((q) => error(() => claim(q, 'B')))).toMatch(/as themselves/);
  });

  it('keeps one claim open at a time', async () => {
    await ownersAway(31);
    const id = await existing(1);
    try {
      expect(await asMember('C', (q) => error(() => claim(q, 'C')))).toMatch(
        /ownership_claims_open/,
      );
    } finally {
      await owner.query('DELETE FROM ownership_claims WHERE id = $1', [id]);
    }
  });

  it('is rejected by any owner, withdrawn only by the claimant', async () => {
    const id = await existing(1);
    try {
      const deny = (who: Who, status: string, by: Who) =>
        asMember(who, (q) => error(() => end(q, id, status, people[by].member)));
      expect(await deny('B', 'rejected', 'B')).toMatch(/Not yours/);
      expect(await deny('V', 'rejected', 'V')).toMatch(/Not yours/);
      expect(await deny('A', 'rejected', 'O')).toMatch(/Not yours/);
      expect(await deny('C', 'withdrawn', 'C')).toMatch(/Not yours/);
      expect(await deny('A', 'withdrawn', 'A')).toMatch(/Not yours/);
      // Members can't end it as the worker would.
      expect(
        await asMember('A', (q) => error(() => end(q, id, 'cancelled', null, 'owner_returned'))),
      ).toMatch(/Not yours/);
      expect(await asMember('B', (q) => error(() => end(q, id, 'granted', null)))).toMatch(
        /Not yours/,
      );
      for (const who of ['A', 'O'] as const) {
        const row = await asMember(
          who,
          async (q) => (await end(q, id, 'rejected', people[who].member)).rows[0],
        );
        expect(row).toMatchObject({ status: 'rejected', closed_by_member_id: people[who].member });
        expect(row.closed_at).toBeInstanceOf(Date);
      }
      const row = await asMember(
        'B',
        async (q) => (await end(q, id, 'withdrawn', people.B.member)).rows[0],
      );
      expect(row.status).toBe('withdrawn');
      // Nor can the worker reject it.
      expect(await asWorker((q) => error(() => end(q, id, 'rejected', people.A.member)))).toMatch(
        /Not yours/,
      );
    } finally {
      await owner.query('DELETE FROM ownership_claims WHERE id = $1', [id]);
    }
  });

  it('is granted by the worker only once its 30 days are over, and cancelled any time', async () => {
    const fresh = await existing(29);
    try {
      expect(await asWorker((q) => error(() => end(q, fresh, 'granted', null)))).toMatch(
        /Not yours/,
      );
      const cancelled = await asWorker(
        async (q) => (await end(q, fresh, 'cancelled', null, 'owner_returned')).rows[0],
      );
      expect(cancelled.status).toBe('cancelled');
    } finally {
      await owner.query('DELETE FROM ownership_claims WHERE id = $1', [fresh]);
    }
    const due = await existing(31);
    try {
      const granted = await asWorker(async (q) => (await end(q, due, 'granted', null)).rows[0]);
      expect(granted.status).toBe('granted');
    } finally {
      await owner.query('DELETE FROM ownership_claims WHERE id = $1', [due]);
    }
  });

  it('never changes once ended, and nothing deletes one', async () => {
    const id = await existing(3, 'cancelled');
    try {
      expect(
        await asMember('B', (q) => error(() => end(q, id, 'withdrawn', people.B.member))),
      ).toMatch(/has ended/);
      expect(await asWorker((q) => error(() => end(q, id, 'granted', null)))).toMatch(/has ended/);
      const remove = (q: pg.Client) => q.query('DELETE FROM ownership_claims WHERE id = $1', [id]);
      expect((await asMember('A', remove)).rowCount).toBe(0);
      expect((await asWorker(remove)).rowCount).toBe(0);
    } finally {
      await owner.query('DELETE FROM ownership_claims WHERE id = $1', [id]);
    }
  });

  it('is visible to its household only, and its households to the worker only', async () => {
    const id = await existing(1);
    try {
      for (const who of ['A', 'B', 'V'] as const) {
        const { rows } = await asMember(who, (q) => q.query('SELECT id FROM ownership_claims'));
        expect(rows.map((r) => r.id)).toEqual([id]);
      }
      const { rows } = await asMember('Z', (q) => q.query('SELECT id FROM ownership_claims'));
      expect(rows).toEqual([]);
      const since = new Date(Date.now() - 60_000).toISOString();
      const ask = (c: pg.Client) =>
        c.query('SELECT household_id FROM fiscus_ownership_claim_households($1)', [since]);
      expect((await ask(worker)).rows).toEqual([{ household_id: H }]);
      expect((await ask(app)).rows).toEqual([]);
    } finally {
      await owner.query('DELETE FROM ownership_claims WHERE id = $1', [id]);
    }
  });
});
