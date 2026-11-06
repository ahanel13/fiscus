// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { type Goal, type GoalsOverview, goalPace } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Goals, end to end (#132, #134, #136, #138; goals walkthrough §1–§5, §8): savings goals that draw
 * on accounts by claims, the household's and your own, claims only by an account's owners and
 * never beyond what's free, and choosing which goal gives way when a balance falls short; and
 * paying down a loan or card.
 */
describe('goals', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  const id = { A: '', B: '', V: '' };
  const acct = { harbor: '', alexs: '' };
  const goal = { house: '', cushion: '', trip: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const overview = async (c: TestClient): Promise<GoalsOverview> => {
    const r = await c.get(url('/goals'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const find = async (c: TestClient, goalId: string) =>
    (await overview(c)).goals.find((g) => g.id === goalId);
  const claim = (c: TestClient, goalId: string, accountId: string, body: object) =>
    c.request('PUT', url(`/goals/${goalId}/claims/${accountId}`), body);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@goals.test`,
        password: 'goals test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('alex');
    B = await signup('sam');
    V = await signup('vic');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Riveras',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'hybrid',
      })
    ).body.data.id;
    for (const [c, email, role] of [
      [B, 'sam@goals.test', 'member'],
      [V, 'vic@goals.test', 'viewer'],
    ] as const) {
      const invite = await A.post(url('/invites'), { email, role });
      await c.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    const members = (await A.get(url('/members'))).body.data as {
      id: string;
      displayName: string;
    }[];
    const keys = { alex: 'A', sam: 'B', vic: 'V' } as const;
    for (const m of members) id[keys[m.displayName as keyof typeof keys]] = m.id;
    const make = async (body: Record<string, unknown>) => {
      const r = await A.post(url('/accounts'), {
        type: 'depository',
        subtype: 'savings',
        ...body,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.id as string;
    };
    acct.harbor = await make({
      name: 'Harbor Savings',
      visibility: 'full',
      owners: [{ memberId: id.A }, { memberId: id.B }],
      openingBalance: { amountMinor: 2000000, asOf: yesterday },
    });
    acct.alexs = await make({
      name: 'Alex savings',
      visibility: 'private',
      openingBalance: { amountMinor: 940000, asOf: yesterday },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('creates the household’s goal with a claim, for everyone to see [GOAL-03/OWN] [GOAL-05/OWN]', async () => {
    const r = await A.post(url('/goals'), {
      name: 'House down payment',
      targetMinor: 6000000,
      targetDate: '2028-12-01',
      planMinor: 130000,
      claims: [{ accountId: acct.harbor, amountMinor: 1400000 }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const g = r.body.data as Goal;
    goal.house = g.id;
    expect(g).toMatchObject({ scope: 'household', progressMinor: 1400000, done: false });
    expect(g.claims).toEqual([
      expect.objectContaining({
        accountName: 'Harbor Savings',
        amountMinor: 1400000,
        valueMinor: 1400000,
        yours: true,
      }),
    ]);
    expect(g.toMakeDateMinor).toBeGreaterThan(0);
  });

  it('shows the household’s goals to everyone [GOAL-01/OWN] [GOAL-01/MEM] [GOAL-01/VIEW]', async () => {
    for (const c of [A, B, V]) expect((await find(c, goal.house))?.name).toBe('House down payment');
    expect((await overview(V)).canCreate).toBe(false);
  });

  it('keeps your own goal yours, and only you change it [GOAL-02/OWN] [GOAL-04/OWN] [GOAL-02/MEM] [GOAL-02/VIEW]', async () => {
    const r = await A.post(url('/goals'), {
      name: 'Emergency fund',
      scope: 'mine',
      targetMinor: 1000000,
      claims: [
        { accountId: acct.alexs, percentBps: 5000 },
        { accountId: acct.harbor, amountMinor: 300000 },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    goal.cushion = r.body.data.id;
    expect(r.body.data.progressMinor).toBe(470000 + 300000);
    for (const c of [B, V]) {
      expect(await find(c, goal.cushion)).toBeUndefined();
      expect((await c.request('DELETE', url(`/goals/${goal.cushion}`))).status).toBe(404);
    }
  });

  it('lets a member make their own goal, and a viewer neither [GOAL-04/MEM] [GOAL-04/VIEW] [GOAL-03/VIEW]', async () => {
    const own = await B.post(url('/goals'), { name: 'Bike', scope: 'mine', targetMinor: 90000 });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    for (const scope of ['mine', 'household']) {
      const r = await V.post(url('/goals'), { name: 'Nope', scope, targetMinor: 1 });
      expect(r.status).toBe(403);
    }
    await B.request('DELETE', url(`/goals/${own.body.data.id}`));
  });

  it('shows a claim on a private account, but never its name or balance (G7)', async () => {
    const r = await claim(A, goal.house, acct.alexs, { amountMinor: 200000 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const seen = await find(B, goal.house);
    const theirs = seen!.claims.find((c) => c.accountId === acct.alexs)!;
    expect(theirs).toMatchObject({ accountName: null, valueMinor: 200000, yours: false });
    expect(theirs.ownerIds).toEqual([id.A]);
    expect((await overview(B)).accounts.map((a) => a.accountId)).toEqual([acct.harbor]);
  });

  it('lets only an account’s owners claim it [GOAL-05/MEM] [GOAL-05/VIEW]', async () => {
    expect((await claim(B, goal.house, acct.alexs, { amountMinor: 1 })).status).toBe(403);
    expect((await claim(V, goal.house, acct.harbor, { amountMinor: 1 })).status).toBe(403);
    const trip = await B.post(url('/goals'), {
      name: 'Japan trip',
      targetMinor: 600000,
      claims: [{ accountId: acct.harbor, amountMinor: 300000 }],
    });
    expect(trip.status, JSON.stringify(trip.body)).toBe(201);
    goal.trip = trip.body.data.id;
  });

  it('never claims beyond what’s free, counting goals you can’t see (G3)', async () => {
    // Harbor: $20,000 less the house's $14,000, Alex's cushion's $3,000 and the trip's $3,000.
    const r = await claim(B, goal.trip, acct.harbor, { amountMinor: 300001 });
    expect([r.status, r.body.code]).toEqual([422, 'claim_too_large']);
    // Free for the trip: its own $3,000, and nothing more.
    expect(r.body.detail).toBe('Harbor Savings has $3,000.00 free for this goal.');
    const harbor = (await overview(B)).accounts.find((a) => a.accountId === acct.harbor)!;
    expect(harbor).toMatchObject({ balanceMinor: 2000000, unclaimedMinor: 0 });
  });

  it('changes a goal for whoever edits first [GOAL-03/MEM]', async () => {
    const g = (await find(B, goal.house))!;
    const r = await B.request(
      'PATCH',
      url(`/goals/${goal.house}`),
      { name: 'House' },
      { headers: { 'if-match': `"v${g.version}"` } },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const stale = await A.request(
      'PATCH',
      url(`/goals/${goal.house}`),
      { name: 'Home' },
      { headers: { 'if-match': `"v${g.version}"` } },
    );
    expect([stale.status, stale.body.code]).toEqual([409, 'edit_conflict']);
  });

  it('shows a shortfall, and suggests the lowest priority goal gives way (G3, G19)', async () => {
    const spend = await A.post(url('/transactions'), {
      accountId: acct.harbor,
      date: today,
      amountMinor: -450000,
      displayName: 'Roof repair',
    });
    expect(spend.status, JSON.stringify(spend.body)).toBe(201);
    const [mine] = (await overview(A)).shortfalls;
    expect(mine).toMatchObject({ accountId: acct.harbor, shortMinor: 450000, canResolve: true });
    // Alex sees the trip (last), then the cushion: the trip's $3,000, then $1,500 of the cushion.
    expect(mine!.suggestion).toEqual([
      { goalId: goal.trip, amountMinor: 300000 },
      { goalId: goal.cushion, amountMinor: 150000 },
    ]);
    // Sam doesn't see the cushion: the house gives way after the trip.
    const [theirs] = (await overview(B)).shortfalls;
    expect(theirs!.suggestion).toEqual([
      { goalId: goal.trip, amountMinor: 300000 },
      { goalId: goal.house, amountMinor: 150000 },
    ]);
    expect((await find(B, goal.trip))!.shortMinor).toBe(300000);
  });

  it('lets the account’s owners choose which goal gives way [GOAL-06/MEM] [GOAL-06/OWN] [GOAL-06/VIEW]', async () => {
    const giveWay = (c: TestClient, take: object[]) =>
      c.post(url('/goals/give-way'), { accountId: acct.harbor, take });
    expect((await giveWay(V, [{ goalId: goal.house, amountMinor: 1 }])).status).toBe(403);
    expect((await giveWay(B, [{ goalId: goal.trip, amountMinor: 450001 }])).body.code).toBe(
      'more_than_short',
    );
    expect((await giveWay(B, [{ goalId: goal.trip, amountMinor: 300000 }])).status).toBe(204);
    // The trip's claim is gone; Alex takes the rest from the cushion.
    expect((await find(B, goal.trip))!.claims).toEqual([]);
    expect((await giveWay(A, [{ goalId: goal.cushion, amountMinor: 150000 }])).status).toBe(204);
    expect((await overview(A)).shortfalls).toEqual([]);
    expect((await find(A, goal.cushion))!.progressMinor).toBe(470000 + 150000);
  });

  it('orders goals by priority, highest first (G19)', async () => {
    const ids = [goal.trip, goal.house];
    expect((await V.request('PUT', url('/goals/order'), { ids })).status).toBe(403);
    expect((await B.request('PUT', url('/goals/order'), { ids: [goal.trip] })).status).toBe(422);
    expect((await B.request('PUT', url('/goals/order'), { ids })).status).toBe(204);
    expect((await overview(B)).goals.map((g) => g.id)).toEqual(ids);
  });

  it('takes a claim off, and deletes a goal, leaving the money where it is', async () => {
    expect(
      (await B.request('DELETE', url(`/goals/${goal.house}/claims/${acct.alexs}`))).status,
    ).toBe(403);
    const off = await A.request('DELETE', url(`/goals/${goal.house}/claims/${acct.alexs}`));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data.claims.map((c: { accountId: string }) => c.accountId)).toEqual([
      acct.harbor,
    ]);
    expect((await B.request('DELETE', url(`/goals/${goal.trip}`))).status).toBe(204);
    expect(await find(A, goal.trip)).toBeUndefined();
  });

  it('says where each goal stands at its plan (walkthrough §4)', async () => {
    const g = (await find(B, goal.house))!;
    expect(g.pace).toEqual(goalPace({ ...g, thisMonth: today.slice(0, 7) }));
    expect(g.pace.status).not.toBeNull();
    // The claim's bank, for its logo: none for an account that isn't connected.
    expect(g.claims[0]!.institution).toBeNull();
  });

  it('wears an icon and color, or a photo, which whoever sees it can load [GOAL-03/MEM]', async () => {
    const before = (await find(B, goal.house))!;
    const looked = await B.request(
      'PATCH',
      url(`/goals/${goal.house}`),
      { icon: 'house', color: '#2b7bb9' },
      { headers: { 'if-match': `"v${before.version}"` } },
    );
    expect(looked.status, JSON.stringify(looked.body)).toBe(200);
    expect(looked.body.data).toMatchObject({ icon: 'house', color: '#2b7bb9', imageVersion: null });
    expect(
      (
        await B.request(
          'PATCH',
          url(`/goals/${goal.house}`),
          { color: '#123456' },
          { headers: { 'if-match': `"v${looked.body.data.version}"` } },
        )
      ).status,
    ).toBe(422);

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
    const put = (c: TestClient, bytes: Buffer, type = 'image/jpeg') =>
      c.request('PUT', url(`/goals/${goal.house}/image`), {
        type,
        dataBase64: bytes.toString('base64'),
      });
    expect((await put(V, jpeg)).status).toBe(403);
    const bad = await put(B, Buffer.from('<svg onload=alert(1)>'), 'image/png');
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    const ok = await put(B, jpeg);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.imageVersion).not.toBeNull();
    const got = (await V.request('GET', url(`/goals/${goal.house}/image`))).raw;
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.rawPayload.equals(jpeg)).toBe(true);

    const off = await B.request('DELETE', url(`/goals/${goal.house}/image`));
    expect(off.body.data.imageVersion).toBeNull();
    expect((await A.request('GET', url(`/goals/${goal.house}/image`))).status).toBe(404);
  });

  it('puts a goal away, ending its claims, and brings it back [GOAL-03/MEM]', async () => {
    const made = await B.post(url('/goals'), { name: 'New bike', targetMinor: 150000 });
    const bike = made.body.data.id as string;
    // Alex earmarks Alex's own private savings for it: not Sam's claim to end.
    expect((await claim(A, bike, acct.alexs, { amountMinor: 50000 })).status).toBe(200);
    const refused = await B.request('PUT', url(`/goals/${bike}/archived`), { archived: true });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('claims_not_yours');
    expect(
      (await V.request('PUT', url(`/goals/${bike}/archived`), { archived: true })).status,
    ).toBe(403);

    const unclaimed = (await overview(A)).accounts.find((a) => a.accountId === acct.alexs)!;
    const away = await A.request('PUT', url(`/goals/${bike}/archived`), { archived: true });
    expect(away.status, JSON.stringify(away.body)).toBe(200);
    const view = await overview(A);
    expect(view.goals.map((g) => g.id)).not.toContain(bike);
    expect(view.archived.find((g) => g.id === bike)).toMatchObject({
      progressMinor: 50000,
      claims: [],
    });
    expect(view.accounts.find((a) => a.accountId === acct.alexs)!.unclaimedMinor).toBe(
      unclaimed.unclaimedMinor + 50000,
    );
    // Away, it takes no claims, and isn't in the priority list.
    expect((await claim(A, bike, acct.alexs, { amountMinor: 100 })).status).toBe(409);
    expect(
      (
        await B.request('PUT', url('/goals/order'), {
          ids: [...view.goals.map((g) => g.id), bike],
        })
      ).status,
    ).toBe(422);

    const back = await B.request('PUT', url(`/goals/${bike}/archived`), { archived: false });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.data).toMatchObject({ archivedAt: null, progressMinor: 0, claims: [] });
    expect((await overview(B)).goals.at(-1)!.id).toBe(bike);
  });

  it('pays down a card from what’s owed, at the bank’s rate or one entered [GOAL-08/OWN] [GOAL-08/VIEW] [GOAL-01/VIEW]', async () => {
    const r = await A.post(url('/accounts'), {
      name: 'Harbor Visa',
      type: 'credit',
      visibility: 'full',
      owners: [{ memberId: id.A }, { memberId: id.B }],
      openingBalance: { amountMinor: -300000, asOf: yesterday },
    });
    const visa = r.body.data.id as string;
    // What the bank says (Plaid liabilities, #86): 24% and a $100 minimum.
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      await db.query(
        `INSERT INTO account_liabilities (account_id, household_id, apr_bps, minimum_payment_minor)
         VALUES ($1, $2, 2400, 10000)`,
        [visa, hh],
      );
    } finally {
      await db.end();
    }
    const made = await A.post(url('/goals/pay-down'), { accountId: visa, planMinor: 20000 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const g = made.body.data as Goal;
    expect(g).toMatchObject({
      kind: 'pay_down',
      name: 'Harbor Visa',
      scope: 'household',
      targetMinor: 300000,
      progressMinor: 0,
      claims: [],
    });
    expect(g.debt).toMatchObject({
      accountName: 'Harbor Visa',
      type: 'credit',
      owedMinor: 300000,
      aprBps: 2400,
      minimumMinor: 10000,
      bank: { aprBps: 2400, minimumMinor: 10000 },
    });
    // $300 a month against 2% a month: paid off in about a year.
    expect(g.pace.projectedMonth).not.toBeNull();
    const view = await overview(B);
    expect(view.debts.find((d) => d.accountId === visa)).toMatchObject({ goalId: g.id });
    expect(view.totals.owedMinor).toBe(300000);
    // Viewers see it, with what's owed.
    expect((await find(V, g.id))?.debt?.owedMinor).toBe(300000);

    // One goal a debt, and no claims on it.
    const again = await B.post(url('/goals/pay-down'), { accountId: visa });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('debt_has_goal');
    const claimed = await claim(A, g.id, acct.harbor, { amountMinor: 100 });
    expect(claimed.status).toBe(422);
    expect(claimed.body.code).toBe('pay_down_no_claims');

    // The balance comes down: that's progress.
    expect(
      (await A.request('PUT', url(`/accounts/${visa}/balances/${today}`), { amountMinor: -200000 }))
        .status,
    ).toBe(200);
    expect(await find(A, g.id)).toMatchObject({ progressMinor: 100000 });

    // A rate entered goes first; taking it off goes back to the bank's.
    const patch = (body: object, version: number) =>
      B.request('PATCH', url(`/goals/${g.id}`), body, {
        headers: { 'if-match': `"v${version}"` },
      });
    const set = await patch({ aprBps: 1999, minimumMinor: 5000 }, g.version);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.debt).toMatchObject({
      aprBps: 1999,
      minimumMinor: 5000,
      entered: { aprBps: 1999, minimumMinor: 5000 },
      bank: { aprBps: 2400 },
    });
    const back = await patch({ aprBps: null }, set.body.data.version);
    expect(back.body.data.debt).toMatchObject({ aprBps: 2400, minimumMinor: 5000 });
    // A savings goal has no rate.
    const house = (await find(A, goal.house))!;
    const saving = await A.request(
      'PATCH',
      url(`/goals/${house.id}`),
      { aprBps: 500 },
      { headers: { 'if-match': `"v${house.version}"` } },
    );
    expect(saving.status).toBe(422);
    expect((await V.post(url('/goals/pay-down'), { accountId: visa })).status).toBe(403);
  });

  it('keeps a goal on a private debt your own [GOAL-08/MEM]', async () => {
    const r = await A.post(url('/accounts'), {
      name: 'Alex car loan',
      type: 'loan',
      visibility: 'private',
      openingBalance: { amountMinor: -1200000, asOf: yesterday },
    });
    const loan = r.body.data.id as string;
    const ours = await A.post(url('/goals/pay-down'), { accountId: loan, scope: 'household' });
    expect(ours.status).toBe(422);
    expect(ours.body.code).toBe('private_debt');
    const mine = await A.post(url('/goals/pay-down'), { accountId: loan });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.data).toMatchObject({ scope: 'mine', targetMinor: 1200000 });
    // Sam sees neither the loan nor the goal, and can't start one on it.
    const view = await overview(B);
    expect(view.debts.map((d) => d.accountId)).not.toContain(loan);
    expect(view.goals.map((g) => g.id)).not.toContain(mine.body.data.id);
    expect((await B.post(url('/goals/pay-down'), { accountId: loan })).body.code).toBe(
      'not_a_debt',
    );
    // A member pays down their own card, for the household by default.
    const card = (
      await B.post(url('/accounts'), {
        name: 'Sam card',
        type: 'credit',
        visibility: 'full',
        openingBalance: { amountMinor: -50000, asOf: yesterday },
      })
    ).body.data.id as string;
    const sams = await B.post(url('/goals/pay-down'), { accountId: card, name: 'Clear my card' });
    expect(sams.status, JSON.stringify(sams.body)).toBe(201);
    expect(sams.body.data).toMatchObject({ scope: 'household', name: 'Clear my card' });
  });
});
