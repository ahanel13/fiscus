// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HouseholdAccess } from './households/household-access.js';
import { createTestApp, TestClient } from './testing/test-app.js';

/**
 * Generated from the route table (ADR 0005, permissions §7): every household route is called from
 * household A's session with household B's ids and must answer 404. New routes are covered
 * automatically; a new kind of path parameter fails the suite until it gets a filler below.
 */
const SECRET_NAME = 'Bob household (secret)';
const SECRET_ACCOUNT = 'Bob savings (secret)';
const SECRET_TAG = 'Bob tag (secret)';
const SECRET_INSTITUTION = 'Bob bank (secret)';
/** Path parameters that aren't ids: the same value in every household. */
const FIXED: Record<string, string> = {
  date: '2026-01-01',
  kind: 'shared',
  key: 'range:reports',
  month: new Date().toISOString().slice(0, 7),
  year: new Date().toISOString().slice(0, 4),
};

describe('cross-tenant isolation (generated from routes)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let alice: TestClient; // owner of A
  let bob: TestClient; // owner of B
  const ids = { a: {} as Record<string, string>, b: {} as Record<string, string> };

  const signup = async (name: string) => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: `${name}@tenant.test`,
      password: 'tenant test Password1!',
      displayName: name,
    });
    return c;
  };
  const household = async (c: TestClient, name: string) =>
    (await c.post('/api/v1/households', { name, baseCurrency: 'USD', timezone: 'UTC' })).body.data;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    alice = await signup('alice');
    bob = await signup('bob');
    const carol = await signup('carol');

    const a = await household(alice, 'A');
    const b = await household(bob, SECRET_NAME);
    ids.a = { householdId: a.id, memberId: a.you.memberId };
    ids.b = { householdId: b.id, memberId: b.you.memberId };

    const inviteA = await alice.post(`/api/v1/households/${a.id}/invites`, {
      email: 'x@tenant.test',
    });
    const inviteB = await bob.post(`/api/v1/households/${b.id}/invites`, {
      email: 'carol@tenant.test',
    });
    ids.a.inviteId = inviteA.body.data.invite.id;
    ids.b.inviteId = inviteB.body.data.invite.id;
    const account = async (c: TestClient, householdId: string, name: string) =>
      (
        await c.post(`/api/v1/households/${householdId}/accounts`, {
          name,
          type: 'depository',
          openingBalance: { amountMinor: 123456, asOf: '2026-01-01' },
        })
      ).body.data.id as string;
    ids.a.accountId = await account(alice, a.id, 'A checking');
    ids.b.accountId = await account(bob, b.id, SECRET_ACCOUNT);
    // Ledger fixtures: a transaction, a category (and its group), and a tag in each household.
    const ledger = async (c: TestClient, householdId: string, accountId: string, tag: string) => {
      const base = `/api/v1/households/${householdId}`;
      const groups = (await c.get(`${base}/categories`)).body.data;
      const custom = (await c.post(`${base}/categories`, { name: 'Custom', groupId: groups[0].id }))
        .body.data;
      const txn = (
        await c.post(`${base}/transactions`, {
          accountId,
          amountMinor: -4200,
          date: '2026-01-02',
          displayName: tag,
        })
      ).body.data;
      const t = (await c.post(`${base}/tags`, { name: tag, color: '#2f6fdb' })).body.data;
      const run = (
        await c.post(`${base}/imports`, {
          format: 'csv',
          filename: 'bank.csv',
          accounts: [{ key: 'file', accountId }],
        })
      ).body.data;
      await c.post(`${base}/imports/${run.batches[0].batchId}/rows`, {
        transactions: [{ line: 2, date: '2026-01-03', amountMinor: -1, description: tag }],
      });
      const profile = (
        await c.post(`${base}/import-profiles`, {
          name: tag,
          headers: ['date', 'amount', 'memo'],
          mapping: {
            date: 'date',
            dateFormat: 'ymd',
            amount: { kind: 'signed', column: 'amount', negate: false },
            decimal: '.',
            description: 'memo',
          },
        })
      ).body.data;
      const rule = (
        await c.post(`${base}/rules`, {
          name: tag,
          conditions: { description: { op: 'contains', value: tag } },
          actions: { markReviewed: true },
        })
      ).body.data;
      // A split rule not yet started, so cancelling it would work if anything leaked (#109).
      const { earliestMonth } = (await c.get(`${base}/split-rules`)).body.data;
      const [year, month] = (earliestMonth as string).split('-').map(Number) as [number, number];
      const splitRule = (
        await c.request('PUT', `${base}/split-rules/categories/${custom.id}`, {
          rule: { method: 'equal' },
          effectiveFrom: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
        })
      ).body.data;
      const budget = (await c.post(`${base}/budgets`, { amounts: [] })).body.data;
      return {
        ruleId: rule.id,
        splitRuleId: splitRule.id,
        budgetId: budget.id,
        transactionId: txn.id,
        categoryId: custom.id,
        groupId: groups[0].id,
        tagId: t.id,
        batchId: run.batches[0].batchId,
        runId: run.runId,
        profileId: profile.id,
      };
    };
    Object.assign(ids.a, await ledger(alice, a.id, ids.a.accountId, 'A tag'));
    Object.assign(ids.b, await ledger(bob, b.id, ids.b.accountId, SECRET_TAG));
    // A bank connection behind each household's account (the link flow is #79's).
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      for (const [x, name] of [
        [ids.a, 'A bank'],
        [ids.b, SECRET_INSTITUTION],
      ] as const) {
        const institution = crypto.randomUUID();
        await db.query(
          `INSERT INTO institutions (id, provider, provider_institution_id, name)
           VALUES ($1, 'plaid', gen_random_uuid()::text, $2)`,
          [institution, name],
        );
        x.connectionId = crypto.randomUUID();
        await db.query(
          `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id,
             status, institution_id)
           VALUES ($1, $2, $3, 'plaid', $4, 'ok', $5)`,
          [x.connectionId, x.householdId, x.memberId, `item-${x.connectionId}`, institution],
        );
        await db.query('UPDATE accounts SET connection_id = $1 WHERE id = $2', [
          x.connectionId,
          x.accountId,
        ]);
        // A synced transaction held as a possible duplicate (#80).
        x.holdId = (
          await db.query(
            `INSERT INTO sync_holds (id, household_id, connection_id, account_id,
               provider_transaction_id, amount_minor, currency, authorized_date,
               original_description, display_name, candidate_ids)
             VALUES (gen_random_uuid(), $1, $2, $3, 'held', -100, 'USD', '2026-03-01', $4, $4, '{}')
             RETURNING id`,
            [x.householdId, x.connectionId, x.accountId, name],
          )
        ).rows[0].id;
      }
    } finally {
      await db.end();
    }
    // B also gets a second member, so member routes have a non-owner target.
    const token = new URLSearchParams(new URL(inviteB.body.data.url).hash.slice(1)).get('token')!;
    await carol.post('/api/v1/invites/accept', { token });
    ids.b.otherMemberId = (await bob.get(`/api/v1/households/${b.id}/members`)).body.data.find(
      (m: { isYou: boolean }) => !m.isYou,
    ).id;
    // A settle-up between B's two members (#112).
    ids.b.settlementId = (
      await bob.post(`/api/v1/households/${b.id}/shared-costs/settlements`, {
        memberId: ids.b.otherMemberId,
        direction: 'they_paid',
        amountMinor: 100,
        date: '2026-03-01',
        kind: 'paid',
      })
    ).body.data.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  const householdRoutes = () =>
    app
      .getHttpAdapter()
      .getInstance()
      .fiscusRoutes.filter((r) => r.url.includes(':householdId'));

  const fill = (url: string, values: Record<string, string>) =>
    url.replace(/:(\w+)/g, (_, param: string) => {
      const value =
        FIXED[param] ??
        (param === 'memberId' ? (values.otherMemberId ?? values.memberId) : values[param]);
      if (!value) throw new Error(`No test value for :${param}. Add one to cross-tenant.test.ts`);
      return value;
    });

  const call = (method: string, url: string) =>
    alice.request(method as 'GET', url, method === 'GET' ? undefined : {}, {
      headers: { 'if-match': '"v1"' },
    });

  it('finds the household routes', () => {
    expect(householdRoutes().length).toBeGreaterThanOrEqual(9);
  });

  it('every household route 404s for a non-member using another household’s ids', async () => {
    const failures: string[] = [];
    for (const route of householdRoutes()) {
      const url = fill(route.url, ids.b);
      const res = await call(route.method, url);
      if (res.status !== 404) failures.push(`${route.method} ${route.url} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('child ids from another household are indistinguishable from ids that do not exist', async () => {
    // Inside your own household, a foreign child id must get exactly the response a random id
    // gets (usually 404; 422 when the body fails validation first, which reveals nothing).
    const failures: string[] = [];
    const random = Object.fromEntries(
      Object.keys(ids.b).map((k) => [k, crypto.randomUUID()]),
    ) as Record<string, string>;
    for (const route of householdRoutes().filter((r) => /:(?!householdId)\w+/.test(r.url))) {
      const foreign = await call(
        route.method,
        fill(route.url, { ...ids.b, householdId: ids.a.householdId! }),
      );
      const missing = await call(
        route.method,
        fill(route.url, { ...random, householdId: ids.a.householdId! }),
      );
      const summary = (r: typeof foreign) => `${r.status} ${r.body?.code}`;
      if (foreign.status < 400 || summary(foreign) !== summary(missing)) {
        failures.push(
          `${route.method} ${route.url}: foreign ${summary(foreign)} vs missing ${summary(missing)}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('left household B untouched', async () => {
    const members = (await bob.get(`/api/v1/households/${ids.b.householdId}/members`)).body.data;
    expect(members).toHaveLength(2);
    const household = (await bob.get(`/api/v1/households/${ids.b.householdId}`)).body.data;
    expect(household).toMatchObject({ name: SECRET_NAME, version: 1 });
  });

  describe('with the application membership check disabled (row-level security alone)', () => {
    it('leaks nothing from household B and changes nothing in it', async () => {
      const access = app.get(HouseholdAccess);
      const realRequire = access.require.bind(access);
      // Simulated app bug: anyone is treated as an owner of whatever household is in the path,
      // using their membership from their own household.
      access.require = async (_userId, householdId) => ({
        memberId: ids.a.memberId!,
        householdId,
        role: 'owner',
      });
      const leaks: string[] = [];
      const bSecrets = [
        SECRET_NAME,
        SECRET_ACCOUNT,
        SECRET_TAG,
        SECRET_INSTITUTION,
        ids.b.memberId!,
        ids.b.otherMemberId!,
        ids.b.inviteId!,
        ids.b.accountId!,
        ids.b.transactionId!,
        ids.b.tagId!,
        ids.b.categoryId!,
        ids.b.connectionId!,
      ];
      try {
        for (const route of householdRoutes()) {
          const res = await call(route.method, fill(route.url, ids.b));
          const body = JSON.stringify(res.body ?? '');
          if (res.status < 300 && route.method !== 'GET') {
            leaks.push(`${route.method} ${route.url} succeeded (${res.status})`);
          }
          for (const secret of bSecrets) {
            if (body.includes(secret))
              leaks.push(`${route.method} ${route.url} returned ${secret}`);
          }
        }
        // Validation stops the empty bodies above; a real one must still change nothing (HH-18).
        const me = await alice.request('PATCH', `/api/v1/households/${ids.b.householdId}/me`, {
          displayName: 'Hijacked',
        });
        if (me.status < 300) leaks.push(`PATCH /me with a body succeeded (${me.status})`);
      } finally {
        access.require = realRequire;
      }
      expect(leaks).toEqual([]);
      const members = (await bob.get(`/api/v1/households/${ids.b.householdId}/members`)).body.data;
      expect(members).toHaveLength(2);
      expect((await bob.get(`/api/v1/households/${ids.b.householdId}`)).body.data).toMatchObject({
        name: SECRET_NAME,
        version: 1,
      });
    });
  });
});
