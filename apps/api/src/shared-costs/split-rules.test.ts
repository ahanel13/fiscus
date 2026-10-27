// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Split rules (#109): the default and rules for categories, each from a month on. */
describe('split rules', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  const member = { A: '', B: '' };
  let pets = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  /** The first of the month `n` months from this one (UTC, the household's time zone). */
  const monthStart = (n: number) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
      .toISOString()
      .slice(0, 10);
  };
  const [lastMonth, thisMonth, nextMonth] = [monthStart(-1), monthStart(0), monthStart(1)];
  const list = async () =>
    (await A.get(url('/split-rules'))).body.data as {
      earliestMonth: string;
      policies: {
        id: string;
        categoryId: string | null;
        effectiveFrom: string;
        rule: unknown;
      }[];
    };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@split.test`,
        password: 'split test Password1!',
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
        timezone: 'UTC',
        financeStyle: 'separate',
      })
    ).body.data.id;
    const invite = await A.post(url('/invites'), { email: 'bea@split.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    for (const m of (await A.get(url('/members'))).body.data as { id: string; isYou: boolean }[]) {
      member[m.isYou ? 'A' : 'B'] = m.id;
    }
    pets = (
      (await A.get(url('/categories'))).body.data as {
        categories: { id: string; name: string }[];
      }[]
    )
      .flatMap((g) => g.categories)
      .find((c) => c.name === 'Pets')!.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('starts with no rules, from this month', async () => {
    expect(await list()).toEqual({ earliestMonth: thisMonth, policies: [] });
  });

  it('sets the default and a category’s rule, from this month or later', async () => {
    const shares = [
      { memberId: member.A, shareBps: 6000 },
      { memberId: member.B, shareBps: 4000 },
    ];
    const r = await A.request('PUT', url('/split-rules/default'), {
      rule: { method: 'fixed_percent', shares },
      effectiveFrom: thisMonth,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      categoryId: null,
      effectiveFrom: thisMonth,
      rule: { method: 'fixed_percent', shares },
    });

    const pet = await B.request('PUT', url(`/split-rules/categories/${pets}`), {
      rule: { method: 'fixed_amount', amounts: [{ memberId: member.B, amountMinor: 4000 }] },
      effectiveFrom: nextMonth,
    });
    expect(pet.status, JSON.stringify(pet.body)).toBe(200);
    expect((await list()).policies.map((p) => [p.categoryId, p.effectiveFrom])).toEqual([
      [null, thisMonth],
      [pets, nextMonth],
    ]);
  });

  it('replaces a change from the same month, rather than adding another', async () => {
    const r = await A.request('PUT', url('/split-rules/default'), {
      rule: { method: 'equal' },
      effectiveFrom: thisMonth,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const defaults = (await list()).policies.filter((p) => p.categoryId === null);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.rule).toEqual({ method: 'equal' });
  });

  it('never reaches back before this month', async () => {
    const r = await A.request('PUT', url('/split-rules/default'), {
      rule: { method: 'equal' },
      effectiveFrom: lastMonth,
    });
    expect([r.status, r.body.code]).toEqual([422, 'split_month_started']);
    // Not the first of a month.
    const mid = await A.request('PUT', url('/split-rules/default'), {
      rule: { method: 'equal' },
      effectiveFrom: `${nextMonth.slice(0, 8)}15`,
    });
    expect(mid.status).toBe(422);
  });

  it('names only people in the household, and doesn’t take split by income yet', async () => {
    const stranger = await A.request('PUT', url('/split-rules/default'), {
      rule: {
        method: 'fixed_percent',
        shares: [
          { memberId: member.A, shareBps: 5000 },
          { memberId: '01a17bf3-0000-7000-8000-000000000000', shareBps: 5000 },
        ],
      },
      effectiveFrom: nextMonth,
    });
    expect([stranger.status, stranger.body.code]).toEqual([422, 'split_unknown_member']);
    const income = await A.request('PUT', url('/split-rules/default'), {
      rule: { method: 'income_proportional' },
      effectiveFrom: nextMonth,
    });
    expect(income.status).toBe(422);
    // Shares that don't add up to 100%.
    const short = await A.request('PUT', url('/split-rules/default'), {
      rule: {
        method: 'fixed_percent',
        shares: [
          { memberId: member.A, shareBps: 5000 },
          { memberId: member.B, shareBps: 4000 },
        ],
      },
      effectiveFrom: nextMonth,
    });
    expect(short.status).toBe(422);
  });

  it('cancels a change that hasn’t started, and keeps one that has', async () => {
    const { policies } = await list();
    const scheduled = policies.find((p) => p.categoryId === pets)!;
    const started = policies.find((p) => p.categoryId === null)!;
    expect((await B.delete(url(`/split-rules/${scheduled.id}`))).status).toBe(204);
    const r = await A.delete(url(`/split-rules/${started.id}`));
    expect([r.status, r.body.code]).toEqual([409, 'split_rule_started']);
    expect((await list()).policies.map((p) => p.id)).toEqual([started.id]);
  });

  it('sends a category back to the default', async () => {
    const r = await A.request('PUT', url(`/split-rules/categories/${pets}`), {
      rule: null,
      effectiveFrom: nextMonth,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ categoryId: pets, rule: null });
  });
});
