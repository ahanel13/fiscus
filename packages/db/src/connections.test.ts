// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, randomUUID } from 'node:crypto';
import { DecryptionError, FieldCrypto, MasterKey, MasterKeys } from '@fiscus/crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { readConnectionSecret, saveConnectionSecret } from './connection-secrets.js';
import { systemContext, withContext } from './context.js';
import { HouseholdKeyStore } from './household-key-store.js';
import { startTestDatabase, type TestDatabase } from './testing.js';

/**
 * Bank connections under row-level security (#78), with no application code: who sees a
 * connection (ACC-02, D4), who changes it and its secret, and disconnecting (ACC-03, D14).
 */

type Actor = 'A' | 'B' | 'C' | 'V' | 'D' | 'Z';
const H = randomUUID();
const X = randomUUID();
const ROLES: Record<Actor, string> = {
  A: 'owner',
  B: 'member',
  C: 'member',
  V: 'viewer',
  D: 'member', // has left the household
  Z: 'owner', // of X
};
const people = Object.fromEntries(
  (Object.keys(ROLES) as Actor[]).map((k) => [k, { user: randomUUID(), member: randomUUID() }]),
) as Record<Actor, { user: string; member: string }>;

// Connections, their owner and status, and their accounts' owners and visibility.
const conn = {
  a: randomUUID(), // A's: A's full account, and one B owns now
  aPrivate: randomUUID(), // A's: A's private account only
  aSetup: randomUUID(), // A's, still being set up: a full account
  b: randomUUID(), // B's: B's full account
  bEmpty: randomUUID(), // B's: no accounts
  gone: randomUUID(), // D's, who left: B's full account
};
const acct = {
  a: randomUUID(),
  aOfB: randomUUID(),
  aPrivate: randomUUID(),
  aSetup: randomUUID(),
  b: randomUUID(),
  gone: randomUUID(),
};
const CONNECTIONS: [string, Actor, string][] = [
  [conn.a, 'A', 'ok'],
  [conn.aPrivate, 'A', 'ok'],
  [conn.aSetup, 'A', 'setup'],
  [conn.b, 'B', 'ok'],
  [conn.bEmpty, 'B', 'login_required'],
  [conn.gone, 'D', 'error'],
];
const ACCOUNTS: [string, string, Actor, string][] = [
  [acct.a, conn.a, 'A', 'full'],
  [acct.aOfB, conn.a, 'B', 'full'],
  [acct.aPrivate, conn.aPrivate, 'A', 'private'],
  [acct.aSetup, conn.aSetup, 'A', 'full'],
  [acct.b, conn.b, 'B', 'full'],
  [acct.gone, conn.gone, 'B', 'full'],
];

describe('bank connections (RLS)', () => {
  let tdb: TestDatabase;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;

  async function as<T>(
    ctx: { household?: string; member?: string; user?: string; system?: boolean },
    fn: (q: pg.Client) => Promise<T>,
  ): Promise<T> {
    const c = ctx.system ? worker : app;
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.member_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.system', $4, true)`,
        [ctx.household ?? '', ctx.member ?? '', ctx.user ?? '', ctx.system ? 'on' : 'off'],
      );
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  }
  const asMember = <T>(a: Actor, fn: (q: pg.Client) => Promise<T>) =>
    as({ household: a === 'Z' ? X : H, member: people[a].member, user: people[a].user }, fn);
  const asWorker = <T>(fn: (q: pg.Client) => Promise<T>) => as({ household: H, system: true }, fn);
  const ids = async (q: pg.Client, sqlText: string, params: unknown[] = []) =>
    new Set((await q.query(sqlText, params)).rows.map((r) => r.id as string));
  const error = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    app = new pg.Client({ connectionString: tdb.appUrl });
    worker = new pg.Client({ connectionString: tdb.workerUrl });
    await Promise.all([owner.connect(), app.connect(), worker.connect()]);

    await owner.query(
      `INSERT INTO households (id, name, base_currency, timezone) VALUES ($1, 'H', 'USD', 'UTC'), ($2, 'X', 'USD', 'UTC')`,
      [H, X],
    );
    for (const [k, p] of Object.entries(people)) {
      await owner.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
        p.user,
        `${k.toLowerCase()}-${p.user}@connections.test`,
        k,
      ]);
      await owner.query(
        `INSERT INTO household_members (id, household_id, user_id, role, display_name, color)
         VALUES ($1, $2, $3, $4, $5, '#000')`,
        [p.member, k === 'Z' ? X : H, p.user, ROLES[k as Actor], k],
      );
    }
    for (const [id, by, status] of CONNECTIONS) {
      await owner.query(
        `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status)
         VALUES ($1, $2, $3, 'plaid', $4, $5)`,
        [id, H, people[by].member, `item-${id}`, status],
      );
    }
    for (const [id, connection, by, visibility] of ACCOUNTS) {
      await owner.query('BEGIN');
      await owner.query(
        `INSERT INTO accounts (id, household_id, connection_id, provider_account_id, name, type,
           currency, visibility, balance_mode)
         VALUES ($1, $2, $3, $4, 'acct', 'depository', 'USD', $5, 'transactions')`,
        [id, H, connection, `pa-${id}`, visibility],
      );
      await owner.query(
        `INSERT INTO account_owners (account_id, member_id, household_id, share_bps) VALUES ($1, $2, $3, 10000)`,
        [id, people[by].member, H],
      );
      await owner.query('COMMIT');
    }
    await owner.query(
      `INSERT INTO connection_secrets (connection_id, household_id, secret_enc)
       VALUES ($1, $3, '\\x01'), ($2, $3, '\\x02')`,
      [conn.a, conn.b, H],
    );
    await owner.query(`UPDATE household_members SET left_at = now() WHERE id = $1`, [
      people.D.member,
    ]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
    await tdb?.stop();
  });

  // ACC-02: its owner, and anyone who sees one of its accounts; a connection being set up, only
  // its owner (D4). Written independently of the policy.
  const VISIBLE: Record<Actor, string[]> = {
    A: [conn.a, conn.aPrivate, conn.aSetup, conn.b, conn.gone],
    B: [conn.a, conn.b, conn.bEmpty, conn.gone],
    C: [conn.a, conn.b, conn.gone],
    V: [conn.a, conn.b, conn.gone],
    D: [], // left: no valid context
    Z: [],
  };

  it.each(Object.keys(VISIBLE) as Actor[])('shows %s exactly the connections it may see', (a) =>
    asMember(a, async (q) =>
      expect(await ids(q, 'SELECT id FROM connections')).toEqual(new Set(VISIBLE[a])),
    ),
  );

  it("gives the worker the household's connections, and the app role nothing for system context", async () => {
    await asWorker(async (q) =>
      expect(await ids(q, 'SELECT id FROM connections')).toEqual(
        new Set(CONNECTIONS.map(([id]) => id)),
      ),
    );
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('app.household_id', $1, true), set_config('app.system', 'on', true)`,
        [H],
      );
      expect((await app.query('SELECT 1 FROM connections')).rowCount).toBe(0);
      expect((await app.query('SELECT 1 FROM connection_secrets')).rowCount).toBe(0);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('lets only its owner change a connection', async () => {
    for (const a of ['A', 'B', 'C', 'V'] as const) {
      await asMember(a, async (q) => {
        const changed = await ids(q, `UPDATE connections SET sync_cursor = 'x' RETURNING id`);
        const own = CONNECTIONS.filter(([, by]) => by === a).map(([id]) => id);
        expect([a, changed]).toEqual([a, new Set(own)]);
        expect((await q.query('DELETE FROM connections WHERE id = $1', [conn.gone])).rowCount).toBe(
          0,
        );
      });
    }
    await asWorker(async (q) =>
      expect((await q.query(`UPDATE connections SET sync_cursor = 'x'`)).rowCount).toBe(
        CONNECTIONS.length,
      ),
    );
  });

  it("never creates a connection for someone else, or in another household's name", async () => {
    const insert = (q: pg.Client, by: Actor, household = H) =>
      q.query(
        `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id)
         VALUES (gen_random_uuid(), $1, $2, 'simplefin', gen_random_uuid()::text)`,
        [household, people[by].member],
      );
    await asMember('B', (q) => insert(q, 'B'));
    expect(await error(() => asMember('B', (q) => insert(q, 'C')))).toMatch(/row-level security/);
    expect(await error(() => asMember('Z', (q) => insert(q, 'Z', H)))).toMatch(
      /row-level security|foreign key/,
    );
  });

  it('checks provider and status, and one connection per provider item', async () => {
    const insert = (q: pg.Client, provider: string, status: string, item = randomUUID()) =>
      q.query(
        `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [H, people.A.member, provider, item, status],
      );
    expect(await error(() => asMember('A', (q) => insert(q, 'manual', 'ok')))).toMatch(
      /connections_provider/,
    );
    expect(await error(() => asMember('A', (q) => insert(q, 'plaid', 'syncing')))).toMatch(
      /connections_status/,
    );
    expect(
      await error(() => asMember('A', (q) => insert(q, 'plaid', 'ok', `item-${conn.b}`))),
    ).toMatch(/connections_provider_item/);
  });

  // accounts.connection_id gets its foreign key a release later (upgrades §3); until then,
  // pointing an account at another household's connection shows nothing of it.
  it("shows nothing of another household's connection an account points at", async () => {
    const other = randomUUID();
    await owner.query(
      `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status)
       VALUES ($1, $2, $3, 'plaid', gen_random_uuid()::text, 'ok')`,
      [other, X, people.Z.member],
    );
    await asMember('A', async (q) => {
      await q.query('UPDATE accounts SET connection_id = $1 WHERE id = $2', [other, acct.a]);
      expect((await q.query('SELECT 1 FROM connections WHERE id = $1', [other])).rowCount).toBe(0);
    });
  });

  describe('secrets', () => {
    const SECRETS: Partial<Record<Actor, string[]>> = {
      A: [conn.a],
      B: [conn.b],
      C: [],
      V: [],
      Z: [],
    };

    it.each(Object.keys(SECRETS) as Actor[])(
      'shows %s only the secrets of connections it owns, even as a household owner',
      (a) =>
        asMember(a, async (q) =>
          expect(await ids(q, 'SELECT connection_id AS id FROM connection_secrets')).toEqual(
            new Set(SECRETS[a]),
          ),
        ),
    );

    it("lets no one else write a connection's secret", async () => {
      expect(
        await error(() =>
          asMember('A', (q) =>
            q.query(
              `INSERT INTO connection_secrets (connection_id, household_id, secret_enc) VALUES ($1, $2, '\\x03')`,
              [conn.bEmpty, H],
            ),
          ),
        ),
      ).toMatch(/row-level security/);
      await asMember('A', async (q) => {
        expect((await q.query(`UPDATE connection_secrets SET secret_enc = '\\x03'`)).rowCount).toBe(
          1,
        );
        expect((await q.query(`DELETE FROM connection_secrets`)).rowCount).toBe(1);
      });
      await asWorker(async (q) =>
        expect((await q.query('SELECT 1 FROM connection_secrets')).rowCount).toBe(2),
      );
    });

    describe('encrypted with the household key, bound to its connection', () => {
      let handle: DbHandle;
      let crypto: FieldCrypto;
      const member = (a: Actor) => ({
        householdId: H,
        memberId: people[a].member,
        userId: people[a].user,
        system: false,
      });

      beforeAll(async () => {
        const master = new MasterKeys(MasterKey.fromBase64(randomBytes(32).toString('base64'), 1));
        const workerDb = createDb(tdb.workerUrl);
        await new HouseholdKeyStore(workerDb.db, master).createForHousehold(H);
        await workerDb.close();
        handle = createDb(tdb.appUrl);
        crypto = new FieldCrypto(new HouseholdKeyStore(handle.db, master), master);
      });
      afterAll(() => handle?.close());

      it('reads back for its owner, and for no one else', async () => {
        await withContext(handle.db, member('B'), (tx) =>
          saveConnectionSecret(tx, crypto, H, conn.bEmpty, 'access-sandbox-bea'),
        );
        expect(
          await withContext(handle.db, member('B'), (tx) =>
            readConnectionSecret(tx, crypto, H, conn.bEmpty),
          ),
        ).toBe('access-sandbox-bea');
        expect(
          await withContext(handle.db, member('A'), (tx) =>
            readConnectionSecret(tx, crypto, H, conn.bEmpty),
          ),
        ).toBeNull();
        // Replaced after re-auth.
        await withContext(handle.db, member('B'), (tx) =>
          saveConnectionSecret(tx, crypto, H, conn.bEmpty, 'access-sandbox-new'),
        );
        expect(
          await withContext(handle.db, member('B'), (tx) =>
            readConnectionSecret(tx, crypto, H, conn.bEmpty),
          ),
        ).toBe('access-sandbox-new');
        const stored = await owner.query(
          `SELECT secret_enc FROM connection_secrets WHERE connection_id = $1`,
          [conn.bEmpty],
        );
        expect(stored.rows[0].secret_enc.toString('latin1')).not.toContain('access-sandbox');
      });

      it("doesn't decrypt when copied to another connection", async () => {
        await owner.query(
          `UPDATE connection_secrets SET secret_enc = (SELECT secret_enc FROM connection_secrets WHERE connection_id = $1)
           WHERE connection_id = $2`,
          [conn.bEmpty, conn.b],
        );
        await expect(
          withContext(handle.db, member('B'), (tx) => readConnectionSecret(tx, crypto, H, conn.b)),
        ).rejects.toBeInstanceOf(DecryptionError);
        // The worker reads it, as it will to sync (system context).
        const workerDb = createDb(tdb.workerUrl);
        try {
          expect(
            await withContext(workerDb.db, systemContext(H), (tx) =>
              readConnectionSecret(tx, crypto, H, conn.bEmpty),
            ),
          ).toBe('access-sandbox-new');
        } finally {
          await workerDb.close();
        }
      });
    });
  });

  describe('disconnecting (ACC-03, D14)', () => {
    const disconnect = (q: pg.Client, id: string) =>
      q.query('SELECT fiscus_disconnect_connection($1) AS accounts', [id]);

    it("lets its owner disconnect it, letting go of every account, even ones they don't own", async () => {
      await asMember('A', async (q) => {
        const { rows } = await disconnect(q, conn.a);
        expect(new Set(rows[0].accounts)).toEqual(new Set([acct.a, acct.aOfB]));
        expect(
          (
            await q.query(
              'SELECT status, disconnect_requested, next_sync_at <= now() AS due FROM connections WHERE id = $1',
              [conn.a],
            )
          ).rows,
        ).toEqual([{ status: 'disconnected', disconnect_requested: true, due: true }]);
        // The secret stays until the worker has ended it at the provider.
        expect((await q.query('SELECT 1 FROM connection_secrets')).rowCount).toBe(1);
        expect(
          (
            await q.query('SELECT connection_id, provider_account_id FROM accounts WHERE id = $1', [
              acct.a,
            ])
          ).rows,
        ).toEqual([{ connection_id: null, provider_account_id: `pa-${acct.a}` }]);
      });
      const kept = await owner.query('SELECT connection_id FROM accounts WHERE id = $1', [
        acct.aOfB,
      ]);
      expect(kept.rows[0].connection_id).toBe(conn.a); // rolled back
    });

    it('refuses anyone else while its owner is in the household', async () => {
      for (const a of ['B', 'C', 'V'] as const) {
        expect(await error(() => asMember(a, (q) => disconnect(q, conn.a)))).toMatch(
          /needs its owner/,
        );
      }
      expect(await error(() => asMember('A', (q) => disconnect(q, conn.b)))).toMatch(
        /needs its owner/,
      );
      expect(await error(() => asMember('Z', (q) => disconnect(q, conn.a)))).toMatch(
        /no such connection/,
      );
      expect(
        await error(() => as({ household: H, system: true }, (q) => disconnect(q, conn.a))),
      ).toBeUndefined();
    });

    it('lets a household owner, and only one, disconnect a connection whose owner has left', async () => {
      await asMember('A', async (q) =>
        expect((await disconnect(q, conn.gone)).rows[0].accounts).toEqual([acct.gone]),
      );
      for (const a of ['B', 'C', 'V'] as const) {
        expect(await error(() => asMember(a, (q) => disconnect(q, conn.gone)))).toMatch(
          /needs its owner/,
        );
      }
    });
  });

  describe('household Plaid keys (schema only, #83)', () => {
    const insert = (q: pg.Client, by: Actor) =>
      q.query(
        `INSERT INTO aggregation_credentials (id, household_id, provider, client_id, secret_enc, env, created_by_member_id)
         VALUES (gen_random_uuid(), $1, 'plaid', 'client', '\\x01', 'sandbox', $2)`,
        [H, people[by].member],
      );

    it('are changed only by household owners', async () => {
      await asMember('A', (q) => insert(q, 'A'));
      for (const a of ['B', 'V'] as const) {
        expect(await error(() => asMember(a, (q) => insert(q, a)))).toMatch(/row-level security/);
      }
    });
  });
});
