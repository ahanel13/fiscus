// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
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
      password: 'cross member password',
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
        expect(before).toEqual({ date: '2025-12-31', netWorthMinor: 0 });
        expect(onDay).toEqual({ date: '2026-01-01', netWorthMinor: expected });
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
    it('never makes a joint account private', async () => {
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
});
