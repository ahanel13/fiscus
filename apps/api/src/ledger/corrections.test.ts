// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { TransactionCorrection } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * What people and files chose (#528): the transactions whose name, category or tags someone set,
 * beside the bank's text, for suggesting rules. Visible as on Transactions.
 */
describe('transaction corrections', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client;
  let A: TestClient;
  let B: TestClient;
  let hh: string;
  const cats = new Map<string, string>();
  let shared = '';
  let hidden = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;

  /** As sync writes it: the bank's text, nothing anyone chose. */
  const fromBank = async (accountId: string, description: string, date: string) =>
    (
      await owner.query(
        `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency,
           authorized_date, posted_date, original_description, display_name, source)
         VALUES (gen_random_uuid(), $1, $2, -1500, 'USD', $3, $3, $4, $4, 'provider') RETURNING id`,
        [hh, accountId, date, description],
      )
    ).rows[0].id as string;
  const patch = async (c: TestClient, id: string, body: Record<string, unknown>) => {
    const t = (await c.get(url(`/transactions/${id}`))).body.data;
    const r = await c.request('PATCH', url(`/transactions/${id}`), body, {
      headers: { 'if-match': `"v${t.version}"` },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const corrections = async (c: TestClient, query = '') => {
    const r = await c.get(url(`/transactions/corrections${query}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { data: TransactionCorrection[]; meta: { nextCursor: string | null } };
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@corrections.test`,
        password: 'corrections test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('Ada');
    B = await signup('Bea');
    hh = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
    const invite = await A.post(url('/invites'), { email: 'bea@corrections.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    for (const g of (await A.get(url('/categories'))).body.data) {
      for (const c of g.categories) cats.set(c.name, c.id);
    }
    const account = async (name: string, visibility: string) =>
      (await A.post(url('/accounts'), { name, type: 'depository', visibility })).body.data
        .id as string;
    shared = await account('Joint-ish checking', 'full');
    hidden = await account('Ada’s own', 'private');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await owner?.end();
    await tdb?.stop();
  });

  it('lists what someone chose beside the bank’s text, not what the bank alone said', async () => {
    const coffee = await fromBank(shared, 'SQ *BLUE BOTTLE 0423', '2026-04-03');
    await fromBank(shared, 'ACH PAYROLL ACME', '2026-04-04');
    await patch(A, coffee, { categoryId: cats.get('Coffee'), displayName: 'Blue Bottle' });

    const { data } = await corrections(A);
    expect(data).toEqual([
      {
        id: coffee,
        accountId: shared,
        date: '2026-04-03',
        amountMinor: -1500,
        currency: 'USD',
        originalDescription: 'SQ *BLUE BOTTLE 0423',
        displayName: 'Blue Bottle',
        categoryId: cats.get('Coffee'),
        tagIds: [],
        set: ['displayName', 'categoryId'],
        source: 'provider',
      },
    ]);
  });

  it('shows only what the caller can see, and pages newest first', async () => {
    const mine = await fromBank(hidden, 'TRADER JOES #552', '2026-04-05');
    await patch(A, mine, { categoryId: cats.get('Groceries') });
    const t = await A.post(url('/tags'), { name: 'Treats', color: '#d97706' });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const tag = t.body.data.id as string;
    const created = await A.post(url('/transactions'), {
      accountId: shared,
      date: '2026-04-06',
      amountMinor: -800,
      displayName: 'Bakery',
      tagIds: [tag],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const typed = created.body.data.id as string;

    expect((await corrections(A)).data.map((c) => c.id)).toHaveLength(3);
    const bea = (await corrections(B)).data;
    expect(bea.map((c) => c.id)).not.toContain(mine);
    expect(bea[0]).toMatchObject({ id: typed, source: 'manual', tagIds: [tag] });
    expect(bea[0]!.set).toEqual(['displayName', 'tagIds']);

    const first = await corrections(A, '?limit=2');
    expect(first.data.map((c) => c.date)).toEqual(['2026-04-06', '2026-04-05']);
    const second = await corrections(A, `?limit=2&cursor=${first.meta.nextCursor}`);
    expect(second.data.map((c) => c.date)).toEqual(['2026-04-03']);
    expect(second.meta.nextCursor).toBeNull();

    expect((await corrections(A, '?since=2026-04-05')).data).toHaveLength(2);
  });
});
