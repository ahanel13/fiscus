// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { RecurringMonth, RecurringSeries, RecurringSuggestion } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Recurring series (#118; bills walkthrough §1–§3; permissions REC-01–03). */
describe('recurring series', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let V: TestClient;
  let hh = '';
  let joint = '';
  let mine = '';
  let lastPaycheck = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const today = new Date().toISOString().slice(0, 10);
  /** The 1st and the 15th of the last four months: $2,600 on the 1st, $2,450 on the 15th. */
  const paychecks = (() => {
    const out: [string, number][] = [];
    const now = new Date();
    for (let back = 4; back >= 1; back--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      const month = d.toISOString().slice(0, 7);
      out.push([`${month}-01`, 260_000], [`${month}-15`, 245_000]);
    }
    return out;
  })();

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@recurring.test`,
        password: 'recurring test Password1!',
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
      [B, 'bea@recurring.test', 'member'],
      [V, 'vic@recurring.test', 'viewer'],
    ] as const) {
      const invite = await A.post(url('/invites'), { email, role });
      await c.post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    joint = (
      await A.post(url('/accounts'), { name: 'Checking', type: 'depository', visibility: 'full' })
    ).body.data.id;
    mine = (
      await A.post(url('/accounts'), { name: 'My card', type: 'credit', visibility: 'private' })
    ).body.data.id;
    for (const [date, amountMinor] of paychecks) {
      const r = await A.post(url('/transactions'), {
        accountId: joint,
        date,
        amountMinor,
        displayName: 'Brightline Labs payroll',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      lastPaycheck = r.body.data.id;
    }
    // Something else in the same account, which no paycheck series should pick up.
    await A.post(url('/transactions'), {
      accountId: joint,
      date: paychecks[3]![0],
      amountMinor: 1_250,
      displayName: 'Interest',
    });
    await A.post(url('/transactions'), {
      accountId: mine,
      date: paychecks[0]![0],
      amountMinor: -1_549,
      displayName: 'Streamly',
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('suggests a series from a paycheck: twice a month, with room for both amounts', async () => {
    const r = await A.get(url(`/recurring/suggest?transactionId=${lastPaycheck}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = r.body.data as RecurringSuggestion;
    expect(s.kind).toBe('income');
    expect(s.name).toBe('Brightline Labs payroll');
    expect(s.draft.schedule).toMatchObject({ unit: 'month', every: 1, days: [1, 15] });
    expect(s.draft.match.direction).toBe('in');
    expect(s.draft.match.amount!.min).toBeLessThanOrEqual(245_000);
    expect(s.draft.match.amount!.max).toBeGreaterThanOrEqual(260_000);
  });

  it('previews what it would match, and makes it [REC-02/OWN]', async () => {
    const s = (await A.get(url(`/recurring/suggest?transactionId=${lastPaycheck}`))).body
      .data as RecurringSuggestion;
    const preview = await A.post(url('/recurring/preview'), s.draft);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.paidCount).toBe(8);
    expect(preview.body.data.next).toHaveLength(6);
    expect(preview.body.data.next[0] >= today).toBe(true);
    // The last three: $2,450 on the 15th, $2,600 on the 1st, $2,450 on the 15th before.
    expect(preview.body.data.estimateMinor).toBe(250_000);

    const made = await A.post(url('/recurring'), { ...s.draft, name: 'Paycheck', kind: 'income' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const series = made.body.data as RecurringSeries;
    expect(series.paidCount).toBe(8);
    expect(series.recent[0]!.date).toBe(paychecks[7]![0]);
    expect(series.next! >= today).toBe(true);
  });

  it('matches by its conditions: an amount range leaves the rest out', async () => {
    const r = await A.post(url('/recurring/preview'), {
      accountId: joint,
      match: { direction: 'in', amount: { min: 250_000 } },
      schedule: { unit: 'month', every: 1, days: [1], anchor: paychecks[0]![0], weekend: 'before' },
    });
    expect(r.body.data.paidCount).toBe(4);
    expect(r.body.data.estimateMinor).toBe(260_000);
  });

  it('is read by everyone who sees its account [REC-01/OWN] [REC-01/MEM] [REC-01/VIEW]', async () => {
    for (const c of [A, B, V]) {
      const list = (await c.get(url('/recurring'))).body.data as RecurringSeries[];
      expect(list.map((s) => s.name)).toEqual(['Paycheck']);
    }
  });

  it('is made by members, but not viewers [REC-02/MEM] [REC-02/VIEW]', async () => {
    const draft = {
      accountId: joint,
      name: 'Interest',
      kind: 'income',
      match: { direction: 'in', amount: { max: 5_000 } },
      schedule: { unit: 'month', every: 1, days: [-1], anchor: today, weekend: 'as_is' },
    };
    expect((await V.post(url('/recurring'), draft)).status).toBe(403);
    const made = await B.post(url('/recurring'), draft);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await B.delete(url(`/recurring/${made.body.data.id}`))).status).toBe(204);
  });

  it('stays with its account: a private card’s series is its owner’s alone [REC-03]', async () => {
    const draft = {
      accountId: mine,
      name: 'Streamly',
      kind: 'subscription',
      match: { direction: 'out', description: { op: 'equals', value: 'Streamly' } },
      schedule: { unit: 'month', every: 1, days: [1], anchor: paychecks[0]![0], weekend: 'as_is' },
    };
    // Bea can't see the card, so can't make a series on it either.
    expect((await B.post(url('/recurring'), draft)).status).toBe(404);
    const made = await A.post(url('/recurring'), draft);
    expect(made.status).toBe(201);
    const names = async (c: TestClient) =>
      ((await c.get(url('/recurring'))).body.data as RecurringSeries[]).map((s) => s.name);
    expect(await names(A)).toEqual(['Paycheck', 'Streamly']);
    expect(await names(B)).toEqual(['Paycheck']);
    expect(
      (await B.request('PATCH', url(`/recurring/${made.body.data.id}`), { name: 'x' })).status,
    ).toBe(404);
  });

  /** `YYYY-MM`, this many months ago. */
  const monthsAgo = (n: number) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1))
      .toISOString()
      .slice(0, 7);
  };

  it('shows a month: what was paid, and what came in [REC-01]', async () => {
    const r = await A.get(url(`/recurring/month?month=${monthsAgo(1)}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = r.body.data as RecurringMonth;
    // Which dates fall in it depends on the calendar: the 1st can move into the month before.
    const paid = m.occurrences.filter((o) => o.name === 'Paycheck' && o.status === 'paid');
    expect(paid.length).toBeGreaterThan(0);
    for (const o of paid) expect([260_000, 245_000]).toContain(o.payment!.amountMinor);
    expect(m.totals.incomeReceivedMinor).toBe(
      paid.reduce((sum, o) => sum + o.payment!.amountMinor!, 0),
    );
  });

  it('a date nothing paid is late; it can be skipped, or marked paid by another payment', async () => {
    const [m3, m2, m1] = [monthsAgo(3), monthsAgo(2), monthsAgo(1)];
    for (const [date, displayName] of [
      [`${m3}-10`, 'Cascade Water'],
      [`${m2}-10`, 'Cascade Water'],
      [`${m1}-20`, 'Check 1042'],
    ]) {
      await A.post(url('/transactions'), {
        accountId: joint,
        date,
        amountMinor: -6_420,
        displayName,
      });
    }
    const series = (
      await A.post(url('/recurring'), {
        accountId: joint,
        name: 'Water',
        kind: 'bill',
        match: { direction: 'out', description: { op: 'equals', value: 'Cascade Water' } },
        schedule: { unit: 'month', every: 1, days: [10], anchor: `${m3}-10`, weekend: 'as_is' },
      })
    ).body.data as RecurringSeries;
    const water = async () =>
      (
        (await A.get(url(`/recurring/month?month=${m1}`))).body.data as RecurringMonth
      ).occurrences.find((o) => o.seriesId === series.id)!;
    expect((await water()).status).toBe('late');

    const at = url(`/recurring/${series.id}/occurrences/${m1}-10`);
    expect((await V.request('PUT', at, { status: 'skipped' })).status).toBe(403);
    expect((await A.request('PUT', at, { status: 'skipped' })).status).toBe(204);
    expect((await water()).status).toBe('skipped');

    const check = (
      (await A.get(url(`/transactions?accounts=${joint}&limit=200`))).body.data as {
        id: string;
        displayName: string;
      }[]
    ).find((t) => t.displayName === 'Check 1042')!;
    expect((await A.request('PUT', at, { status: 'paid', transactionId: check.id })).status).toBe(
      204,
    );
    const paid = await water();
    expect(paid.status).toBe('paid');
    expect(paid.payment).toMatchObject({ transactionId: check.id, amountMinor: -6_420 });

    expect((await A.request('DELETE', at)).status).toBe(204);
    expect((await water()).status).toBe('late');
    // Not one of its dates.
    expect(
      (
        await A.request('PUT', url(`/recurring/${series.id}/occurrences/${m1}-11`), {
          status: 'skipped',
        })
      ).status,
    ).toBe(422);
    await A.delete(url(`/recurring/${series.id}`));
  });

  it('shows a card’s statement from the bank, paid once enough has gone in [REC-03]', async () => {
    const m1 = monthsAgo(1);
    const db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    try {
      await db.query(
        `INSERT INTO account_liabilities (account_id, household_id, minimum_payment_minor,
           next_due_date, last_statement_balance_minor, last_statement_date)
         VALUES ($1, $2, 3500, $3, -50000, $4)`,
        [mine, hh, `${m1}-21`, `${monthsAgo(2)}-25`],
      );
    } finally {
      await db.end();
    }
    const statement = async (c: TestClient) =>
      (
        (await c.get(url(`/recurring/month?month=${m1}`))).body.data as RecurringMonth
      ).occurrences.find((o) => o.kind === 'statement');
    expect(await statement(A)).toMatchObject({
      status: 'late',
      expectedMinor: -50_000,
      minimumMinor: 3_500,
    });
    // Bea can't see the card, nor its statement.
    expect(await statement(B)).toBeUndefined();
    await A.post(url('/transactions'), {
      accountId: mine,
      date: `${m1}-15`,
      amountMinor: 50_000,
      displayName: 'Payment, thank you',
    });
    expect(await statement(A)).toMatchObject({ status: 'paid', paidSoFarMinor: 50_000 });
  });

  it('ends: no next date after it', async () => {
    const [series] = ((await A.get(url('/recurring'))).body.data as RecurringSeries[]).filter(
      (s) => s.name === 'Paycheck',
    );
    const ended = await A.request('PATCH', url(`/recurring/${series!.id}`), { endedOn: today });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.data.endedOn).toBe(today);
    // Due today at the latest: anything after has gone.
    expect(ended.body.data.next === null || ended.body.data.next === today).toBe(true);
    expect(ended.body.data.paidCount).toBe(8);
  });
});
