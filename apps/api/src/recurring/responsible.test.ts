// SPDX-License-Identifier: AGPL-3.0-or-later
import { createDb, systemContext, withContext } from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { reminderRecipients, seriesLookedAfterBy } from '@fiscus/ledger';
import type { DetectedSeries, RecurringMonth, RecurringSeries } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Who looks after a bill (#121; bills walkthrough D13, D22; permissions REC-04). */
describe('who looks after a bill', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let C: TestClient;
  let V: TestClient;
  let hh = '';
  const id = { A: '', B: '', C: '', V: '' };
  /** Ada's and Bea's, shared in full. */
  let joint = '';
  /** Bea's own, shared in full. */
  let beas = '';
  /** Bea's own, private. */
  let beasPrivate = '';
  /** Ada's own, view-only for the rest. */
  let adasViewOnly = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const today = new Date().toISOString().slice(0, 10);
  const monthsAgo = (n: number) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1))
      .toISOString()
      .slice(0, 7);
  };
  const bill = (accountId: string, name: string, extra: Record<string, unknown> = {}) => ({
    accountId,
    name,
    kind: 'bill',
    match: { direction: 'out', description: { op: 'equals', value: name } },
    schedule: { unit: 'month', every: 1, days: [12], anchor: today, weekend: 'as_is' },
    ...extra,
  });
  const make = async (c: TestClient, body: Record<string, unknown>) => {
    const r = await c.post(url('/recurring'), body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data as RecurringSeries;
  };
  const one = async (c: TestClient, seriesId: string) =>
    ((await c.get(url('/recurring'))).body.data as RecurringSeries[]).find(
      (s) => s.id === seriesId,
    );

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@responsible.test`,
        password: 'responsible test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    C = await signup('cy');
    V = await signup('vic');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'hybrid',
      })
    ).body.data.id;
    for (const [c, email, role] of [
      [B, 'bea@responsible.test', 'member'],
      [C, 'cy@responsible.test', 'member'],
      [V, 'vic@responsible.test', 'viewer'],
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
    const keys = { ada: 'A', bea: 'B', cy: 'C', vic: 'V' } as const;
    for (const m of members) id[keys[m.displayName as keyof typeof keys]] = m.id;
    const account = async (c: TestClient, body: Record<string, unknown>) => {
      const r = await c.post(url('/accounts'), { type: 'depository', ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.id as string;
    };
    joint = await account(A, {
      name: 'Joint',
      visibility: 'full',
      owners: [{ memberId: id.A }, { memberId: id.B }],
    });
    beas = await account(B, { name: 'Bea’s checking', visibility: 'full' });
    beasPrivate = await account(B, { name: 'Bea’s card', visibility: 'private' });
    adasViewOnly = await account(A, { name: 'Ada’s checking', visibility: 'view_only' });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('is the account’s only owner, whoever confirms it', async () => {
    const s = await make(A, bill(beas, 'Lakeside Power'));
    expect(s.responsibleMemberId).toBe(id.B);
    // Everyone in the household sees Bea's checking, viewers included.
    expect([...s.seenBy].sort()).toEqual([id.A, id.B, id.C, id.V].sort());
  });

  it('is whoever confirms it, for a joint account', async () => {
    expect((await make(A, bill(joint, 'Streamly'))).responsibleMemberId).toBe(id.A);
    expect((await make(B, bill(joint, 'Northwind Mobile'))).responsibleMemberId).toBe(id.B);
  });

  it('can be chosen when it’s made, from those who see the account', async () => {
    expect(
      (await make(A, bill(joint, 'Cascade Water', { responsibleMemberId: id.C })))
        .responsibleMemberId,
    ).toBe(id.C);
    // Only Bea sees her private card.
    const refused = await B.post(
      url('/recurring'),
      bill(beasPrivate, 'Gym', { responsibleMemberId: id.A }),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('member_cannot_see_account');
  });

  it('is nobody for income, which is for whoever its payments are for', async () => {
    await A.post(url('/transactions'), {
      accountId: joint,
      date: `${monthsAgo(1)}-15`,
      amountMinor: 245_000,
      displayName: 'Brightline Labs payroll',
    });
    const pay = await make(A, {
      ...bill(joint, 'Brightline Labs payroll'),
      kind: 'income',
      match: { direction: 'in', description: { op: 'equals', value: 'Brightline Labs payroll' } },
      schedule: {
        unit: 'month',
        every: 1,
        days: [15],
        anchor: `${monthsAgo(1)}-15`,
        weekend: 'before',
      },
    });
    expect(pay.responsibleMemberId).toBeNull();
    // No attribution of its own: the joint account's owners.
    expect([...pay.forMemberIds].sort()).toEqual([id.A, id.B].sort());
    const handed = await A.request('PUT', url(`/recurring/${pay.id}/responsible`), {
      memberId: id.B,
    });
    expect(handed.status).toBe(422);
  });

  it('shows no one to choose on someone’s own private account (D22)', async () => {
    const gym = await make(B, bill(beasPrivate, 'Gym'));
    expect(gym.responsibleMemberId).toBe(id.B);
    expect(gym.seenBy).toEqual([id.B]);
    const preview = await B.post(url('/recurring/preview'), {
      accountId: beasPrivate,
      match: { direction: 'out' },
      schedule: { unit: 'month', every: 1, days: [1], anchor: today, weekend: 'as_is' },
    });
    expect(preview.body.data).toMatchObject({ responsibleMemberId: id.B, seenBy: [id.B] });
  });

  it('is handed over by anyone who sees it, view-only included [REC-04/MEM]', async () => {
    const s = await make(A, bill(adasViewOnly, 'Rent'));
    expect(s.responsibleMemberId).toBe(id.A);
    // Bea can only view Ada's checking: she can't change the series, but can take it on.
    expect((await B.request('PATCH', url(`/recurring/${s.id}`), { name: 'x' })).status).toBe(403);
    const r = await B.request('PUT', url(`/recurring/${s.id}/responsible`), { memberId: id.B });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body.data as RecurringSeries).responsibleMemberId).toBe(id.B);
    expect((await one(A, s.id))!.responsibleMemberId).toBe(id.B);
  });

  it('is handed only to someone who sees the account [REC-04/OWN]', async () => {
    const s = await make(A, bill(joint, 'Peak Fitness'));
    const ok = await A.request('PUT', url(`/recurring/${s.id}/responsible`), { memberId: id.B });
    expect(ok.status).toBe(200);
    const gym = ((await B.get(url('/recurring'))).body.data as RecurringSeries[]).find(
      (x) => x.name === 'Gym',
    )!;
    // Ada can't see Bea's private card, nor its series: it doesn't exist for her.
    expect(
      (await A.request('PUT', url(`/recurring/${gym.id}/responsible`), { memberId: id.A })).status,
    ).toBe(404);
    // Bea can, but can't hand it to Ada, who can't see the card.
    const refused = await B.request('PUT', url(`/recurring/${gym.id}/responsible`), {
      memberId: id.A,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('member_cannot_see_account');
  });

  it('isn’t handed over by viewers [REC-04/VIEW]', async () => {
    const s = await make(A, bill(joint, 'Harbor Insurance'));
    expect(
      (await V.request('PUT', url(`/recurring/${s.id}/responsible`), { memberId: id.V })).status,
    ).toBe(403);
  });

  it('shows who looks after each date, and whether to say so', async () => {
    const m = (await B.get(url(`/recurring/month?month=${today.slice(0, 7)}`))).body
      .data as RecurringMonth;
    const power = m.occurrences.find((o) => o.name === 'Lakeside Power');
    expect(power).toMatchObject({ memberIds: [id.B], shared: true });
    const gym = m.occurrences.find((o) => o.name === 'Gym');
    expect(gym).toMatchObject({ memberIds: [id.B], shared: false });
  });

  it('shows who would look after a suggestion, to change before confirming', async () => {
    // Through this month's, once it's passed: a missed one would mean it had ended.
    for (const back of [4, 3, 2, 1, 0].filter((b) => `${monthsAgo(b)}-20` <= today)) {
      await B.post(url('/transactions'), {
        accountId: beas,
        date: `${monthsAgo(back)}-20`,
        amountMinor: -6_400,
        displayName: 'County Waste',
      });
    }
    const r = await A.get(url('/recurring/suggestions'));
    const found = r.body.data as DetectedSeries[];
    // Bea's checking is Bea's alone: hers, though Ada found it.
    expect(found.find((s) => s.name === 'County Waste')).toMatchObject({
      responsibleMemberId: id.B,
    });
  });

  it('tells notifications who to remind', async () => {
    const { db, close } = createDb(tdb.workerUrl, { max: 1 });
    try {
      const all = (await A.get(url('/recurring'))).body.data as RecurringSeries[];
      const power = all.find((s) => s.name === 'Lakeside Power')!;
      const pay = all.find((s) => s.name === 'Brightline Labs payroll')!;
      await withContext(db, systemContext(hh), async (tx) => {
        expect(await reminderRecipients(tx, power.id)).toEqual([id.B]);
        expect(await reminderRecipients(tx, pay.id)).toEqual([]);
        expect(await seriesLookedAfterBy(tx, id.B, today)).toContain(power.id);
        expect(await seriesLookedAfterBy(tx, id.A, today)).not.toContain(power.id);
      });
    } finally {
      await close();
    }
  });

  it('passes to the account’s other owner, or a household owner, when someone leaves', async () => {
    const onJoint = await make(A, bill(joint, 'Summit Internet', { responsibleMemberId: id.C }));
    const onBeas = await make(A, bill(beas, 'Dentist', { responsibleMemberId: id.C }));
    const onAdas = await make(A, bill(adasViewOnly, 'Parking', { responsibleMemberId: id.C }));
    expect((await C.post(url('/leave'))).status).toBe(204);
    // The joint account's owners share it equally: the first to join, Ada.
    expect((await one(A, onJoint.id))!.responsibleMemberId).toBe(id.A);
    expect((await one(A, onBeas.id))!.responsibleMemberId).toBe(id.B);
    expect((await one(A, onAdas.id))!.responsibleMemberId).toBe(id.A);
  });

  it('passes on when someone is removed, too', async () => {
    const s = await make(A, bill(beas, 'Library', { responsibleMemberId: id.V }));
    expect((await A.request('DELETE', url(`/members/${id.V}`))).status).toBe(204);
    expect((await one(B, s.id))!.responsibleMemberId).toBe(id.B);
  });
});
