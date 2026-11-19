// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Cross-member leakage suite (#56, permissions §7, design §7). One household with an owner (A),
 * two members (B, C), and a viewer (V); accounts in every combination of
 * {personal A, joint A+B, joint A+B+C} × {full, view_only, balance_only, private}.
 * Every actor calls every account route on every account, and each response is checked for
 * status and for any trace of accounts the actor can't see.
 */

type Actor = 'A' | 'B' | 'C' | 'V';
type Level = 'owner' | 'full' | 'view_only' | 'balance_only';
const ACTORS: Actor[] = ['A', 'B', 'C', 'V'];
const VISIBILITIES = ['full', 'view_only', 'balance_only', 'private'] as const;
const OWNER_SETS: Actor[][] = [['A'], ['A', 'B'], ['A', 'B', 'C']];

interface Fixture {
  key: string;
  owners: Actor[];
  visibility: (typeof VISIBILITIES)[number];
  balance: number;
  id: string;
  name: string;
  note: string;
  /** Its card details' APR in basis points, distinct per account (#86). */
  apr: number;
}

/** The permissions matrix §3, independent of the code under test. */
function expectedLevel(actor: Actor, f: Fixture): Level | undefined {
  if (f.owners.includes(actor)) return 'owner';
  return f.visibility === 'private' ? undefined : f.visibility;
}

/** Shares as the API assigns them: equal, remainder to the first owner. */
function share(f: Fixture, member: Actor): number {
  const i = f.owners.indexOf(member);
  if (i < 0) return 0;
  const base = Math.floor(10000 / f.owners.length);
  return i === 0 ? 10000 - base * (f.owners.length - 1) : base;
}

describe('cross-member visibility (generated)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  const client = {} as Record<Actor, TestClient>;
  const member = {} as Record<Actor, string>;
  let hid = '';
  const fixtures: Fixture[] = [];
  const base = () => `/api/v1/households/${hid}`;

  const signup = async (name: string) => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: `${name.toLowerCase()}@members.test`,
      password: 'cross member Password1!',
      displayName: name,
    });
    return c;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    client.A = await signup('Ada');
    const hh = (
      await client.A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
      })
    ).body.data;
    hid = hh.id;
    member.A = hh.you.memberId;
    for (const [actor, name, role] of [
      ['B', 'Bea', 'member'],
      ['C', 'Cal', 'member'],
      ['V', 'Vic', 'viewer'],
    ] as const) {
      client[actor] = await signup(name);
      const invite = await client.A.post(`${base()}/invites`, {
        email: `${name.toLowerCase()}@members.test`,
        role,
      });
      const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
      expect((await client[actor].post('/api/v1/invites/accept', { token })).status).toBe(200);
    }
    for (const m of (await client.A.get(`${base()}/members`)).body.data) {
      const actor = ({ Ada: 'A', Bea: 'B', Cal: 'C', Vic: 'V' } as const)[m.displayName as string]!;
      member[actor] = m.id;
    }

    let n = 0;
    for (const owners of OWNER_SETS) {
      for (const visibility of VISIBILITIES) {
        n++;
        const key = `${owners.join('')}-${visibility}`;
        const f: Fixture = {
          key,
          owners,
          visibility,
          balance: 100000 * n + 7, // distinct, so totals pinpoint any wrong account
          id: '',
          name: `Account ${key} zq${n}x`,
          note: `Note for ${key} zq${n}y`,
          apr: 91_000 + n,
        };
        const res = await client.A.post(`${base()}/accounts`, {
          name: f.name,
          type: 'depository',
          visibility,
          owners: owners.map((o) => ({ memberId: member[o] })),
          openingBalance: { amountMinor: f.balance, asOf: '2026-01-01' },
          notes: f.note,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        f.id = res.body.data.id;
        fixtures.push(f);
      }
    }
    // Card details on every account, as a sync would write them (#86).
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      for (const f of fixtures) {
        await db.query(
          `INSERT INTO account_liabilities (account_id, household_id, apr_bps, last_statement_date)
           VALUES ($1, $2, $3, '2026-01-01')`,
          [f.id, hid, f.apr],
        );
      }
    } finally {
      await db.end();
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  /** Everything about accounts `actor` can't see, which must never appear in a response. */
  const hiddenFrom = (actor: Actor) =>
    fixtures.filter((f) => !expectedLevel(actor, f)).flatMap((f) => [f.id, f.name, f.note]);
  /** Notes of balance-only accounts are hidden too (permissions §3). */
  const forbiddenText = (actor: Actor) => [
    ...hiddenFrom(actor),
    ...fixtures.filter((f) => expectedLevel(actor, f) === 'balance_only').map((f) => f.note),
  ];
  const leaks = (actor: Actor, body: unknown) => {
    const text = JSON.stringify(body ?? '');
    return forbiddenText(actor).filter((s) => text.includes(s));
  };

  describe.each(ACTORS)('as %s', (actor) => {
    it('lists exactly the visible accounts, with the right access and nothing else', async () => {
      const res = await client[actor].get(`${base()}/accounts`);
      expect(res.status).toBe(200);
      const got = new Map(
        res.body.data.map((a: { id: string; yourAccess: Level }) => [a.id, a.yourAccess]),
      );
      const want = new Map(
        fixtures.flatMap((f) => (expectedLevel(actor, f) ? [[f.id, expectedLevel(actor, f)]] : [])),
      );
      expect(got).toEqual(want);
      expect(res.body.meta).toEqual({ scope: 'visible_to_you' });
      expect(leaks(actor, res.body)).toEqual([]);
      // Card details are on the account itself, never in lists (#86).
      expect(JSON.stringify(res.body)).not.toContain('aprBps');
    });

    it.each(VISIBILITIES.flatMap((v) => OWNER_SETS.map((o) => `${o.join('')}-${v}`)))(
      'answers every account route correctly for %s',
      async (key) => {
        const f = fixtures.find((x) => x.key === key)!;
        const level = expectedLevel(actor, f);
        const c = client[actor];
        const url = `${base()}/accounts/${f.id}`;
        const reads = [await c.get(url), await c.get(`${url}/balances?from=2025-12-01`)];
        const ownerVersion = (await client[f.owners[0]!].get(url)).body.data.version;
        const writes = [
          await c.request(
            'PATCH',
            url,
            { sortOrder: 0 },
            {
              headers: { 'if-match': `"v${ownerVersion}"` },
            },
          ),
          await c.request('PUT', `${url}/balances/2026-01-01`, { amountMinor: f.balance }),
          ...(level === 'owner'
            ? []
            : [
                await c.request('PUT', `${url}/owners`, { owners: [{ memberId: member[actor] }] }),
                await c.post(`${url}/close`),
              ]),
        ];
        const readStatus = level ? 200 : 404;
        const writeStatus = level === 'owner' ? 200 : level ? 403 : 404;
        expect(reads.map((r) => r.status)).toEqual(reads.map(() => readStatus));
        expect(writes.map((r) => r.status)).toEqual(writes.map(() => writeStatus));
        for (const r of [...reads, ...writes]) expect(leaks(actor, r.body)).toEqual([]);
        if (level) {
          const account = reads[0]!.body.data;
          expect(account.yourAccess).toBe(level);
          expect('notes' in account).toBe(level !== 'balance_only');
          expect(account.balance).toEqual({ amountMinor: f.balance, asOf: '2026-01-01' });
          // Card details at owner and full access only; below that, not even a null (#86).
          if (level === 'owner' || level === 'full') {
            expect(account.liabilities).toMatchObject({
              aprBps: f.apr,
              lastStatementDate: '2026-01-01',
            });
          } else {
            expect('liabilities' in account).toBe(false);
            expect(JSON.stringify(reads.map((r) => r.body))).not.toContain('aprBps');
          }
        }
      },
    );

    it.each(['all', 'me', 'shared', 'member:B'])(
      'reports net worth for lens %s as the sum of only what it can see',
      async (lens) => {
        const lensParam = lens === 'member:B' ? `member:${member.B}` : lens;
        const res = await client[actor].get(
          `${base()}/net-worth?lens=${lensParam}&from=2025-12-31`,
        );
        expect(res.status).toBe(200);
        const expected = fixtures
          .filter((f) => expectedLevel(actor, f))
          .reduce((sum, f) => {
            const weight =
              lens === 'all'
                ? 10000
                : lens === 'shared'
                  ? f.owners.length >= 2
                    ? 10000
                    : 0
                  : share(f, lens === 'me' ? actor : 'B');
            return sum + Math.round((f.balance * weight) / 10000);
          }, 0);
        expect(res.body.data.netWorthMinor).toBe(expected);
        expect(res.body.data.assetsMinor).toBe(expected);
        const [before, onDay, ...rest] = res.body.data.series;
        expect(before).toMatchObject({ date: '2025-12-31', netWorthMinor: 0 });
        expect(onDay).toMatchObject({ date: '2026-01-01', netWorthMinor: expected });
        expect(rest.at(-1)?.netWorthMinor ?? expected).toBe(expected); // carried forward to today
      },
    );

    it('sees no activity about accounts it can’t see', async () => {
      const res = await client[actor].get(`${base()}/activity?limit=200`);
      expect(res.status).toBe(200);
      const targets = new Set(res.body.data.map((e: { targetId: string }) => e.targetId));
      for (const f of fixtures) expect(targets.has(f.id)).toBe(Boolean(expectedLevel(actor, f)));
      expect(leaks(actor, res.body)).toEqual([]);
    });
  });

  describe('rules', () => {
    it('keeps viewers from creating or owning accounts', async () => {
      expect(
        (await client.V.post(`${base()}/accounts`, { name: 'Mine', type: 'other' })).status,
      ).toBe(403);
      const res = await client.A.post(`${base()}/accounts`, {
        name: 'For Vic',
        type: 'other',
        owners: [{ memberId: member.A }, { memberId: member.V }],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('invalid_owner');
    });

    it('only adds accounts the creator co-owns', async () => {
      const res = await client.B.post(`${base()}/accounts`, {
        name: 'For Cal',
        type: 'other',
        owners: [{ memberId: member.C }],
      });
      expect(res.body.code).toBe('must_own');
    });

    it('lets owners remove only themselves', async () => {
      const f = fixtures.find((x) => x.key === 'AB-private')!;
      const url = `${base()}/accounts/${f.id}/owners`;
      const other = await client.A.request('PUT', url, { owners: [{ memberId: member.A }] });
      expect(other.status).toBe(403);
      expect(other.body.code).toBe('remove_other_owner');
      const self = await client.B.request('PUT', url, { owners: [{ memberId: member.A }] });
      expect(self.status).toBe(204);
      // B no longer owns it, and it's private: gone from B's view.
      expect((await client.B.get(`${base()}/accounts/${f.id}`)).status).toBe(404);
      expect((await client.A.get(`${base()}/accounts/${f.id}`)).body.data.owners).toEqual([
        { memberId: member.A, shareBps: 10000 },
      ]);
    });

    it('rejects unknown or departed members in the lens', async () => {
      const res = await client.A.get(`${base()}/accounts?lens=member:${crypto.randomUUID()}`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('invalid_lens');
    });

    it('keeps an account owner from being made a viewer or leaving', async () => {
      const demote = await client.A.request('PATCH', `${base()}/members/${member.C}`, {
        role: 'viewer',
      });
      expect(demote.status).toBe(409);
      expect(demote.body.code).toBe('owns_accounts');
      const leave = await client.C.post(`${base()}/leave`);
      expect(leave.body.code).toBe('owns_accounts');
    });

    it('detects concurrent edits, field by field', async () => {
      const f = fixtures.find((x) => x.key === 'A-full')!;
      const url = `${base()}/accounts/${f.id}`;
      const { version } = (await client.A.get(url)).body.data;
      const first = await client.A.request(
        'PATCH',
        url,
        { name: 'Renamed' },
        {
          headers: { 'if-match': `"v${version}"` },
        },
      );
      expect(first.status).toBe(200);
      const stale = await client.A.request(
        'PATCH',
        url,
        { name: 'Other name' },
        {
          headers: { 'if-match': `"v${version}"` },
        },
      );
      expect(stale.status).toBe(409);
      const otherField = await client.A.request(
        'PATCH',
        url,
        { isBusiness: true },
        {
          headers: { 'if-match': `"v${version}"` },
        },
      );
      expect(otherField.status).toBe(200);
      expect(otherField.body.data).toMatchObject({ name: 'Renamed', isBusiness: true });
    });
  });

  describe('two-member household (F2)', () => {
    it('[EDGE-11] never makes a joint account private', async () => {
      const ann = await signup('Ann');
      const bo = await signup('Bo');
      const h = (
        await ann.post('/api/v1/households', { name: 'Two', baseCurrency: 'USD', timezone: 'UTC' })
      ).body.data;
      const url = `/api/v1/households/${h.id}`;
      const invite = await ann.post(`${url}/invites`, { email: 'bo@members.test' });
      const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
      await bo.post('/api/v1/invites/accept', { token });
      const boId = (await ann.get(`${url}/members`)).body.data.find(
        (m: { isYou: boolean }) => !m.isYou,
      ).id;
      const owners = [{ memberId: h.you.memberId }, { memberId: boId }];

      const create = await ann.post(`${url}/accounts`, {
        name: 'Joint',
        type: 'depository',
        visibility: 'private',
        owners,
      });
      expect(create.body.code).toBe('private_joint_disallowed');

      const joint = (
        await ann.post(`${url}/accounts`, { name: 'Joint', type: 'depository', owners })
      ).body.data;
      const patch = await ann.request(
        'PATCH',
        `${url}/accounts/${joint.id}`,
        { visibility: 'private' },
        {
          headers: { 'if-match': `"v${joint.version}"` },
        },
      );
      expect(patch.body.code).toBe('private_joint_disallowed');

      const solo = (
        await ann.post(`${url}/accounts`, {
          name: 'Solo',
          type: 'depository',
          visibility: 'private',
        })
      ).body.data;
      const share = await ann.request('PUT', `${url}/accounts/${solo.id}/owners`, { owners });
      expect(share.body.code).toBe('private_joint_disallowed');
    });
  });

  // Bank connections (#78, ACC-02/03): A connected each account (straight in the database; the
  // link flow is #79's). One is still being set up, so only A sees it (D4). AB-private is left
  // out: the rules above took B off it.
  describe('connections', () => {
    const SETUP = 'ABC-full';
    const connectionOf = new Map<string, string>();
    const connected = () => fixtures.filter((x) => x.key !== 'AB-private');

    beforeAll(async () => {
      const db = new pg.Client({ connectionString: tdb.ownerUrl });
      await db.connect();
      try {
        for (const x of connected()) {
          const id = crypto.randomUUID();
          connectionOf.set(x.key, id);
          await db.query(
            `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status)
             VALUES ($1, $2, $3, 'simplefin', $4, $5)`,
            [id, hid, member.A, `item-${id}`, x.key === SETUP ? 'setup' : 'ok'],
          );
          await db.query('UPDATE accounts SET connection_id = $1 WHERE id = $2', [id, x.id]);
        }
      } finally {
        await db.end();
      }
    });

    /** Written from the matrix: its owner, or anyone who sees its account, unless in setup. */
    const sees = (actor: Actor, x: Fixture) =>
      actor === 'A' || (x.key !== SETUP && expectedLevel(actor, x) !== undefined);

    it.each(ACTORS)(
      'lists for %s exactly the connections behind accounts it sees',
      async (actor) => {
        const res = await client[actor].get(`${base()}/connections`);
        expect(res.status).toBe(200);
        const got = new Map(
          res.body.data.map((c: { id: string; accountCount: number }) => [c.id, c.accountCount]),
        );
        const want = new Map(
          connected()
            .filter((x) => sees(actor, x))
            .map((x) => [connectionOf.get(x.key)!, expectedLevel(actor, x) ? 1 : 0]),
        );
        expect(got).toEqual(want);
        expect(leaks(actor, res.body)).toEqual([]);
        for (const c of res.body.data) {
          expect(c.owner).toEqual({ memberId: member.A, name: 'Ada' });
          expect(Object.keys(c).sort()).toEqual(
            [
              'accountCount',
              'accountIds',
              'failingSince',
              'id',
              'importingHistory',
              'institution',
              'institutionName',
              'lastSyncedAt',
              'newAccountsAvailable',
              'nextSyncAt',
              'notWorking',
              'onOldKeys',
              'paymentRequired',
              'owner',
              'provider',
              'refreshAvailableAt',
              'staleAccounts',
              'status',
            ].sort(),
          );
          // Only accounts this member sees: never a hidden one's id.
          expect(c.accountIds).toHaveLength(c.accountCount);
          for (const id of c.accountIds) {
            const f = fixtures.find((x) => x.id === id);
            expect(f && expectedLevel(actor, f), `${actor} sees ${id}`).toBeTruthy();
          }
        }
      },
    );

    it.each(ACTORS.filter((a) => a !== 'A'))(
      'refuses %s disconnecting any of them, without revealing hidden ones',
      async (actor) => {
        for (const x of connected()) {
          const res = await client[actor].delete(
            `${base()}/connections/${connectionOf.get(x.key)}`,
          );
          const status = actor === 'V' ? 403 : sees(actor, x) ? 403 : 404;
          expect([x.key, res.status]).toEqual([x.key, status]);
          expect(leaks(actor, res.body)).toEqual([]);
        }
      },
    );

    it('lets A disconnect one, keeping the account and its history (D14)', async () => {
      const x = fixtures.find((y) => y.key === 'AB-full')!;
      const url = `${base()}/connections/${connectionOf.get(x.key)}`;
      expect((await client.A.delete(url)).status).toBe(204);
      expect((await client.A.delete(url)).status).toBe(204); // already disconnected
      for (const actor of ACTORS) {
        const ids = (await client[actor].get(`${base()}/connections`)).body.data.map(
          (c: { id: string }) => c.id,
        );
        expect(ids).not.toContain(connectionOf.get(x.key));
      }
      const account = await client.B.get(`${base()}/accounts/${x.id}`);
      expect(account.status).toBe(200);
      expect(account.body.data.balance).toEqual({ amountMinor: x.balance, asOf: '2026-01-01' });
      // Seen by those who see the account, and only them.
      for (const actor of ACTORS) {
        const events = (await client[actor].get(`${base()}/activity?limit=200`)).body.data.filter(
          (e: { action: string }) => e.action === 'connection.disconnected',
        );
        expect([actor, events.length]).toEqual([actor, expectedLevel(actor, x) ? 1 : 0]);
      }
    });
  });

  /**
   * A split by income (F4, #110): nobody's income reaches anyone else. A agrees with their actual
   * income, from paychecks in their private account; B with a declared figure; C never agrees.
   * The others see who has agreed and the split, and nothing that gives away a figure.
   */
  describe('income for a split by income (F4)', () => {
    const PAYCHECK = 777_331; // A's, last month, in A's private account
    const A_MONTHLY = Math.round(PAYCHECK / 3); // what A's actual income works out at
    const DECLARED = 512_347; // B's
    const C_PAYCHECK = 654_529; // C's, never used: C hasn't agreed
    const today = new Date().toISOString().slice(0, 10);
    const lastMonth = (() => {
      const d = new Date();
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15))
        .toISOString()
        .slice(0, 10);
    })();
    const figures = [PAYCHECK, A_MONTHLY, DECLARED, C_PAYCHECK].map(String);
    const cat: Record<string, string> = {};
    /** Figures `actor` must never see: everyone else's income, and whose basis is which. */
    const incomeLeaks = (actor: Actor, body: unknown) => {
      const text = JSON.stringify(body ?? '');
      const own =
        actor === 'A'
          ? [String(PAYCHECK)]
          : actor === 'B'
            ? [String(DECLARED)]
            : actor === 'C'
              ? [String(C_PAYCHECK)]
              : [];
      return figures.filter((f) => !own.includes(f) && text.includes(f));
    };
    const routes = (month: string) => [
      '/income-split',
      '/split-rules',
      `/shared-costs?month=${month}`,
      '/activity?limit=200',
      '/members',
    ];

    beforeAll(async () => {
      for (const g of (await client.A.get(`${base()}/categories`)).body.data as {
        categories: { id: string; name: string }[];
      }[]) {
        for (const c of g.categories) cat[c.name] = c.id;
      }
      const post = async (c: TestClient, body: Record<string, unknown>) => {
        const r = await c.post(`${base()}/transactions`, body);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        return r.body.data.id as string;
      };
      await post(client.A, {
        accountId: fixtures.find((f) => f.key === 'A-private')!.id,
        date: lastMonth,
        amountMinor: PAYCHECK,
        displayName: 'Payroll',
        categoryId: cat.Paychecks,
      });
      // C's paycheck on an account only C owns.
      const cAccount = (
        await client.C.post(`${base()}/accounts`, {
          name: 'Cal checking',
          type: 'depository',
          visibility: 'private',
        })
      ).body.data.id as string;
      await post(client.C, {
        accountId: cAccount,
        date: lastMonth,
        amountMinor: C_PAYCHECK,
        displayName: 'Payroll',
        categoryId: cat.Paychecks,
      });
      // Rent today from A and B's joint account, for them both, split by income.
      await post(client.A, {
        accountId: fixtures.find((f) => f.key === 'AB-full')!.id,
        date: today,
        amountMinor: -300000,
        displayName: 'Rent',
        categoryId: cat['Rent or mortgage'],
      });
      const rule = await client.A.request(
        'PUT',
        `${base()}/split-rules/categories/${cat['Rent or mortgage']}`,
        { rule: { method: 'income_proportional' }, effectiveFrom: `${today.slice(0, 7)}-01` },
      );
      expect(rule.status, JSON.stringify(rule.body)).toBe(200);
    });

    it('uses no income before anyone agrees', async () => {
      for (const actor of ACTORS) {
        const s = (await client[actor].get(`${base()}/income-split`)).body.data;
        expect([actor, s.shares, s.yours]).toEqual([actor, [], null]);
      }
    });

    it('shows nobody the split until everyone it’s for has agreed', async () => {
      const r = await client.A.request('PUT', `${base()}/income-split/consent`, {
        basis: 'actual',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // A alone: a split of one, which says nothing about A's income.
      for (const actor of ACTORS) {
        const s = (await client[actor].get(`${base()}/income-split`)).body.data;
        expect([actor, s.shares]).toEqual([actor, [{ memberId: member.A, shareBps: 10000 }]]);
      }
      // The rent is still split equally between A and B.
      const lines = (await client.B.get(`${base()}/shared-costs?month=${today.slice(0, 7)}`)).body
        .data.expenses as { displayName: string; effect: unknown[] }[];
      expect(lines.find((l) => l.displayName === 'Rent')?.effect).toEqual([]);
    });

    it('shows everyone the split between those who agreed, never an income', async () => {
      const r = await client.B.request('PUT', `${base()}/income-split/consent`, {
        basis: 'declared',
        declaredMonthlyMinor: DECLARED,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const total = A_MONTHLY + DECLARED;
      for (const actor of ACTORS) {
        const s = (await client[actor].get(`${base()}/income-split`)).body.data;
        const shares = new Map(
          s.shares.map((x: { memberId: string; shareBps: number }) => [x.memberId, x.shareBps]),
        );
        // C's income never counts: C hasn't agreed.
        expect([actor, [...shares.keys()].sort()]).toEqual([actor, [member.A, member.B].sort()]);
        expect(
          Math.abs((shares.get(member.A) as number) - (A_MONTHLY * 10000) / total),
        ).toBeLessThan(1);
        expect(s.members).toContainEqual({ memberId: member.C, consented: false });
      }
    });

    it.each(ACTORS)('as %s, sees no one else’s income or choice anywhere', async (actor) => {
      for (const route of routes(today.slice(0, 7))) {
        const res = await client[actor].get(`${base()}${route}`);
        expect([route, res.status]).toEqual([route, 200]);
        expect([route, incomeLeaks(actor, res.body)]).toEqual([route, []]);
      }
      const s = (await client[actor].get(`${base()}/income-split`)).body.data;
      const yours =
        actor === 'A'
          ? { basis: 'actual' }
          : actor === 'B'
            ? { basis: 'declared', declaredMonthlyMinor: DECLARED }
            : null;
      expect([actor, s.yours]).toEqual([actor, yours]);
      if (actor !== 'B') expect(JSON.stringify(s)).not.toContain('declared');
    });

    it('records agreeing in the activity with no figure, and a changed one for its owner alone', async () => {
      const r = await client.B.request('PUT', `${base()}/income-split/consent`, {
        basis: 'declared',
        declaredMonthlyMinor: DECLARED + 1,
      });
      expect(r.status).toBe(200);
      for (const actor of ACTORS) {
        const feed = (await client[actor].get(`${base()}/activity?limit=200`)).body.data as {
          action: string;
        }[];
        const actions = feed.map((e) => e.action).filter((a) => a.startsWith('income_split.'));
        expect([actor, actions.sort()]).toEqual([
          actor,
          ['income_split.consented', 'income_split.consented'],
        ]);
        expect(JSON.stringify(feed)).not.toContain(String(DECLARED + 1));
      }
    });
  });
});

/**
 * The member history window (#256, ADR 0012 §Joining, HH-14). A and B run the household this
 * month: accounts, purchases, a household budget, a settle-up between them. C (a member) and V (a
 * viewer) join at the start of next month. They see the accounts shared with them whatever the
 * date, and what's attributed to them; the household's own records (its budget's months, its
 * activity, settle-ups between others) only from the day they joined. Every route is checked
 * against B, who was there.
 */
describe('history window for newer members (#256)', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  const client = {} as Record<'A' | 'B' | 'C' | 'V', TestClient>;
  const member = {} as Record<'A' | 'B' | 'C' | 'V', string>;
  let hid = '';
  const url = (p = '') => `/api/v1/households/${hid}${p}`;
  const month = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
  };
  const THIS = month(0);
  const NEXT = month(1);
  const acct = { card: '', checking: '' };
  const tx = { oursOnCard: '', onChecking: '', forC: '' };
  let budgetId = '';
  const BUDGETED = 43_217;
  type Newer = 'C' | 'V';

  const signup = async (name: string) => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: `${name.toLowerCase()}@window.test`,
      password: 'history window Password1!',
      displayName: name,
    });
    return c;
  };
  const join = async (actor: 'B' | 'C' | 'V', name: string, role: 'member' | 'viewer') => {
    client[actor] = await signup(name);
    const invite = await client.A.post(url('/invites'), {
      email: `${name.toLowerCase()}@window.test`,
      role,
    });
    const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
    expect((await client[actor].post('/api/v1/invites/accept', { token })).status).toBe(200);
    const me = (await client[actor].get(url('/members'))).body.data.find(
      (m: { isYou: boolean }) => m.isYou,
    );
    member[actor] = me.id;
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    client.A = await signup('Ada');
    const hh = (
      await client.A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'hybrid',
      })
    ).body.data;
    hid = hh.id;
    member.A = hh.you.memberId;
    await join('B', 'Bea', 'member');

    const categories = (await client.A.get(url('/categories'))).body.data.flatMap(
      (g: { categories: { id: string; name: string }[] }) => g.categories,
    );
    const groceries = categories.find((c: { name: string }) => c.name === 'Groceries').id;
    const account = async (name: string, visibility: string) => {
      const r = await client.A.post(url('/accounts'), { name, type: 'depository', visibility });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.id as string;
    };
    acct.card = await account('Card zqw1', 'private');
    acct.checking = await account('Checking zqw2', 'view_only');
    const spend = async (accountId: string, name: string, amountMinor: number) => {
      const r = await client.A.post(url('/transactions'), {
        accountId,
        date: `${THIS}-02`,
        amountMinor,
        displayName: name,
        categoryId: groceries,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.id as string;
    };
    const attribute = async (id: string, to: string[]) => {
      const r = await client.A.request('PUT', url(`/transactions/${id}/attribution`), {
        attribution: to.map((memberId) => ({ memberId })),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(204);
    };
    // Ours between A and B, on A's private card; on A's checking, shared with everyone; and one
    // C will be part of.
    tx.oursOnCard = await spend(acct.card, 'Ours zqt1', -1_101);
    await attribute(tx.oursOnCard, [member.A, member.B]);
    tx.onChecking = await spend(acct.checking, 'Checking buy zqt2', -2_203);
    tx.forC = await spend(acct.card, 'For Cal zqt3', -4_409);

    const budget = await client.A.post(url('/budgets'), {
      scope: 'household',
      amounts: [{ categoryId: groceries, amountMinor: BUDGETED }],
    });
    expect(budget.status, JSON.stringify(budget.body)).toBe(201);
    budgetId = budget.body.data.id;
    const settled = await client.A.post(url('/shared-costs/settlements'), {
      memberId: member.B,
      direction: 'you_paid',
      amountMinor: 777,
      date: `${THIS}-03`,
      kind: 'paid',
      note: 'Settled zqs1',
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(201);

    await join('C', 'Cal', 'member');
    await join('V', 'Vic', 'viewer');
    await attribute(tx.forC, [member.C]);
    // They joined next month: as the database would have set it then.
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      await db.query(`SET session_replication_role = replica`);
      await db.query(
        `UPDATE household_members SET history_from = $1::date, joined_at = $1::date WHERE id = ANY($2)`,
        [`${NEXT}-01`, [member.C, member.V]],
      );
    } finally {
      await db.end();
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  /** The fixtures' markers a response mentions, each once. */
  const names = (body: unknown) => [...new Set(JSON.stringify(body).match(/zq[a-z]\d/g))].sort();

  it('lists each member’s window: B’s from their join date, C’s and V’s from next month', async () => {
    const list = (await client.C.get(url('/members'))).body.data as {
      id: string;
      historyFrom: string | null;
    }[];
    const by = Object.fromEntries(list.map((m) => [m.id, m.historyFrom]));
    expect(by[member.A]).toBeNull(); // the household's first member
    expect(by[member.B]).toBe(new Date().toISOString().slice(0, 10));
    expect(by[member.C]).toBe(`${NEXT}-01`);
    expect(by[member.V]).toBe(`${NEXT}-01`);
  });

  describe.each(['C', 'V'] as Newer[])('as %s, who joined later', (actor) => {
    it('sees shared accounts’ whole history and what’s theirs, never others’ ours from before', async () => {
      const list = await client[actor].get(url('/transactions?limit=100'));
      expect(list.status).toBe(200);
      const want = actor === 'C' ? ['zqt2', 'zqt3', 'zqw2'] : ['zqt2', 'zqw2'];
      expect(names(list.body)).toEqual(want);
      // B, who was there, sees ours (and not what's C's alone).
      expect(names((await client.B.get(url('/transactions?limit=100'))).body)).toEqual([
        'zqt1',
        'zqt2',
        'zqw2',
      ]);
      // Search, and the transactions themselves.
      const search = await client[actor].get(url('/transactions?q=zqt'));
      expect(names(search.body).filter((n) => n.startsWith('zqt'))).toEqual(
        want.filter((n) => n.startsWith('zqt')),
      );
      expect((await client[actor].get(url(`/transactions/${tx.oursOnCard}`))).status).toBe(404);
      expect((await client[actor].get(url(`/transactions/${tx.onChecking}`))).status).toBe(200);
    });

    it('counts only those in aggregates', async () => {
      const flow = await client[actor].get(
        url(`/cash-flow?range=custom&from=${THIS}-01&to=${THIS}-28`),
      );
      expect(flow.status, JSON.stringify(flow.body)).toBe(200);
      const b = await client.B.get(url(`/cash-flow?range=custom&from=${THIS}-01&to=${THIS}-28`));
      // B sees ours and the checking purchase; C also their own; V only the checking one.
      expect(b.body.data.totals.spendingMinor).toBe(1_101 + 2_203);
      expect(flow.body.data.totals.spendingMinor).toBe(actor === 'C' ? 2_203 + 4_409 : 2_203);
    });

    it('[HH-14/MEM] [HH-14/VIEW] sees the household budget from their first month', async () => {
      const list = await client[actor].get(url('/budgets'));
      expect(list.body.data).toEqual([
        expect.objectContaining({ id: budgetId, scope: 'household', startsMonth: NEXT }),
      ]);
      const before = await client[actor].get(url(`/budgets/${budgetId}/months/${THIS}`));
      expect([before.status, before.body.code]).toEqual([404, 'before_budget']);
      const year = await client[actor].get(url(`/budgets/${budgetId}/years/${THIS.slice(0, 4)}`));
      expect(year.status).toBe(200);
      // Next month runs on the amounts set before it, which carry forward.
      const first = await client[actor].get(url(`/budgets/${budgetId}/months/${NEXT}`));
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(JSON.stringify(first.body)).toContain(String(BUDGETED));
      // B, who was there, sees this month.
      expect((await client.B.get(url(`/budgets/${budgetId}/months/${THIS}`))).status).toBe(200);
      expect((await client.B.get(url('/budgets'))).body.data[0].startsMonth).toBe(THIS);
    });

    it('sees no settle-up between others', async () => {
      const costs = await client[actor].get(url(`/shared-costs?month=${THIS}`));
      expect(costs.status).toBe(200);
      expect(costs.body.data.settlements).toEqual([]);
      expect(JSON.stringify(costs.body)).not.toContain('zqs1');
      expect(costs.body.data.balances.map((b: { memberId: string }) => b.memberId)).not.toContain(
        member.B,
      );
      expect(
        JSON.stringify((await client.B.get(url(`/shared-costs?month=${THIS}`))).body),
      ).toContain('zqs1');
    });

    it('sees household activity from their join date, and events on shared accounts', async () => {
      const feed = async (c: TestClient) =>
        (await c.get(url('/activity?limit=200'))).body.data as {
          action: string;
          targetId: string | null;
        }[];
      const theirs = await feed(client[actor]);
      const bs = await feed(client.B);
      const actions = (f: typeof theirs) => new Set(f.map((e) => e.action));
      // B sees the household being set up; the newer member doesn't.
      for (const a of ['household.created', 'settlement.recorded']) {
        if (actions(bs).has(a)) expect(actions(theirs)).not.toContain(a);
      }
      expect(actions(bs)).toContain('household.created');
      expect(theirs.some((e) => e.action.startsWith('budget.'))).toBe(false);
      expect(bs.some((e) => e.action.startsWith('budget.'))).toBe(true);
      // The checking account is shared with them, so its history is theirs too; the card isn't.
      const created = theirs.filter((e) => e.action === 'account.created').map((e) => e.targetId);
      expect(created).toEqual([acct.checking]);
      // Their own joining is theirs.
      expect(theirs.some((e) => e.targetId === member[actor])).toBe(true);
    });

    it('[HH-14/MEM] [HH-14/VIEW] can’t widen anyone’s window, their own included', async () => {
      for (const target of [member[actor], member.B]) {
        const r = await client[actor].request('PUT', url(`/members/${target}/history`), {
          historyFrom: null,
        });
        expect(r.status).toBe(403);
      }
    });
  });

  describe('[HH-14/OWN] an owner widening a window', () => {
    it('never narrows it', async () => {
      const later = await client.A.request('PUT', url(`/members/${member.C}/history`), {
        historyFrom: month(2) + '-01',
      });
      expect([later.status, later.body.code]).toEqual([409, 'would_narrow']);
      const ofFirst = await client.A.request('PUT', url(`/members/${member.A}/history`), {
        historyFrom: `${THIS}-01`,
      });
      expect([ofFirst.status, ofFirst.body.code]).toEqual([409, 'would_narrow']);
      const bad = await client.A.request('PUT', url(`/members/${member.C}/history`), {
        historyFrom: 'soon',
      });
      expect(bad.status).toBe(422);
    });

    it('shows the member what was before, and records it', async () => {
      const r = await client.A.request('PUT', url(`/members/${member.C}/history`), {
        historyFrom: `${THIS}-01`,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(204);
      expect((await client.C.get(url(`/budgets/${budgetId}/months/${THIS}`))).status).toBe(200);
      const actions = (await client.C.get(url('/activity?limit=200'))).body.data.map(
        (e: { action: string }) => e.action,
      );
      expect(actions).toContain('household.created');
      expect(actions).toContain('member.history_widened');
      // To all of it.
      expect(
        (
          await client.A.request('PUT', url(`/members/${member.C}/history`), {
            historyFrom: null,
          })
        ).status,
      ).toBe(204);
      const c = (await client.A.get(url('/members'))).body.data.find(
        (m: { id: string }) => m.id === member.C,
      );
      expect(c.historyFrom).toBeNull();
      // V's is still where it was.
      expect((await client.V.get(url(`/budgets/${budgetId}/months/${THIS}`))).status).toBe(404);
    });

    it('is the owner’s alone, and for current members only', async () => {
      const r = await client.A.request(
        'PUT',
        url(`/members/00000000-0000-4000-8000-000000000000/history`),
        { historyFrom: null },
      );
      expect(r.status).toBe(404);
    });
  });
});
