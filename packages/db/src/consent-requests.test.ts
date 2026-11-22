// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Consent requests under row-level security (#265, D34), with no application code: everyone in
 * the household sees them; only you ask, as yourself; only the person asked answers, only whoever
 * asked withdraws, while it's open. After 14 days only the worker ends it, as expired. One that
 * has ended never changes again.
 */

type Actor = 'A' | 'B' | 'C';
const H = randomUUID();
const OTHER = randomUUID();
const people = Object.fromEntries(
  (['A', 'B', 'C'] as Actor[]).map((k) => [k, { user: randomUUID(), member: randomUUID() }]),
) as Record<Actor, { user: string; member: string }>;
const stranger = { user: randomUUID(), member: randomUUID() };

describe('consent requests (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;

  async function as<T>(
    a: Actor | 'worker' | 'stranger',
    fn: (q: pg.Client) => Promise<T>,
    household = H,
  ): Promise<T> {
    const q = a === 'worker' ? worker : app;
    await q.query('BEGIN');
    try {
      const p = a === 'worker' ? { member: '', user: '' } : a === 'stranger' ? stranger : people[a];
      await q.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [household, p.member, p.user, a === 'worker' ? 'on' : 'off'],
      );
      return await fn(q);
    } finally {
      await q.query('ROLLBACK');
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
  /**
   * A request from `from` to `to`, made by the owner: from `ago` days back, and already ended
   * `closedAgo` hours ago when that's given.
   */
  const request = async (from: Actor, to: Actor, ago = 0, closedAgo?: number) => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO consent_requests (id, household_id, kind, requested_by_member_id, member_id,
         created_at, expires_at, status, closed_at)
       VALUES ($1, $2, 'income_split', $3, $4, now() - make_interval(days => $5),
         now() - make_interval(days => $5) + interval '14 days',
         CASE WHEN $6::int IS NULL THEN 'pending' ELSE 'declined' END::consent_request_status,
         now() - make_interval(hours => $6::int))`,
      [id, H, people[from].member, people[to].member, ago, closedAgo ?? null],
    );
    return id;
  };
  const end = (q: pg.Client, id: string, status: string) =>
    q.query(`UPDATE consent_requests SET status = $2, closed_at = now() WHERE id = $1`, [
      id,
      status,
    ]);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    worker = new pg.Client({ connectionString: tdb.workerUrl });
    await Promise.all([owner.connect(), app.connect(), worker.connect()]);
    for (const h of [H, OTHER]) {
      await owner.query(
        `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC')`,
        [h],
      );
    }
    for (const [k, p, h] of [
      ...Object.entries(people).map(([k, p]) => [k, p, H] as const),
      ['S', stranger, OTHER] as const,
    ]) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k.toLowerCase()}-${p.user}@consent.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, 'member', $4, '#000')`,
        [p.member, h, p.user, k],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
    await tdb?.stop();
  });

  it('shows the household’s requests to everyone in it, and to nobody else', async () => {
    const id = await request('A', 'B');
    try {
      for (const a of ['A', 'B', 'C'] as const) {
        const { rows } = await as(a, (q) => q.query('SELECT id FROM consent_requests'));
        expect(rows.map((r) => r.id)).toEqual([id]);
      }
      const { rowCount } = await as(
        'stranger',
        (q) => q.query('SELECT id FROM consent_requests'),
        OTHER,
      );
      expect(rowCount).toBe(0);
      // A member of another household claiming this one sees nothing.
      expect(
        (await as('stranger', (q) => q.query('SELECT id FROM consent_requests'))).rowCount,
      ).toBe(0);
    } finally {
      await owner.query('DELETE FROM consent_requests');
    }
  });

  it('lets you ask only as yourself, never yourself, and one pending at a time', async () => {
    const insert = (q: pg.Client, from: Actor, to: Actor) =>
      q.query(
        `INSERT INTO consent_requests (id, household_id, kind, requested_by_member_id, member_id)
         VALUES (gen_random_uuid(), $1, 'income_split', $2, $3) RETURNING expires_at - created_at AS wait`,
        [H, people[from].member, people[to].member],
      );
    const made = await as('A', (q) => insert(q, 'A', 'B'));
    expect(made.rows[0].wait).toMatchObject({ days: 14 });
    expect(await as('A', (q) => error(() => insert(q, 'C', 'B')))).toMatch(/row-level security/);
    expect(await as('A', (q) => error(() => insert(q, 'A', 'A')))).toMatch(/not_yourself/);
    expect(
      await as('A', (q) =>
        error(() =>
          q.query(
            `INSERT INTO consent_requests (id, household_id, kind, requested_by_member_id,
               member_id, status, closed_at)
             VALUES (gen_random_uuid(), $1, 'income_split', $2, $3, 'accepted', now())`,
            [H, people.A.member, people.B.member],
          ),
        ),
      ),
    ).toMatch(/row-level security/);
    await request('A', 'B');
    try {
      expect(await as('C', (q) => error(() => insert(q, 'C', 'B')))).toMatch(
        /consent_requests_pending/,
      );
    } finally {
      await owner.query('DELETE FROM consent_requests');
    }
  });

  it('lets only the person asked answer, and only whoever asked withdraw', async () => {
    const id = await request('A', 'B');
    try {
      // C is neither: the row isn't theirs to change.
      expect((await as('C', (q) => end(q, id, 'declined'))).rowCount).toBe(0);
      expect(await as('A', (q) => error(() => end(q, id, 'accepted')))).toMatch(/Not yours/);
      expect(await as('B', (q) => error(() => end(q, id, 'withdrawn')))).toMatch(/Not yours/);
      expect((await as('B', (q) => end(q, id, 'declined'))).rowCount).toBe(1);
      expect((await as('B', (q) => end(q, id, 'accepted'))).rowCount).toBe(1);
      expect((await as('A', (q) => end(q, id, 'withdrawn'))).rowCount).toBe(1);
      // Nobody expires one before its 14 days are over.
      expect(await as('A', (q) => error(() => end(q, id, 'expired')))).toMatch(/Not yours/);
      expect(await as('worker', (q) => error(() => end(q, id, 'expired')))).toMatch(/Not yours/);
      // Nothing else about it changes.
      expect(
        await as('B', (q) =>
          error(() =>
            q.query(`UPDATE consent_requests SET expires_at = expires_at + interval '1 year'`),
          ),
        ),
      ).toMatch(/Only a consent request/);
      // Nobody deletes one.
      expect((await as('A', (q) => q.query('DELETE FROM consent_requests'))).rowCount).toBe(0);
    } finally {
      await owner.query('DELETE FROM consent_requests');
    }
  });

  it('after 14 days, only the worker ends it, and an ended one never changes', async () => {
    const id = await request('A', 'B', 15);
    try {
      expect(await as('B', (q) => error(() => end(q, id, 'accepted')))).toMatch(/Not yours/);
      expect(await as('A', (q) => error(() => end(q, id, 'withdrawn')))).toMatch(/Not yours/);
      expect(await as('A', (q) => error(() => end(q, id, 'expired')))).toMatch(/Not yours/);
      await as('worker', async (q) => {
        expect((await end(q, id, 'expired')).rowCount).toBe(1);
        expect(await error(() => end(q, id, 'pending'))).toMatch(/has ended/);
      });
      const ended = await request('A', 'C', 3, 1);
      expect(await as('A', (q) => error(() => end(q, ended, 'withdrawn')))).toMatch(/has ended/);
      expect(await as('C', (q) => error(() => end(q, ended, 'accepted')))).toMatch(/has ended/);
    } finally {
      await owner.query('DELETE FROM consent_requests');
    }
  });

  it('tells the worker which households have requests to look at, and nobody else', async () => {
    await request('A', 'B');
    const since = (await owner.query(`SELECT now() - interval '1 hour' AS t`)).rows[0].t;
    const households = (q: pg.Client) =>
      q
        .query('SELECT household_id FROM fiscus_consent_request_households($1)', [since])
        .then((r) => r.rows.map((x) => x.household_id));
    try {
      expect(await households(worker)).toEqual([H]);
      expect(await households(app)).toEqual([]);
      await owner.query('DELETE FROM consent_requests');
      // Ended within the window: still worth a look, to tell whoever asked.
      await request('A', 'B', 1, 0);
      expect(await households(worker)).toEqual([H]);
      await owner.query('DELETE FROM consent_requests');
      await request('A', 'B', 1, 2);
      expect(await households(worker)).toEqual([]);
    } finally {
      await owner.query('DELETE FROM consent_requests');
    }
  });
});
