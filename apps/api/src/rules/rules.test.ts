// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
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
  const csv = (accountId: string, rows: [string, number, string?][], by = A) =>
    runImport(by, url(), {
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
    // Named from the bank's text (#42); no rule touched it.
    expect(byAmount(-3000)).toMatchObject({ displayName: 'Shell Oil', categoryId: null });
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
        changes: { displayName: ['Costco Whse', 'Costco'] },
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
    const cys = await rule(C, {
      scope: 'mine',
      conditions: { description: { op: 'contains', value: 'hulu' } },
      actions: { markReviewed: true },
    });
    expect((await C.post(url('/leave'))).status).toBeLessThan(300);
    // Their own rules go with them; the household's they wrote wait for someone to adopt them.
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      const left = await db.query('SELECT id FROM rules WHERE id = ANY($1)', [[hulu, cys]]);
      expect(left.rows.map((r) => r.id)).toEqual([hulu]);
    } finally {
      await db.end();
    }
    const listed = (
      (await A.get(url('/rules'))).body.data as { id: string; authorLeft: boolean }[]
    ).find((r) => r.id === hulu);
    expect(listed?.authorLeft).toBe(true);
    expect((await A.post(url(`/rules/${hulu}/apply`))).body.data).toEqual({ changed: 0 });
    await A.request('PATCH', url(`/rules/${hulu}`), { enabled: true });
    expect((await A.post(url(`/rules/${hulu}/apply`))).body.data).toEqual({ changed: 1 });
  });

  // Rules of your own (#58). These come last: the ones above see the household's rules only.
  describe('of your own', () => {
    const listed = async (c: TestClient) =>
      ((await c.get(url('/rules'))).body.data as { id: string; scope: string }[]).map(
        (r) => `${r.scope}:${r.id}`,
      );
    const categoryOf = async (accountId: string, amountMinor: number) =>
      (await txns(accountId)).find((t) => t.amountMinor === amountMinor)?.categoryId;
    const joint = (shares: [number, number]) =>
      account(A, `Joint ${shares.join('/')}`, {
        visibility: 'full',
        owners: [
          { memberId: ada, shareBps: shares[0] },
          { memberId: bea, shareBps: shares[1] },
        ],
      });

    it('only their member sees, edits, reorders, and deletes them', async () => {
      const first = await rule(B, {
        scope: 'mine',
        conditions: { description: { op: 'contains', value: 'zzz first' } },
        actions: { markReviewed: true },
      });
      const second = await rule(B, {
        scope: 'mine',
        conditions: { description: { op: 'contains', value: 'zzz second' } },
        actions: { markReviewed: true },
      });
      const household = await rule(B, {
        conditions: { description: { op: 'contains', value: 'zzz household' } },
        actions: { markReviewed: true },
      });
      const bs = await listed(B);
      // The household's first, then yours.
      expect(bs.slice(-1)).toEqual([`mine:${second}`]);
      expect(bs.indexOf(`household:${household}`)).toBeLessThan(bs.indexOf(`mine:${first}`));
      expect((await listed(A)).some((r) => r.endsWith(first) || r.endsWith(second))).toBe(false);
      expect((await A.request('PATCH', url(`/rules/${first}`), { enabled: false })).status).toBe(
        404,
      );
      expect((await A.request('DELETE', url(`/rules/${first}`))).status).toBe(404);
      expect((await A.post(url(`/rules/${first}/apply`))).status).toBe(404);
      expect((await A.request('PUT', url('/rules/order'), { ids: [first] })).status).toBe(404);

      const edited = await B.request('PATCH', url(`/rules/${first}`), { name: 'Mine' });
      expect(edited.body.data).toMatchObject({ scope: 'mine', authorMemberId: bea });
      // Reordered within their scope only.
      expect((await B.request('PUT', url('/rules/order'), { ids: [second, first] })).status).toBe(
        204,
      );
      expect((await listed(B)).slice(-2)).toEqual([`mine:${second}`, `mine:${first}`]);
      const mixed = await B.request('PUT', url('/rules/order'), { ids: [second, household] });
      expect(mixed.status).toBe(422);
      expect(mixed.body.code).toBe('mixed_scopes');
      // Not in the household's activity feed either.
      const feed = (await A.get(url('/activity?limit=100'))).body.data as { targetId: string }[];
      expect(feed.some((e) => e.targetId === first)).toBe(false);
      expect(feed.some((e) => e.targetId === household)).toBe(true);
      for (const id of [first, second, household]) {
        expect((await B.request('DELETE', url(`/rules/${id}`))).status).toBe(204);
      }
    });

    it('on an account you own alone, run after the household’s, so yours win', async () => {
      const acc = await account(A, 'Ada alone', { visibility: 'full' });
      await rule(A, {
        scope: 'mine',
        conditions: { description: { op: 'contains', value: 'pizza place' } },
        actions: { categoryId: dining },
      });
      await rule(A, {
        conditions: { description: { op: 'contains', value: 'pizza place' } },
        actions: { categoryId: groceries },
      });
      // Bea's own rules don't run on Ada's account, though Bea could categorize it by hand.
      await rule(B, {
        scope: 'mine',
        conditions: { description: { op: 'contains', value: 'pizza place' } },
        actions: { rename: 'Bea’s pizza' },
      });
      await csv(acc, [['PIZZA PLACE 12', -2100]]);
      const [t] = await txns(acc);
      expect(t?.categoryId).toBe(dining);
      expect(t?.displayName).not.toBe('Bea’s pizza');
    });

    it('on a joint account, every owner’s run: by share, largest first, so the smaller share’s win', async () => {
      const acc = await joint([4000, 6000]);
      await rule(A, {
        scope: 'mine',
        conditions: { description: { op: 'contains', value: 'bakery' } },
        actions: { categoryId: dining },
      });
      await rule(B, {
        scope: 'mine',
        conditions: { description: { op: 'contains', value: 'bakery' } },
        actions: { categoryId: groceries, markReviewed: true },
      });
      // Ada imports it: Bea's rules run too, though Ada can't see them.
      await csv(acc, [['BAKERY ON MAIN', -650]]);
      const [t] = await txns(acc);
      // Bea (60%) first, then Ada (40%): Ada's category wins; Bea's "reviewed" stays.
      expect(t).toMatchObject({ categoryId: dining, reviewStatus: 'reviewed' });

      // An import by Bea runs them in the same order.
      await csv(acc, [['BAKERY ON MAIN', -651]], B);
      expect(await categoryOf(acc, -651)).toBe(dining);
    });

    it('on a joint account with equal shares, by member id', async () => {
      const acc = await joint([5000, 5000]);
      await rule(A, {
        scope: 'mine',
        conditions: { description: { op: 'contains', value: 'florist' } },
        actions: { categoryId: dining },
      });
      await rule(B, {
        scope: 'mine',
        conditions: { description: { op: 'contains', value: 'florist' } },
        actions: { categoryId: groceries },
      });
      await csv(acc, [['FLORIST', -3000]]);
      // The later member id runs last, and wins.
      expect(await categoryOf(acc, -3000)).toBe(ada > bea ? dining : groceries);
    });

    it('[RULE-05] reach only the accounts their member owns, applied to existing too', async () => {
      const adas = await account(A, 'Ada full again', { visibility: 'full' });
      const beas = await account(B, 'Bea’s own', { visibility: 'full' });
      await csv(adas, [['BOOKSHOP', -1800]]);
      await csv(beas, [['BOOKSHOP', -1801]], B);
      const draft = {
        conditions: { description: { op: 'contains', value: 'bookshop' } },
        actions: { categoryId: dining },
      };
      // As the household's, Bea's rule would reach Ada's full account; as hers, only her own.
      const asHousehold = (await B.post(url('/rules/preview'), draft)).body.data.changes;
      expect(
        asHousehold.map((c: { amountMinor: number }) => c.amountMinor).sort((x, y) => x - y),
      ).toEqual([-1801, -1800]);
      const preview = await B.post(url('/rules/preview'), { scope: 'mine', ...draft });
      expect(preview.body.data.changes).toEqual([expect.objectContaining({ amountMinor: -1801 })]);
      const id = await rule(B, { scope: 'mine', ...draft });
      expect((await B.post(url(`/rules/${id}/apply`))).body.data).toEqual({ changed: 1 });
      expect(await categoryOf(beas, -1801)).toBe(dining);
      expect(await categoryOf(adas, -1800)).toBeNull();
      // A transfer still needs both accounts to be yours.
      const refused = await B.post(url('/rules'), {
        scope: 'mine',
        conditions: { description: { op: 'contains', value: 'bookshop' } },
        actions: { transferTo: { accountId: adas } },
      });
      expect(refused.body.code).toBe('invalid_account');
    });
  });
});
