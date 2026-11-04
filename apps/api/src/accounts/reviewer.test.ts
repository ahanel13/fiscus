// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { Account, Transaction } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Who reviews an account's transactions (#45): their queue, their badge, nobody else's. */
describe('an account’s reviewer', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  const id = { A: '', B: '', V: '' };
  /** Ada's and Bea's, shared in full. */
  let joint = '';
  /** Ada's own, private. */
  let adas = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;

  const account = async (c: TestClient, accountId: string) =>
    ((await c.get(url('/accounts'))).body.data as Account[]).find((a) => a.id === accountId)!;
  const setReviewer = async (c: TestClient, accountId: string, memberId: string | null) => {
    const a = await account(c, accountId);
    return c.request(
      'PATCH',
      url(`/accounts/${accountId}`),
      { reviewerMemberId: memberId },
      { headers: { 'if-match': `"v${(a as Account & { version: number }).version}"` } },
    );
  };
  const toReview = async (c: TestClient, accountId: string, name: string) => {
    const t = (
      await c.post(url('/transactions'), {
        accountId,
        date: '2026-10-01',
        amountMinor: -1200,
        displayName: name,
      })
    ).body.data as Transaction & { version: number };
    const r = await c.request(
      'PATCH',
      url(`/transactions/${t.id}`),
      { reviewStatus: 'needs_review' },
      { headers: { 'if-match': `"v${t.version}"` } },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const queue = async (c: TestClient, mine: boolean) =>
    (
      (await c.get(url(`/transactions?review=needs_review${mine ? '&reviewer=me' : ''}`))).body
        .data as Transaction[]
    )
      .map((t) => t.displayName)
      .sort();
  const badge = async (c: TestClient) =>
    (await c.get(url('/transactions/review-count'))).body.data.transactions as number;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@reviewer.test`,
        password: 'reviewer test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
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
      [B, 'bea@reviewer.test', 'member'],
      [V, 'vic@reviewer.test', 'viewer'],
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
    const keys = { ada: 'A', bea: 'B', vic: 'V' } as const;
    for (const m of members) id[keys[m.displayName as keyof typeof keys]] = m.id;
    const make = async (body: Record<string, unknown>) => {
      const r = await A.post(url('/accounts'), { type: 'depository', ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.id as string;
    };
    joint = await make({
      name: 'Joint card',
      visibility: 'full',
      owners: [{ memberId: id.A }, { memberId: id.B }],
    });
    adas = await make({ name: 'Ada’s checking', visibility: 'private' });
    await toReview(A, joint, 'Costco');
    await toReview(A, adas, 'Shell');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('starts as nobody in particular: everyone who can review it does', async () => {
    expect((await account(A, joint)).reviewerMemberId).toBeNull();
    expect(await queue(A, true)).toEqual(['Costco', 'Shell']);
    expect(await queue(B, true)).toEqual(['Costco']);
    expect(await badge(A)).toBe(2);
    expect(await badge(B)).toBe(1);
  });

  it('puts the account in its reviewer’s queue and badge, and out of everyone else’s [ACC-13/OWN]', async () => {
    const r = await setReviewer(A, joint, id.B);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.reviewerMemberId).toBe(id.B);
    expect(await queue(A, true)).toEqual(['Shell']);
    expect(await queue(B, true)).toEqual(['Costco']);
    expect(await badge(A)).toBe(1);
    expect(await badge(B)).toBe(1);
    // Everyone's queue still has it, for whoever wants to look.
    expect(await queue(A, false)).toEqual(['Costco', 'Shell']);
    await setReviewer(A, joint, null);
    expect(await badge(A)).toBe(2);
  });

  it('is chosen by any of its owners [ACC-13/MEM]', async () => {
    const r = await setReviewer(B, joint, id.A);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await badge(B)).toBe(0);
    await setReviewer(B, joint, null);
  });

  it('is someone who can categorize its transactions, chosen by an owner [ACC-13/VIEW]', async () => {
    const notOwner = await setReviewer(A, adas, id.B);
    expect(notOwner.status).toBe(422);
    expect(notOwner.body.code).toBe('reviewer_cannot_review');
    const viewer = await setReviewer(A, joint, id.V);
    expect(viewer.status).toBe(422);
    // Only owners change it.
    expect((await setReviewer(V, joint, id.A)).status).toBe(403);
  });
});
