// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Prorated shared costs (#261, ADR 0012 §Joining, walkthrough D33). Ada pays this month's rent,
 * 3,000.00, for Ada, Bea and Cy. Cy joined on the 16th, so with Rent's rule prorating, Cy pays for
 * the days from the 16th on and Ada and Bea cover the rest. When Bea leaves on the 11th, Bea pays
 * for the first ten days.
 */
describe('shared costs: prorated for people who join or leave', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  const c: Record<'A' | 'B' | 'C', TestClient> = {} as never;
  const member = { A: '', B: '', C: '' };
  let hh = '';
  let rent = '';
  let acct = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const month = new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const sql = async (text: string, values: unknown[]) => {
    const db = new pg.Client({ connectionString: tdb.maintenanceUrl });
    await db.connect();
    try {
      return await db.query(text, values);
    } finally {
      await db.end();
    }
  };
  const costs = async (who: keyof typeof c) => {
    const r = await c[who].get(url(`/shared-costs?month=${month}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const setRule = (rule: unknown) =>
    c.A.request('PUT', url(`/split-rules/categories/${rent}`), {
      rule,
      effectiveFrom: `${month}-01`,
    });
  const owedBy = (balances: { memberId: string; amountMinor: number }[], k: 'B' | 'C') =>
    balances.find((b) => b.memberId === member[k])?.amountMinor;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const names = { A: 'ada', B: 'bea', C: 'cy' } as const;
    for (const [k, name] of Object.entries(names) as [keyof typeof names, string][]) {
      c[k] = new TestClient(app);
      await c[k].post('/api/v1/auth/signup', {
        email: `${name}@prorate.test`,
        password: 'prorate test Password1!',
        displayName: name,
      });
    }
    hh = (
      await c.A.post('/api/v1/households', {
        name: 'Flat',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'roommates',
      })
    ).body.data.id;
    for (const k of ['B', 'C'] as const) {
      const invite = await c.A.post(url('/invites'), { email: `${names[k]}@prorate.test` });
      await c[k].post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    for (const x of (await c.A.get(url('/members'))).body.data as {
      id: string;
      displayName: string;
    }[]) {
      const k = (Object.keys(names) as (keyof typeof names)[]).find(
        (n) => names[n] === x.displayName,
      )!;
      member[k] = x.id;
    }
    // A household set up long ago, with Ada and Bea since then; Cy from the 16th.
    await sql(`UPDATE households SET created_at = $2::timestamptz WHERE id = $1`, [
      hh,
      '2025-01-01T00:00:00Z',
    ]);
    await sql(
      `UPDATE household_members SET joined_at = $2::timestamptz, history_from = NULL
        WHERE household_id = $1 AND id <> $3`,
      [hh, '2025-01-01T00:00:00Z', member.C],
    );
    await sql(`UPDATE household_members SET joined_at = $2::timestamptz WHERE id = $1`, [
      member.C,
      `${month}-16T09:00:00Z`,
    ]);
    for (const g of (await c.A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[]) {
      for (const x of g.categories) if (x.name === 'Rent or mortgage') rent = x.id;
    }
    acct = (
      await c.A.post(url('/accounts'), {
        name: 'Ada card',
        type: 'depository',
        visibility: 'private',
      })
    ).body.data.id;
    const r = await c.A.post(url('/transactions'), {
      accountId: acct,
      date: `${month}-01`,
      amountMinor: -300000,
      displayName: 'Rent',
      categoryId: rent,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const at = await c.A.request('PUT', url(`/transactions/${r.body.data.id}/attribution`), {
      attribution: [{ memberId: member.A }, { memberId: member.B }, { memberId: member.C }],
    });
    expect(at.status, JSON.stringify(at.body)).toBe(204);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('splits evenly while the rule doesn’t prorate', async () => {
    const res = await setRule({ method: 'equal' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const a = await costs('A');
    expect(owedBy(a.balances, 'B')).toBe(100000);
    expect(owedBy(a.balances, 'C')).toBe(100000);
    expect(a.expenses[0].prorated).toEqual([]);
  });

  it('charges someone who joined mid-month for their days, and says so', async () => {
    const res = await setRule({ method: 'equal', prorate: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.rule).toEqual({ method: 'equal', prorate: true });

    const cyDays = days - 15;
    const a = await costs('A');
    expect(
      Math.abs(owedBy(a.balances, 'C')! - (300000 * cyDays) / (2 * days + cyDays)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(owedBy(a.balances, 'B')! - (300000 * days) / (2 * days + cyDays)),
    ).toBeLessThanOrEqual(1);
    expect(a.expenses[0].prorated).toEqual([{ memberId: member.C, days: cyDays, ofDays: days }]);
    // Cy sees the same from their side.
    const cy = await costs('C');
    expect(cy.balances).toEqual([{ memberId: member.A, amountMinor: -owedBy(a.balances, 'C')! }]);
  });

  it('charges someone who left mid-month for their days before', async () => {
    await sql(`UPDATE household_members SET left_at = $2::timestamptz WHERE id = $1`, [
      member.B,
      `${month}-11T18:00:00Z`,
    ]);
    const a = await costs('A');
    const total = days + 10 + (days - 15);
    expect(Math.abs(owedBy(a.balances, 'B')! - (300000 * 10) / total)).toBeLessThanOrEqual(1);
    expect(a.expenses[0].prorated).toEqual(
      expect.arrayContaining([
        { memberId: member.B, days: 10, ofDays: days },
        { memberId: member.C, days: days - 15, ofDays: days },
      ]),
    );
  });

  it('counts everyone who joined in the month the household was set up from the start', async () => {
    await sql(`UPDATE households SET created_at = $2::timestamptz WHERE id = $1`, [
      hh,
      `${month}-02T00:00:00Z`,
    ]);
    const a = await costs('A');
    // Cy joined in the household's first month; only Bea, who left, is prorated.
    expect(a.expenses[0].prorated).toEqual([{ memberId: member.B, days: 10, ofDays: days }]);
  });

  it('never prorates the household default, which covers one-off costs too', async () => {
    const res = await c.A.request('PUT', url('/split-rules/default'), {
      rule: { method: 'equal', prorate: true },
      effectiveFrom: `${month}-01`,
    });
    expect(res.status).toBe(422);
  });
});
