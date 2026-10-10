// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../testing/imports.js';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Rules (docs/design/imports.md §3, #41, permissions RULE-01–07). */
describe('rules', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  let ada = '';
  let bea = '';
  let groceries = '';
  let dining = '';
  let uncategorized = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const account = async (c: TestClient, name: string, extra: Record<string, unknown> = {}) =>
    (await c.post(url('/accounts'), { name, type: 'depository', ...extra })).body.data.id as string;
  const rule = async (c: TestClient, body: Record<string, unknown>) => {
    const r = await c.post(url('/rules'), body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const txns = async (accountId: string) =>
    (await A.get(url(`/transactions?accounts=${accountId}&limit=200`))).body.data as {
      id: string;
      amountMinor: number;
      displayName: string;
      categoryId: string | null;
      reviewStatus: string;
      excluded: boolean;
      tagIds: string[];
      attribution: { memberId: string }[];
      version: number;
    }[];
  const csv = (accountId: string, rows: [string, number, string?][]) =>
    runImport(A, url(), {
      format: 'csv',
      filename: 'bank.csv',
      accounts: [{ key: 'file', accountId }],
      transactions: rows.map(([description, amountMinor, category], i) => ({
        line: i + 2,
        account: 'file',
        date: '2026-04-01',
        amountMinor,
        description,
        ...(category ? { category } : {}),
      })),
    });

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@rules.test`,
        password: 'rules test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('Ada');
    B = await signup('Bea');
    hh = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
    const invite = await A.post(url('/invites'), { email: 'bea@rules.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    ada = (await A.get(url())).body.data.you.memberId;
    bea = (await B.get(url())).body.data.you.memberId;
    const cats = (
      (await A.get(url('/categories'))).body.data as {
        categories: { id: string; name: string; systemKey: string | null }[];
      }[]
    ).flatMap((g) => g.categories);
    groceries = cats.find((c) => c.name === 'Groceries')!.id;
    dining = cats.find((c) => c.name === 'Restaurants')!.id;
    uncategorized = cats.find((c) => c.systemKey === 'uncategorized')!.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('runs on imports, in order, a later rule winning, and leaves what the file supplied', async () => {
    const acc = await account(A, 'Rules checking');
    const tag = (await A.post(url('/tags'), { name: 'Food', color: '#2f6fdb' })).body.data.id;
    await rule(A, {
      conditions: { description: { op: 'contains', value: 'trader joe' } },
      actions: { rename: 'Trader Joe’s', categoryId: dining, addTagIds: [tag], markReviewed: true },
    });
    await rule(A, {
      conditions: { description: { op: 'contains', value: 'TRADER' }, direction: 'out' },
      actions: { categoryId: groceries },
    });
    const r = await csv(acc, [
      ['TRADER JOE S #123', -4512],
      ['TRADER JOE S #123', -999, 'Restaurants'], // the file says what it is
      ['TRADER JOE S #9', -500, 'Uncategorized'], // not a decision: rules fill it in
      ['SHELL OIL', -3000],
    ]);
    expect(r.res.status, JSON.stringify(r.res.body)).toBe(200);
    const rows = await txns(acc);
    const byAmount = (n: number) => rows.find((t) => t.amountMinor === n);
    expect(byAmount(-4512)).toMatchObject({
      displayName: 'Trader Joe’s',
      categoryId: groceries, // the later rule wins
      reviewStatus: 'reviewed',
      tagIds: [tag],
    });
    expect(byAmount(-999)).toMatchObject({ categoryId: dining }); // from the file, kept
    expect(byAmount(-500)).toMatchObject({ categoryId: groceries });
    expect(byAmount(-3000)).toMatchObject({ displayName: 'SHELL OIL', categoryId: null });
    expect(uncategorized).toBeTruthy();
  });

  it('never changes what a person set, by hand or in bulk', async () => {
    const acc = await account(A, 'Hand checking');
    const id = (
      await A.post(url('/transactions'), {
        accountId: acc,
        date: '2026-04-02',
        amountMinor: -1200,
        displayName: 'COSTCO WHSE',
      })
    ).body.data.id as string;
    const imported = await csv(acc, [['COSTCO WHSE #55', -8000]]);
    expect(imported.added).toBe(1);
    const other = (await txns(acc)).find((t) => t.id !== id)!;
    // Categorized in bulk by a person: a rule mustn't undo it.
    await A.request('PATCH', url('/transactions'), {
      ids: [other.id],
      changes: { categoryId: dining },
    });
    const costco = await rule(A, {
      conditions: { description: { op: 'contains', value: 'costco' } },
      actions: { rename: 'Costco', categoryId: groceries },
    });
    const preview = await A.post(url('/rules/preview'), {
      conditions: { description: { op: 'contains', value: 'costco' } },
      actions: { rename: 'Costco', categoryId: groceries },
    });
    // The hand-entered one keeps its name; the imported one keeps its bulk category.
    expect(preview.body.data.changes).toEqual([
      expect.objectContaining({ transactionId: id, changes: { categoryId: [null, groceries] } }),
      expect.objectContaining({
        transactionId: other.id,
        changes: { displayName: ['COSTCO WHSE #55', 'Costco'] },
      }),
    ]);
    expect((await A.post(url(`/rules/${costco}/apply`))).body.data).toEqual({ changed: 2 });
    expect((await A.post(url(`/rules/${costco}/apply`))).body.data).toEqual({ changed: 0 });
  });

  it('[RULE-05] [EDGE-10] reaches only as far as its author could by hand, re-checked each run', async () => {
    const adaFull = await account(A, 'Ada full', { visibility: 'full' });
    const adaView = await account(A, 'Ada view', { visibility: 'view_only' });
    for (const a of [adaFull, adaView]) await csv(a, [['NETFLIX.COM', -1599]]);
    // Bea's rule: she has full access to one account and view-only to the other.
    const netflix = await rule(B, {
      conditions: { description: { op: 'contains', value: 'netflix' } },
      actions: { categoryId: dining, exclude: true, attribution: [{ memberId: bea }] },
    });
    // Ada applies it: Ada could do everything, but the rule acts with Bea's reach.
    expect((await A.post(url(`/rules/${netflix}/apply`))).body.data).toEqual({ changed: 1 });
    const [full] = await txns(adaFull);
    expect(full).toMatchObject({ categoryId: dining, excluded: false });
    expect(full!.attribution.map((x) => x.memberId)).toEqual([ada]); // inherited, unchanged
    expect((await txns(adaView))[0]).toMatchObject({ categoryId: null });

    // Ada takes away Bea's access: the rule stops reaching that account.
    const v = (await A.get(url(`/accounts/${adaFull}`))).body.data.version;
    await A.request(
      'PATCH',
      url(`/accounts/${adaFull}`),
      { visibility: 'view_only' },
      {
        headers: { 'if-match': `"v${v}"` },
      },
    );
    await csv(adaFull, [['NETFLIX.COM ', -1600]]);
    const later = (await txns(adaFull)).find((t) => t.categoryId === null);
    expect(later).toBeDefined();
  });

  it('editing a rule makes you its author, so its reach becomes yours', async () => {
    const adaOwn = await account(A, 'Ada private', { visibility: 'private' });
    await csv(adaOwn, [['SPOTIFY', -999]]);
    const spotify = await rule(B, {
      conditions: { description: { op: 'contains', value: 'spotify' } },
      actions: { categoryId: dining },
    });
    expect((await A.post(url(`/rules/${spotify}/apply`))).body.data).toEqual({ changed: 0 });
    const edited = await A.request('PATCH', url(`/rules/${spotify}`), { name: 'Spotify' });
    expect(edited.body.data.authorMemberId).toBe(ada);
    expect((await A.post(url(`/rules/${spotify}/apply`))).body.data).toEqual({ changed: 1 });
  });

  it('lists rules in order, reorders them, and deletes them', async () => {
    const ids = ((await A.get(url('/rules'))).body.data as { id: string }[]).map((r) => r.id);
    const reversed = [...ids].reverse();
    expect((await A.request('PUT', url('/rules/order'), { ids: reversed })).status).toBe(204);
    expect(((await B.get(url('/rules'))).body.data as { id: string }[]).map((r) => r.id)).toEqual(
      reversed,
    );
    expect((await A.request('DELETE', url(`/rules/${ids[0]}`))).status).toBe(204);
    expect((await A.get(url('/rules'))).body.data).toHaveLength(ids.length - 1);
    expect(
      (await A.post(url('/rules'), { conditions: {}, actions: { markReviewed: true } })).status,
    ).toBe(422);
  });

  it('[RULE-07] a rule whose author left doesn’t run until someone adopts it by editing it', async () => {
    const C = new TestClient(app);
    await C.post('/api/v1/auth/signup', {
      email: 'cy@rules.test',
      password: 'rules test Password1!',
      displayName: 'Cy',
    });
    const invite = await A.post(url('/invites'), { email: 'cy@rules.test', role: 'member' });
    await C.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    const acc = await account(A, 'Shared', { visibility: 'full' });
    await csv(acc, [['HULU', -799]]);
    const hulu = await rule(C, {
      conditions: { description: { op: 'contains', value: 'hulu' } },
      actions: { categoryId: dining },
    });
    expect((await C.post(url('/leave'))).status).toBeLessThan(300);
    const listed = (
      (await A.get(url('/rules'))).body.data as { id: string; authorLeft: boolean }[]
    ).find((r) => r.id === hulu);
    expect(listed?.authorLeft).toBe(true);
    expect((await A.post(url(`/rules/${hulu}/apply`))).body.data).toEqual({ changed: 0 });
    await A.request('PATCH', url(`/rules/${hulu}`), { enabled: true });
    expect((await A.post(url(`/rules/${hulu}/apply`))).body.data).toEqual({ changed: 1 });
  });
});
