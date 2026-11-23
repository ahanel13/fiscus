// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Consent requests (#265, ADR 0012 §Departures item 5, D34), for a split by income: owners and
 * members ask another member to agree; the person asked agrees (under Shared costs) or declines;
 * whoever asked withdraws. A request waits 14 days, and every step is in the household's
 * activity. Asking changes nothing by itself.
 */
describe('consent requests', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let C: TestClient;
  let V: TestClient;
  let hh = '';
  const member = { A: '', B: '', C: '', V: '' };
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const ask = (c: TestClient, memberId: string) =>
    c.post(url('/consent-requests'), { kind: 'income_split', memberId });
  const list = async (c: TestClient) => {
    const r = await c.get(url('/consent-requests'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as { id: string; status: string; memberId: string }[];
  };
  const actions = async () =>
    ((await A.get(url('/activity?limit=200'))).body.data as { action: string; targetId: string }[])
      .filter((e) => e.action.startsWith('consent_request.'))
      .map((e) => `${e.action} ${e.targetId}`);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@consent.test`,
        password: 'consent test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    C = await signup('cal');
    V = await signup('vic');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'roommates',
      })
    ).body.data.id;
    for (const [c, email, role] of [
      [B, 'bea@consent.test', 'member'],
      [C, 'cal@consent.test', 'member'],
      [V, 'vic@consent.test', 'viewer'],
    ] as const) {
      const invite = await A.post(url('/invites'), { email, role });
      await c.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    for (const m of (await A.get(url('/members'))).body.data as {
      id: string;
      displayName: string;
    }[]) {
      const key = { ada: 'A', bea: 'B', cal: 'C', vic: 'V' }[m.displayName] as keyof typeof member;
      member[key] = m.id;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  let toBea = '';

  it('[SHR-10/OWN] asks someone to agree, for 14 days, and everyone in the household sees it', async () => {
    const r = await ask(A, member.B);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    toBea = r.body.data.id;
    expect(r.body.data).toMatchObject({
      kind: 'income_split',
      requestedByMemberId: member.A,
      memberId: member.B,
      status: 'pending',
      closedAt: null,
    });
    const days =
      (Date.parse(r.body.data.expiresAt) - Date.parse(r.body.data.createdAt)) / 86_400_000;
    expect(days).toBe(14);
    for (const c of [A, B, C, V]) expect((await list(c)).map((x) => x.id)).toEqual([toBea]);
    expect(await actions()).toEqual([`consent_request.created ${toBea}`]);
  });

  it('changes nothing by itself: they haven’t agreed until they do', async () => {
    const s = (await A.get(url('/income-split'))).body.data;
    expect(s.members).toContainEqual({ memberId: member.B, consented: false });
  });

  it('[SHR-10/VIEW] asks each person once at a time, never yourself, a viewer, or as a viewer', async () => {
    expect((await ask(A, member.B)).body.code).toBe('already_asked');
    expect((await ask(C, member.B)).status).toBe(409);
    expect((await ask(A, member.A)).body.code).toBe('ask_yourself');
    expect((await ask(A, member.V)).body.code).toBe('cannot_agree');
    expect((await ask(V, member.A)).status).toBe(403);
    expect((await ask(A, crypto.randomUUID())).status).toBe(404);
  });

  it('lets only the person asked decline, and only whoever asked withdraw', async () => {
    expect((await C.post(url(`/consent-requests/${toBea}/decline`), {})).status).toBe(404);
    expect((await A.post(url(`/consent-requests/${toBea}/decline`), {})).status).toBe(404);
    expect((await B.post(url(`/consent-requests/${toBea}/withdraw`), {})).status).toBe(404);
    expect((await V.post(url(`/consent-requests/${toBea}/decline`), {})).status).toBe(403);
  });

  it('is answered by agreeing, and then there’s nothing left to ask', async () => {
    const r = await B.request('PUT', url('/income-split/consent'), { basis: 'actual' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await list(A)).find((x) => x.id === toBea)).toMatchObject({ status: 'accepted' });
    expect(await actions()).toContain(`consent_request.accepted ${toBea}`);
    expect((await ask(A, member.B)).body.code).toBe('already_agreed');
    expect((await B.post(url(`/consent-requests/${toBea}/decline`), {})).body.code).toBe(
      'request_ended',
    );
  });

  it('[SHR-10/MEM] can be declined, and asked again after', async () => {
    const first = (await ask(A, member.C)).body.data.id as string;
    const r = await C.post(url(`/consent-requests/${first}/decline`), {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'declined', closedAt: expect.any(String) });
    expect((await C.post(url(`/consent-requests/${first}/decline`), {})).status).toBe(409);
    // Declining isn't agreeing.
    const s = (await A.get(url('/income-split'))).body.data;
    expect(s.members).toContainEqual({ memberId: member.C, consented: false });

    const again = await ask(B, member.C);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const w = await B.post(url(`/consent-requests/${again.body.data.id}/withdraw`), {});
    expect(w.body.data).toMatchObject({ status: 'withdrawn' });
    expect(await actions()).toEqual(
      expect.arrayContaining([
        `consent_request.declined ${first}`,
        `consent_request.withdrawn ${again.body.data.id}`,
      ]),
    );
  });

  it('shows one whose 14 days are over as expired, and it can’t be answered', async () => {
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    let id = '';
    try {
      id = (
        await db.query(
          `INSERT INTO consent_requests (id, household_id, kind, requested_by_member_id,
             member_id, created_at, expires_at)
           VALUES (gen_random_uuid(), $1, 'income_split', $2, $3, now() - interval '15 days',
             now() - interval '1 day')
           RETURNING id`,
          [hh, member.A, member.C],
        )
      ).rows[0].id;
    } finally {
      await db.end();
    }
    expect((await list(C)).find((x) => x.id === id)).toMatchObject({ status: 'expired' });
    expect((await C.post(url(`/consent-requests/${id}/decline`), {})).body.code).toBe(
      'request_ended',
    );
    expect((await A.post(url(`/consent-requests/${id}/withdraw`), {})).body.code).toBe(
      'request_ended',
    );
    // Agreeing now doesn't answer it: it had already ended.
    await C.request('PUT', url('/income-split/consent'), { basis: 'actual' });
    expect((await list(A)).find((x) => x.id === id)).toMatchObject({ status: 'expired' });
  });
});
