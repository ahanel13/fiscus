// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Each member's own arrangement of the accounts list (ACC-12, #48): groups and order, private to
 * them, over the accounts they can see. Ada owns every account; Bea is a member who sees all but
 * the private one.
 */
describe('account layout', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let ada: TestClient;
  let bea: TestClient;
  let hid = '';
  const acct = {} as Record<'checking' | 'savings' | 'card' | 'secret', string>;
  const url = (path: string) => `/api/v1/households/${hid}${path}`;

  const signup = async (name: string) => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: `${name.toLowerCase()}@layout.test`,
      password: 'account layout Password1!',
      displayName: name,
    });
    return c;
  };
  const layout = async (c: TestClient, body: unknown) =>
    c.request('PUT', url('/account-layout'), body);
  const order = async (c: TestClient) =>
    ((await c.get(url('/accounts?include=closed'))).body.data as { id: string }[]).map((a) => a.id);
  const setVisibility = async (id: string, visibility: string) => {
    const { version } = (await ada.get(url(`/accounts/${id}`))).body.data;
    const r = await ada.request(
      'PATCH',
      url(`/accounts/${id}`),
      { visibility },
      { headers: { 'if-match': `"v${version}"` } },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    ada = await signup('Ada');
    hid = (
      await ada.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
    bea = await signup('Bea');
    const invite = await ada.post(url('/invites'), { email: 'bea@layout.test', role: 'member' });
    const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
    expect((await bea.post('/api/v1/invites/accept', { token })).status).toBe(200);

    for (const [key, name, type, visibility] of [
      ['checking', 'A Checking', 'depository', 'full'],
      ['savings', 'B Savings', 'depository', 'full'],
      ['card', 'C Card', 'credit', 'full'],
      ['secret', 'D Secret', 'depository', 'private'],
    ] as const) {
      const r = await ada.post(url('/accounts'), { name, type, visibility });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      acct[key] = r.body.data.id;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('starts empty, with accounts in the household order', async () => {
    expect((await ada.get(url('/account-layout'))).body.data).toEqual({
      groups: [],
      ungrouped: [],
    });
    expect(await order(ada)).toEqual([acct.checking, acct.savings, acct.card, acct.secret]);
  });

  it('lists accounts in your order, and only yours', async () => {
    const r = await layout(ada, {
      groups: [{ name: 'Everyday', accountIds: [acct.card, acct.savings] }],
      ungrouped: [acct.secret],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const group = r.body.data.groups[0];
    expect(r.body.data).toEqual({
      groups: [{ id: group.id, name: 'Everyday', accountIds: [acct.card, acct.savings] }],
      ungrouped: [acct.secret],
    });
    // Groups first, then placed accounts, then the rest in the household's order.
    expect(await order(ada)).toEqual([acct.card, acct.savings, acct.secret, acct.checking]);
    // Bea's list is untouched, and she can't see Ada's arrangement.
    expect(await order(bea)).toEqual([acct.checking, acct.savings, acct.card]);
    expect((await bea.get(url('/account-layout'))).body.data).toEqual({
      groups: [],
      ungrouped: [],
    });
  });

  it('keeps a group by its id, renames and reorders it, and deletes groups left out', async () => {
    const [everyday] = (await ada.get(url('/account-layout'))).body.data.groups;
    const r = await layout(ada, {
      groups: [
        { name: 'Cards', accountIds: [acct.card] },
        { id: everyday.id, name: 'Banking', accountIds: [acct.savings] },
      ],
      ungrouped: [],
    });
    expect(r.body.data.groups.map((g: { name: string }) => g.name)).toEqual(['Cards', 'Banking']);
    expect(r.body.data.groups[1].id).toBe(everyday.id);

    const cleared = await layout(ada, { groups: [], ungrouped: [] });
    expect(cleared.body.data).toEqual({ groups: [], ungrouped: [] });
    expect(await order(ada)).toEqual([acct.checking, acct.savings, acct.card, acct.secret]);
  });

  it("refuses an account you can't see exactly as one that doesn't exist", async () => {
    const hidden = await layout(bea, { groups: [], ungrouped: [acct.secret] });
    const missing = await layout(bea, { groups: [], ungrouped: [randomUUID()] });
    expect(hidden.status).toBe(422);
    expect(hidden.body.code).toBe('unknown_account');
    const strip = (b: Record<string, unknown>) => ({ ...b, instance: undefined });
    expect(strip(hidden.body)).toEqual(strip(missing.body));
  });

  it("refuses someone else's group, and an account in two places", async () => {
    const ours = await layout(ada, { groups: [{ name: 'Mine', accountIds: [] }], ungrouped: [] });
    const adaGroup = ours.body.data.groups[0].id;
    const r = await layout(bea, {
      groups: [{ id: adaGroup, name: 'Taken', accountIds: [acct.checking] }],
      ungrouped: [],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('unknown_group');
    // Ada's group is untouched.
    expect((await ada.get(url('/account-layout'))).body.data.groups).toEqual([
      { id: adaGroup, name: 'Mine', accountIds: [] },
    ]);

    const twice = await layout(bea, {
      groups: [{ name: 'Both', accountIds: [acct.checking] }],
      ungrouped: [acct.checking],
    });
    expect(twice.status).toBe(422);
    expect(twice.body.code).toBe('validation_failed');
    await layout(ada, { groups: [], ungrouped: [] });
  });

  it('puts an account back where you left it when you can see it again', async () => {
    await layout(bea, {
      groups: [{ name: 'Saving', accountIds: [acct.savings] }],
      ungrouped: [acct.card],
    });
    await setVisibility(acct.savings, 'private');
    // Out of sight: out of the layout, and replacing the layout doesn't forget it.
    const hidden = (await bea.get(url('/account-layout'))).body.data;
    expect(hidden.groups[0].accountIds).toEqual([]);
    await layout(bea, {
      groups: [{ id: hidden.groups[0].id, name: 'Saving', accountIds: [] }],
      ungrouped: [acct.checking, acct.card],
    });

    await setVisibility(acct.savings, 'full');
    expect((await bea.get(url('/account-layout'))).body.data).toEqual({
      groups: [{ id: hidden.groups[0].id, name: 'Saving', accountIds: [acct.savings] }],
      ungrouped: [acct.checking, acct.card],
    });
    expect(await order(bea)).toEqual([acct.savings, acct.checking, acct.card]);
  });

  it("records arranging as activity that isn't shown to the household", async () => {
    const feed = await ada.get(url('/activity?limit=200'));
    expect(feed.status).toBe(200);
    expect(JSON.stringify(feed.body)).not.toContain('account_layout');
  });
});
