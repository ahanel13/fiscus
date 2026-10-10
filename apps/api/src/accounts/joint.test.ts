// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { MEMBER_COLORS } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Your name and color in a household (#51, HH-18), and "make all accounts joint" (#225). */
describe('members and finance style', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const members = async (c: TestClient) =>
    (await c.get(url('/members'))).body.data as {
      id: string;
      displayName: string;
      color: string;
      isYou: boolean;
    }[];

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@joint.test`,
        password: 'joint test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    hh = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
    const invite = await A.post(url('/invites'), { email: 'bea@joint.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('changes your own name and color, never to a color someone else has', async () => {
    const before = await members(B);
    const ada = before.find((m) => !m.isYou)!;
    const free = MEMBER_COLORS.find((c) => !before.some((m) => m.color === c))!;
    const r = await B.request('PATCH', url('/me'), { displayName: 'Bea H.', color: free });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const me = (await members(A)).find((m) => m.displayName === 'Bea H.');
    expect(me?.color).toBe(free);
    expect((await B.request('PATCH', url('/me'), { color: ada.color })).body.code).toBe(
      'color_taken',
    );
    expect((await B.request('PATCH', url('/me'), { color: '#000000' })).status).toBe(422);
  });

  it('makes all your accounts joint with full visibility, and leaves others’ alone', async () => {
    const add = async (c: TestClient, name: string, visibility: string) =>
      (await c.post(url('/accounts'), { name, type: 'depository', visibility })).body.data
        .id as string;
    const mine = await add(A, 'Ada checking', 'view_only');
    const savings = await add(A, 'Ada savings', 'private');
    const beas = await add(B, 'Bea checking', 'view_only');

    const r = await A.post(url('/accounts/make-joint'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ changed: 2 });
    for (const id of [mine, savings]) {
      const account = (await B.get(url(`/accounts/${id}`))).body.data;
      expect(account.visibility).toBe('full');
      expect(account.owners).toHaveLength(2);
      expect(account.yourAccess).toBe('owner');
    }
    const theirs = (await B.get(url(`/accounts/${beas}`))).body.data;
    expect([theirs.owners.length, theirs.visibility]).toEqual([1, 'view_only']);

    // Again: nothing left to change.
    expect((await A.post(url('/accounts/make-joint'))).body.data).toEqual({ changed: 0 });
  });
});
