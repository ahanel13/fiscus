// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { resolveRange, todayIn } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Time ranges on the API (ADR 0011, #64, #65, #67, #69). */
describe('time ranges', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  let checking = '';
  let transfers = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const txn = async (date: string, amountMinor: number, extra: Record<string, unknown> = {}) => {
    const r = await A.post(url('/transactions'), {
      accountId: checking,
      date,
      amountMinor,
      displayName: 'T',
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const household = async () => (await A.get(url())).body.data;
  const patchHousehold = async (body: Record<string, unknown>) =>
    A.request('PATCH', url(), body, {
      headers: { 'if-match': `"v${(await household()).version}"` },
    });

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@ranges.test`,
        password: 'ranges test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'America/Denver',
      })
    ).body.data.id;
    const invite = await A.post(url('/invites'), { email: 'bea@ranges.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    checking = (await A.post(url('/accounts'), { name: 'Checking', type: 'depository' })).body.data
      .id;
    const groups = (await A.get(url('/categories'))).body.data;
    transfers = groups
      .flatMap((g: { categories: { id: string; systemKey: string | null }[] }) => g.categories)
      .find((c: { systemKey: string | null }) => c.systemKey === 'transfer').id;
    // Jan: nothing. Feb: +3000 −1000. Mar: −2000 and a transfer that doesn't count. Apr 1–10 only.
    await txn('2026-02-03', 300000);
    await txn('2026-02-10', -100000);
    await txn('2026-03-05', -200000);
    await txn('2026-03-06', -50000, { categoryId: transfers });
    const excluded = await txn('2026-03-07', -99900);
    const v = (await A.get(url(`/transactions/${excluded}`))).body.data.version;
    await A.request(
      'PATCH',
      url(`/transactions/${excluded}`),
      { excluded: true },
      { headers: { 'if-match': `"v${v}"` } },
    );
    await txn('2026-04-10', -40000);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('filters transactions by a range and says what it resolved to', async () => {
    const r = await A.get(url('/transactions?range=custom&from=2026-03-01&to=2026-03-31'));
    expect(r.body.meta.range).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-31',
      partial: false,
    });
    expect(r.body.data.map((t: { date: string }) => t.date).sort()).toEqual([
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
    ]);
    const preset = await A.get(url('/transactions?range=last_30d'));
    const expected = resolveRange(
      { kind: 'preset', preset: 'last_30d' },
      { timeZone: 'America/Denver', weekStart: 1, fiscalYearStartMonth: 1 },
    );
    expect(preset.body.meta.range).toMatchObject({ from: expected.from, to: expected.to });
    expect((await A.get(url('/transactions?range=custom&from=2026-03-01'))).status).toBe(422);
  });

  it('counts cash flow per month, marking cut-off months and averaging only complete ones with data', async () => {
    const r = await A.get(
      url('/cash-flow?range=custom&from=2026-01-01&to=2026-04-10&granularity=month'),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const flow = r.body.data;
    expect(flow.buckets).toEqual([
      // Before the first transaction: no data, not zero.
      {
        start: '2026-01-01',
        end: '2026-01-31',
        partial: false,
        incomeMinor: null,
        spendingMinor: null,
        netMinor: null,
      },
      {
        start: '2026-02-01',
        end: '2026-02-28',
        partial: false,
        incomeMinor: 300000,
        spendingMinor: 100000,
        netMinor: 200000,
      },
      // The transfer and the excluded purchase don't count.
      {
        start: '2026-03-01',
        end: '2026-03-31',
        partial: false,
        incomeMinor: 0,
        spendingMinor: 200000,
        netMinor: -200000,
      },
      {
        start: '2026-04-01',
        end: '2026-04-10',
        partial: true,
        incomeMinor: 0,
        spendingMinor: 40000,
        netMinor: -40000,
      },
    ]);
    expect(flow.totals).toEqual({ incomeMinor: 300000, spendingMinor: 340000, netMinor: -40000 });
    // Feb and Mar only: Jan has no data, Apr is cut off.
    expect(flow.averages).toEqual({ incomeMinor: 150000, spendingMinor: 150000, netMinor: 0 });
  });

  it('compares with the previous period', async () => {
    const r = await A.get(
      url('/cash-flow?range=custom&from=2026-03-01&to=2026-03-31&compare=previous_period'),
    );
    expect(r.body.data.range.comparison).toEqual({ from: '2026-01-29', to: '2026-02-28' });
    expect(r.body.data.comparison).toEqual({
      incomeMinor: 300000,
      spendingMinor: 100000,
      netMinor: 200000,
    });
  });

  it('follows the spending lens', async () => {
    const mine = await A.get(url('/cash-flow?range=custom&from=2026-02-01&to=2026-02-28&lens=me'));
    expect(mine.body.data.totals.incomeMinor).toBe(300000);
    // Ada's account isn't shared with Bea's spending: nothing is attributed to Bea.
    const beas = await A.get(
      url(
        `/cash-flow?range=custom&from=2026-02-01&to=2026-02-28&lens=member:${(await B.get(url())).body.data.you.memberId}`,
      ),
    );
    expect(beas.body.data.totals).toEqual({ incomeMinor: 0, spendingMinor: 0, netMinor: 0 });
  });

  it('values net worth at the end of each month', async () => {
    const r = await A.get(
      url('/net-worth?range=custom&from=2026-01-01&to=2026-03-31&granularity=month'),
    );
    // The balance is the running total of the account's transactions. Transfers and excluded
    // purchases still move money, so they count here even though cash flow leaves them out.
    const series = r.body.data.series.map((p: { date: string; netWorthMinor: number }) => [
      p.date,
      p.netWorthMinor,
    ]);
    expect(series).toEqual([
      ['2026-01-31', 0],
      ['2026-02-28', 200000],
      ['2026-03-31', 200000 - 200000 - 50000 - 99900],
    ]);
    expect(r.body.data.range).toMatchObject({ granularity: 'month' });
  });

  it('dates transactions by the purchase day when the household asks (#69)', async () => {
    // Imported rows have both dates; manual ones use the same date for both.
    const id = await txn('2026-05-20', -1000);
    expect((await A.get(url(`/transactions/${id}`))).body.data.date).toBe('2026-05-20');
    expect((await patchHousehold({ dateBasis: 'authorized' })).status).toBe(200);
    const listed = await A.get(url('/transactions?range=custom&from=2026-05-20&to=2026-05-20'));
    expect(listed.body.data.map((t: { id: string }) => t.id)).toEqual([id]);
    expect((await patchHousehold({ dateBasis: 'posted' })).status).toBe(200);
  });

  it('follows the household’s fiscal year', async () => {
    expect((await patchHousehold({ fiscalYearStartMonth: 7 })).status).toBe(200);
    const r = await A.get(url('/transactions?range=ytd'));
    const today = todayIn('America/Denver');
    const fiscalStart =
      Number(today.slice(5, 7)) >= 7
        ? `${today.slice(0, 4)}-07-01`
        : `${Number(today.slice(0, 4)) - 1}-07-01`;
    expect(r.body.meta.range.from).toBe(fiscalStart);
    expect((await patchHousehold({ fiscalYearStartMonth: 1 })).status).toBe(200);
  });

  it('keeps each member’s preferences to themselves', async () => {
    expect(
      (await A.request('PUT', url('/preferences/range:reports'), { value: 'last_6m' })).status,
    ).toBe(204);
    expect((await A.get(url('/preferences'))).body.data).toEqual({ 'range:reports': 'last_6m' });
    expect((await B.get(url('/preferences'))).body.data).toEqual({});
    expect((await B.request('DELETE', url('/preferences/range:reports'))).status).toBe(404);
    expect((await A.request('PUT', url('/preferences/Bad Key'), { value: 1 })).status).toBe(422);
    expect((await A.request('DELETE', url('/preferences/range:reports'))).status).toBe(204);
  });
});
