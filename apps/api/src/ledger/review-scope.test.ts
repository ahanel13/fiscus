// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { Household, Transaction } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** What needs review (#508): every new transaction, or only the uncategorized ones. */
describe('what needs review', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let hh = '';
  let account = '';
  const cat: Record<string, string> = {};
  const url = (p = '') => `/api/v1/households/${hh}${p}`;

  const patch = async (path: string, body: Record<string, unknown>) => {
    const current = (await A.get(url(path))).body.data as { version: number };
    const r = await A.request('PATCH', url(path), body, {
      headers: { 'if-match': `"v${current.version}"` },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const scope = (reviewScope: Household['reviewScope']) =>
    patch('', { reviewScope }) as Promise<Household>;
  const arrive = async (name: string, categoryId: string | null) => {
    const t = (
      await A.post(url('/transactions'), {
        accountId: account,
        date: '2026-10-01',
        amountMinor: -1200,
        displayName: name,
        ...(categoryId ? { categoryId } : {}),
      })
    ).body.data as Transaction;
    await patch(`/transactions/${t.id}`, { reviewStatus: 'needs_review' });
    return t.id;
  };
  const queue = async () =>
    ((await A.get(url('/transactions?review=needs_review'))).body.data as Transaction[])
      .map((t) => t.displayName)
      .sort();
  const badge = async () =>
    (await A.get(url('/transactions/review-count'))).body.data.transactions as number;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    A = new TestClient(app);
    await A.post('/api/v1/auth/signup', {
      email: 'ada@review-scope.test',
      password: 'review scope Password1!',
      displayName: 'Ada',
    });
    // Categorizing here leaves the review flag, so each arrives categorized and needing review.
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'UTC',
        categorizeMarksReviewed: false,
      })
    ).body.data.id;
    account = (
      await A.post(url('/accounts'), {
        type: 'depository',
        name: 'Checking',
        visibility: 'private',
      })
    ).body.data.id;
    const groups = (await A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string; systemKey: string | null }[];
    }[];
    for (const c of groups.flatMap((g) => g.categories)) cat[c.systemKey ?? c.name] = c.id;
    await arrive('Shell', null);
    await arrive('Costco', cat.Groceries!);
    await arrive('Corner store', cat.uncategorized!);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('starts as every new transaction', async () => {
    expect((await A.get(url())).body.data.reviewScope).toBe('all');
    expect(await queue()).toEqual(['Corner store', 'Costco', 'Shell']);
    expect(await badge()).toBe(3);
  });

  it('can ask only about the uncategorized ones, at once', async () => {
    expect((await scope('uncategorized')).reviewScope).toBe('uncategorized');
    expect(await queue()).toEqual(['Corner store', 'Shell']);
    expect(await badge()).toBe(2);
    // The categorized one keeps its flag: switching back brings it back.
    await scope('all');
    expect(await badge()).toBe(3);
  });

  it('puts a transaction back when its category is cleared', async () => {
    await scope('uncategorized');
    const costco = ((await A.get(url('/transactions?q=Costco'))).body.data as Transaction[])[0]!;
    await patch(`/transactions/${costco.id}`, { categoryId: cat.uncategorized });
    expect(await queue()).toEqual(['Corner store', 'Costco', 'Shell']);
    await scope('all');
  });

  it('takes only the two choices', async () => {
    const r = await A.request('PATCH', url(), { reviewScope: 'some' });
    expect(r.status).toBe(422);
  });
});
