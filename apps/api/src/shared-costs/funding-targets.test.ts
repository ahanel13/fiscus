// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Joint-account funding targets (#113, ADR 0006 §7.3): what each owner moves into a joint account
 * per period, read from the transfers in from their own accounts, even ones the reader can't see.
 */
describe('funding targets', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let C: TestClient;
  let hh = '';
  const member = { A: '', B: '', C: '' };
  const acct = { joint: '', ada: '', bea: '', hidden: '', solo: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const month = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 7);
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const list = async (c: TestClient) => {
    const r = await c.get(url('/funding-targets'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as {
      today: string;
      accounts: {
        accountId: string;
        ownerIds: string[];
        targets: {
          memberId: string;
          status: string;
          contributedMinor: number;
          differenceMinor: number;
          leftThisPeriodMinor: number;
          current: { from: string; contributedMinor: number } | null;
          recent: { from: string; contributedMinor: number }[];
        }[];
      }[];
    };
  };
  const targetOf = async (c: TestClient, memberId: string, accountId = acct.joint) =>
    (await list(c)).accounts
      .find((a) => a.accountId === accountId)
      ?.targets.find((t) => t.memberId === memberId);
  const put = (c: TestClient, accountId: string, memberId: string, body: unknown) =>
    c.request('PUT', url(`/funding-targets/${accountId}/${memberId}`), body);
  /** Moves money from `from` into `to` as `c`, linked as a transfer. */
  const transfer = async (
    c: TestClient,
    from: string,
    to: string,
    amountMinor: number,
    date: string,
  ) => {
    const out = await c.post(url('/transactions'), {
      accountId: from,
      date,
      amountMinor: -amountMinor,
      displayName: 'To joint',
    });
    const into = await c.post(url('/transactions'), {
      accountId: to,
      date,
      amountMinor,
      displayName: 'From own',
    });
    expect([out.status, into.status]).toEqual([201, 201]);
    const link = await c.post(url(`/transactions/${out.body.data.id}/transfer`), {
      transactionId: into.body.data.id,
    });
    expect([200, 409], JSON.stringify(link.body)).toContain(link.status);
    expect(
      (await c.get(url(`/transactions/${into.body.data.id}`))).body.data.transfer,
    ).not.toBeNull();
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@funding.test`,
        password: 'funding test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    C = await signup('cy');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'separate',
      })
    ).body.data.id;
    for (const [c, email] of [
      [B, 'bea@funding.test'],
      [C, 'cy@funding.test'],
    ] as const) {
      const invite = await A.post(url('/invites'), { email });
      await c.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    for (const m of (await A.get(url('/members'))).body.data as {
      id: string;
      displayName: string;
    }[]) {
      member[m.displayName === 'ada' ? 'A' : m.displayName === 'bea' ? 'B' : 'C'] = m.id;
    }
    const account = async (c: TestClient, name: string, visibility: string, owners?: string[]) => {
      const r = await c.post(url('/accounts'), {
        name,
        type: 'depository',
        visibility,
        ...(owners ? { owners: owners.map((memberId) => ({ memberId })) } : {}),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.id as string;
    };
    acct.ada = await account(A, 'Ada checking', 'private');
    acct.bea = await account(B, 'Bea checking', 'private');
    acct.solo = await account(A, 'Ada savings', 'full');
    acct.joint = await account(A, 'Joint checking', 'full', [member.A, member.B]);
    acct.hidden = await account(A, 'Joint savings', 'private', [member.A, member.B]);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('lists the joint accounts you own, with no targets yet', async () => {
    const seen = await list(A);
    expect(seen.today).toBe(today());
    expect(seen.accounts.map((a) => a.accountId).sort()).toEqual([acct.joint, acct.hidden].sort());
    expect(seen.accounts.every((a) => a.targets.length === 0)).toBe(true);
    // Cy owns neither, and nothing has a target yet.
    expect((await list(C)).accounts).toEqual([]);
  });

  it('sets fixed targets for each owner, from any owner', async () => {
    const ada = await put(A, acct.joint, member.A, {
      method: 'fixed',
      amountMinor: 100_000,
      cadence: 'monthly',
    });
    expect(ada.status, JSON.stringify(ada.body)).toBe(204);
    const bea = await put(A, acct.joint, member.B, {
      method: 'fixed',
      amountMinor: 80_000,
      cadence: 'monthly',
      startsOn: `${month(-1)}-01`,
    });
    expect(bea.status, JSON.stringify(bea.body)).toBe(204);
    expect(await targetOf(B, member.A)).toMatchObject({
      status: 'on_track',
      contributedMinor: 0,
      leftThisPeriodMinor: 100_000,
      current: { from: `${month(0)}-01` },
    });
    // Bea's started last month, and nothing came in then.
    expect(await targetOf(B, member.B)).toMatchObject({
      status: 'behind',
      differenceMinor: 80_000,
      leftThisPeriodMinor: 160_000,
    });
  });

  it('counts transfers in from each owner’s own accounts, even ones others can’t see', async () => {
    await transfer(B, acct.bea, acct.joint, 50_000, `${month(-1)}-10`);
    await transfer(A, acct.ada, acct.joint, 100_000, today());
    // Bea can't see Ada's checking, yet sees the money came from Ada.
    expect(await targetOf(B, member.A)).toMatchObject({
      status: 'on_track',
      contributedMinor: 100_000,
      leftThisPeriodMinor: 0,
    });
    const bea = await targetOf(A, member.B);
    expect(bea).toMatchObject({ status: 'behind', differenceMinor: 30_000 });
    expect(bea!.recent.map((p) => [p.from, p.contributedMinor])).toEqual([
      [`${month(0)}-01`, 0],
      [`${month(-1)}-01`, 50_000],
    ]);
    // Catching up puts Bea back on track; more than this month's puts Ada ahead.
    await transfer(B, acct.bea, acct.joint, 30_000, today());
    expect((await targetOf(A, member.B))!.status).toBe('on_track');
    await transfer(A, acct.ada, acct.joint, 20_000, today());
    expect(await targetOf(B, member.A)).toMatchObject({ status: 'ahead', differenceMinor: 20_000 });
  });

  it('doesn’t count money from one joint account to another, or from someone else', async () => {
    await transfer(A, acct.hidden, acct.joint, 999_00, today());
    expect((await targetOf(A, member.A))!.contributedMinor).toBe(120_000);
  });

  it('shows targets to whoever sees the account’s transactions, and only they', async () => {
    // Cy sees the joint checking in full, so sees its targets, and can't change them.
    const seen = (await list(C)).accounts.map((a) => a.accountId);
    expect(seen).toEqual([acct.joint]);
    expect(
      (await put(C, acct.joint, member.A, { method: 'fixed', amountMinor: 1, cadence: 'weekly' }))
        .status,
    ).toBe(403);
    expect(
      (await C.request('DELETE', url(`/funding-targets/${acct.joint}/${member.A}`))).status,
    ).toBe(403);
    // The private joint savings doesn't exist for Cy.
    await put(A, acct.hidden, member.A, { method: 'fixed', amountMinor: 5_000, cadence: 'weekly' });
    expect((await list(C)).accounts.map((a) => a.accountId)).toEqual([acct.joint]);
    expect(
      (await put(C, acct.hidden, member.A, { method: 'fixed', amountMinor: 1, cadence: 'weekly' }))
        .status,
    ).toBe(404);
  });

  it('refuses targets that don’t fit', async () => {
    const fixed = { method: 'fixed', amountMinor: 10_000, cadence: 'monthly' };
    // Cy doesn't own the account.
    const r1 = await put(A, acct.joint, member.C, fixed);
    expect([r1.status, r1.body.code]).toEqual([422, 'funding_not_an_owner']);
    // Ada's savings has one owner.
    const r2 = await put(A, acct.solo, member.A, fixed);
    expect([r2.status, r2.body.code]).toEqual([422, 'funding_not_joint']);
    // A share of income waits for consent (#110).
    expect(
      (
        await put(A, acct.joint, member.A, {
          method: 'percent_of_income',
          percentBps: 1000,
          cadence: 'monthly',
        })
      ).status,
    ).toBe(422);
    expect(
      (await put(A, acct.joint, member.A, { ...fixed, startsOn: `${month(0)}-15` })).status,
    ).toBe(422);
    expect((await put(A, acct.joint, member.A, { ...fixed, amountMinor: 0 })).status).toBe(422);
  });

  it('changes a target in place, and removes one, each in the activity', async () => {
    const r = await put(B, acct.joint, member.B, {
      method: 'fixed',
      amountMinor: 20_000,
      cadence: 'weekly',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const bea = await targetOf(A, member.B);
    // Counting starts again today, a week at a time; today's 30.00 is in.
    expect(bea).toMatchObject({
      status: 'ahead',
      contributedMinor: 30_000,
      differenceMinor: 10_000,
    });
    expect(bea!.current!.from).toBe(today());

    const del = await B.request('DELETE', url(`/funding-targets/${acct.joint}/${member.B}`));
    expect(del.status).toBe(204);
    expect(await targetOf(A, member.B)).toBeUndefined();
    expect(
      (await B.request('DELETE', url(`/funding-targets/${acct.joint}/${member.B}`))).status,
    ).toBe(404);

    const feed = (await A.get(url('/activity?limit=200'))).body.data as { action: string }[];
    const actions = feed.map((e) => e.action);
    expect(actions).toContain('funding_target.set');
    expect(actions).toContain('funding_target.removed');
  });
});
