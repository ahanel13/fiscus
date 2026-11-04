// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Notifications under row-level security (migration 0079), with no application code: a member's
 * channels, preferences, notifications and their deliveries are theirs alone (D15, HH-10), the
 * worker reads and writes them in system context, and its queues answer only the worker.
 */

const H = randomUUID();
const X = randomUUID();
const people = {
  A: { user: randomUUID(), member: randomUUID(), household: H, role: 'owner' },
  B: { user: randomUUID(), member: randomUUID(), household: H, role: 'member' },
  Z: { user: randomUUID(), member: randomUUID(), household: X, role: 'owner' },
};
type Who = keyof typeof people;

describe('notifications (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;
  const ids = { aNote: randomUUID(), bNote: randomUUID(), zNote: randomUUID() };

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
  const asWorker = <T>(household: string, fn: (q: pg.Client) => Promise<T>) =>
    as({ household, system: true }, fn);
  const rows = async (q: pg.Client, text: string, params: unknown[] = []) =>
    (await q.query(text, params)).rows;
  const error = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };
  const insertNote = (q: pg.Client, id: string, household: string, member: string, key = id) =>
    q.query(
      `INSERT INTO notifications (id, household_id, member_id, kind, dedupe_key, title, body, summary)
       VALUES ($1, $2, $3, 'connection_needs_you', $4, 't', 'b', 's')
       ON CONFLICT (member_id, dedupe_key) DO NOTHING RETURNING id`,
      [id, household, member, key],
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
        `${k.toLowerCase()}-${p.user}@notifications.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, $5, '#000')`,
        [p.member, p.household, p.user, p.role, k],
      );
      await owner.query(
        `INSERT INTO notification_channels (id, household_id, member_id, kind, detail, settings,
           secret_enc)
         VALUES (gen_random_uuid(), $1, $2, 'ntfy', 'full', '{}', '\\x00')`,
        [p.household, p.member],
      );
      await owner.query(
        `INSERT INTO notification_preferences (household_id, member_id, kind, channels)
         VALUES ($1, $2, 'bill_due', ARRAY['in_app'])`,
        [p.household, p.member],
      );
    }
    await insertNote(owner, ids.aNote, H, people.A.member);
    await insertNote(owner, ids.bNote, H, people.B.member);
    await insertNote(owner, ids.zNote, X, people.Z.member);
    await owner.query(
      `INSERT INTO notification_deliveries (id, household_id, notification_id, channel)
       VALUES (gen_random_uuid(), $1, $2, 'email'), (gen_random_uuid(), $1, $3, 'email'),
              (gen_random_uuid(), $4, $5, 'email')`,
      [H, ids.aNote, ids.bNote, X, ids.zNote],
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
    await tdb?.stop();
  });

  const OWN_TABLES = ['notification_channels', 'notification_preferences', 'notifications'];

  it('shows a member only their own, household owners included', async () => {
    for (const who of ['A', 'B'] as const) {
      await asMember(who, async (q) => {
        for (const t of OWN_TABLES) {
          expect(
            (await rows(q, `SELECT member_id FROM ${t}`)).map((r) => r.member_id),
            `${who} on ${t}`,
          ).toEqual([people[who].member]);
        }
        const deliveries = await rows(q, 'SELECT notification_id FROM notification_deliveries');
        expect(deliveries.map((r) => r.notification_id)).toEqual([
          who === 'A' ? ids.aNote : ids.bNote,
        ]);
      });
    }
  });

  it('lets nobody change, remove or write another member’s', async () => {
    await asMember('B', async (q) => {
      for (const t of OWN_TABLES) {
        const column = t === 'notifications' ? 'read_at' : 'updated_at';
        const changed = await q.query(`UPDATE ${t} SET ${column} = now() WHERE member_id = $1`, [
          people.A.member,
        ]);
        expect(changed.rowCount, t).toBe(0);
        const removed = await q.query(`DELETE FROM ${t} WHERE member_id = $1`, [people.A.member]);
        expect(removed.rowCount, t).toBe(0);
      }
    });
    await asMember('B', async (q) => {
      expect(await error(() => insertNote(q, randomUUID(), H, people.A.member))).toMatch(
        /row-level security/,
      );
    });
    await asMember('B', async (q) => {
      expect(
        await error(() =>
          q.query(
            `INSERT INTO notification_channels (id, household_id, member_id, kind)
             VALUES (gen_random_uuid(), $1, $2, 'gotify')`,
            [H, people.A.member],
          ),
        ),
      ).toMatch(/row-level security/);
    });
  });

  it('lets a member write their own notification (a test), but no deliveries', async () => {
    await asMember('A', async (q) => {
      expect((await insertNote(q, randomUUID(), H, people.A.member)).rowCount).toBe(1);
      expect(
        await error(() =>
          q.query(
            `INSERT INTO notification_deliveries (id, household_id, notification_id, channel)
             VALUES (gen_random_uuid(), $1, $2, 'ntfy')`,
            [H, ids.aNote],
          ),
        ),
      ).toMatch(/row-level security/);
    });
    await asMember('A', async (q) => {
      const changed = await q.query(`UPDATE notification_deliveries SET status = 'sent'`);
      expect(changed.rowCount).toBe(0);
    });
  });

  it('keeps households apart, even for the worker', async () => {
    await asWorker(H, async (q) => {
      const seen = await rows(q, 'SELECT id FROM notifications ORDER BY id');
      expect(seen.map((r) => r.id).sort()).toEqual([ids.aNote, ids.bNote].sort());
      expect(await rows(q, 'SELECT 1 FROM notification_deliveries')).toHaveLength(2);
      expect(await rows(q, 'SELECT 1 FROM notification_channels')).toHaveLength(2);
    });
    // A forged context: A's member claiming household X.
    await as({ household: X, member: people.A.member, user: people.A.user }, async (q) => {
      for (const t of [...OWN_TABLES, 'notification_deliveries']) {
        expect(await rows(q, `SELECT 1 FROM ${t}`), t).toEqual([]);
      }
    });
  });

  it('writes a notification once per member and key (D20)', async () => {
    await asWorker(H, async (q) => {
      expect((await insertNote(q, randomUUID(), H, people.A.member, 'once')).rowCount).toBe(1);
      expect((await insertNote(q, randomUUID(), H, people.A.member, 'once')).rowCount).toBe(0);
      // The same key for someone else is theirs.
      expect((await insertNote(q, randomUUID(), H, people.B.member, 'once')).rowCount).toBe(1);
    });
  });

  it('answers the queues only for the worker, and leases each delivery to one claim', async () => {
    const unrouted = 'SELECT notification_id FROM fiscus_unrouted_notifications(100)';
    const claim = `SELECT delivery_id FROM fiscus_claim_notification_deliveries(100, '1 minute')`;
    await asMember('A', async (q) => {
      expect(await rows(q, unrouted)).toEqual([]);
      expect(await rows(q, claim)).toEqual([]);
    });
    expect((await worker.query(unrouted)).rows).toHaveLength(3);
    expect((await worker.query(claim)).rows).toHaveLength(3);
    // Leased: a second claim gets nothing until the lease runs out.
    expect((await worker.query(claim)).rows).toEqual([]);
    await owner.query(`UPDATE notification_deliveries SET lease_until = now() - interval '1 s'`);
    // Not a disabled household's.
    await owner.query(`UPDATE households SET status = 'disabled' WHERE id = $1`, [X]);
    expect((await worker.query(claim)).rows).toHaveLength(2);
    expect((await worker.query(unrouted)).rows).toHaveLength(2);
    await owner.query(`UPDATE households SET status = 'active' WHERE id = $1`, [X]);
  });

  it('refuses rules with a channel that doesn’t exist', async () => {
    await asMember('A', async (q) => {
      expect(
        await error(() =>
          q.query(
            `INSERT INTO notification_preferences (household_id, member_id, kind, channels)
             VALUES ($1, $2, 'late', ARRAY['sms'])`,
            [H, people.A.member],
          ),
        ),
      ).toMatch(/notification_preferences_channels/);
    });
  });
});
