import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from './testing/test-app.js';

/**
 * Generated from the route table (ADR 0005, permissions §7): every household route is called from
 * household A's session with household B's ids and must answer 404. New routes are covered
 * automatically; a new kind of path parameter fails the suite until it gets a filler below.
 */
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
      password: 'tenant test password',
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
    const b = await household(bob, 'B');
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
    // B also gets a second member, so member routes have a non-owner target.
    const token = new URLSearchParams(new URL(inviteB.body.data.url).hash.slice(1)).get('token')!;
    await carol.post('/api/v1/invites/accept', { token });
    ids.b.otherMemberId = (await bob.get(`/api/v1/households/${b.id}/members`)).body.data.find(
      (m: { isYou: boolean }) => !m.isYou,
    ).id;
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
        param === 'memberId' ? (values.otherMemberId ?? values.memberId) : values[param];
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
    expect(household).toMatchObject({ name: 'B', version: 1 });
  });
});
