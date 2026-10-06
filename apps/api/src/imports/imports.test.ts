// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { parseCsv, readMonarch } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** File imports (docs/design/imports.md, #73, #75). */
describe('imports', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  let bea = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const account = async (name: string, type = 'depository') =>
    (await A.post(url('/accounts'), { name, type })).body.data.id as string;
  const list = async (accountId: string) =>
    (await A.get(url(`/transactions?accounts=${accountId}&limit=200`))).body.data as {
      id: string;
      date: string;
      amountMinor: number;
      displayName: string;
      originalDescription: string;
      categoryId: string | null;
      reviewStatus: string;
      tagIds: string[];
    }[];
  const row = (line: number, date: string, amountMinor: number, description: string) => ({
    line,
    account: 'file',
    date,
    amountMinor,
    description,
  });
  const csv = (
    accountId: string,
    transactions: unknown[],
    extra: Record<string, unknown> = {},
  ) => ({
    format: 'csv',
    filename: 'bank.csv',
    accounts: [{ key: 'file', accountId }],
    transactions,
    ...extra,
  });

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@imports.test`,
        password: 'imports test password',
        displayName: name,
      });
      return c;
    };
    A = await signup('Ada');
    B = await signup('Bea');
    hh = (
      await A.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'America/Denver',
      })
    ).body.data.id;
    const invite = await A.post(url('/invites'), { email: 'bea@imports.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    bea = (await B.get(url())).body.data.you.memberId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('previews exactly what an import does, saving nothing', async () => {
    const acc = await account('Preview checking');
    const body = csv(acc, [
      row(2, '2026-03-01', -450, 'COFFEE'),
      row(3, '2026-03-01', -450, 'COFFEE'), // a second coffee the same day is real
      row(4, '2026-03-02', 0, 'CARD CHECK'),
      row(5, '2099-01-01', -100, 'FUTURE'),
    ]);
    const preview = await A.post(url('/imports/preview'), body);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.totals).toEqual({
      new: 2,
      duplicates: 0,
      overlaps: 0,
      skipped: 1,
      errors: 1,
    });
    expect(preview.body.data.rows).toEqual([
      { line: 4, status: 'skipped', message: 'Amount is $0' },
      { line: 5, status: 'error', message: 'Dated in the future' },
    ]);
    expect(await list(acc)).toEqual([]);
    expect((await A.get(url('/imports'))).body.data).toEqual([]);

    const done = await A.post(url('/imports'), body);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const { batches, ...result } = done.body.data;
    expect(result).toEqual(preview.body.data);
    expect(batches).toMatchObject([{ accountId: acc, transactionCount: 2, canRevert: true }]);
    const rows = await list(acc);
    expect(rows.map((t) => [t.date, t.amountMinor, t.displayName, t.reviewStatus])).toEqual([
      ['2026-03-01', -450, 'COFFEE', 'needs_review'],
      ['2026-03-01', -450, 'COFFEE', 'needs_review'],
    ]);
    // The account follows its transactions.
    const balances = (await A.get(url(`/accounts/${acc}/balances`))).body.data;
    expect(balances.at(-1)).toMatchObject({ asOf: '2026-03-01', amountMinor: -900 });
  });

  it('skips rows imported before, and flags possible duplicates of what’s already there', async () => {
    const acc = await account('Dedupe checking');
    const manual = (
      await A.post(url('/transactions'), {
        accountId: acc,
        date: '2026-04-02',
        amountMinor: -2000,
        displayName: 'Lunch',
      })
    ).body.data.id;
    const first = [
      row(2, '2026-04-01', -1000, 'GROCER'),
      row(3, '2026-04-03', -2000, 'LUNCH SPOT'),
    ];
    const r1 = await A.post(url('/imports'), csv(acc, first));
    expect(r1.body.data.totals).toMatchObject({ new: 1, overlaps: 1 });
    expect(r1.body.data.rows).toEqual([
      { line: 3, status: 'overlap', matchId: manual, message: 'May already be in this account' },
    ]);

    // The same file again, with the overlap ticked this time, and one new row with a changed
    // description spacing and case for the first: still a duplicate.
    const again = [
      row(2, '2026-04-01', -1000, '  grocer '),
      row(3, '2026-04-03', -2000, 'LUNCH SPOT'),
      row(4, '2026-04-05', -300, 'BUS'),
    ];
    const r2 = await A.post(url('/imports'), csv(acc, again, { includeOverlaps: [3] }));
    expect(r2.body.data.totals).toMatchObject({ new: 2, duplicates: 1, overlaps: 0 });
    expect((await list(acc)).map((t) => t.amountMinor).sort((a, b) => a - b)).toEqual([
      -2000, -2000, -1000, -300,
    ]);
  });

  it('undoes an import, and the same file can be imported again', async () => {
    const acc = await account('Undo checking');
    const body = csv(acc, [row(2, '2026-05-01', -700, 'BOOKS')]);
    const batch = (await A.post(url('/imports'), body)).body.data.batches[0].id;
    expect((await A.post(url(`/imports/${batch}/revert`))).status).toBe(204);
    expect(await list(acc)).toEqual([]);
    expect((await A.post(url(`/imports/${batch}/revert`))).status).toBe(409);
    const listed = (await A.get(url('/imports'))).body.data.find(
      (b: { id: string }) => b.id === batch,
    );
    expect(listed).toMatchObject({ canRevert: false, revertedAt: expect.any(String) });
    const again = await A.post(url('/imports'), body);
    expect(again.body.data.totals.new).toBe(1);
  });

  it('rejects files that don’t say where each account goes, and accounts you don’t own', async () => {
    const acc = await account('Mine');
    const unmapped = await A.post(url('/imports/preview'), {
      ...csv(acc, [{ ...row(2, '2026-01-01', -1, 'X'), account: 'other' }]),
    });
    expect(unmapped.status).toBe(422);
    expect(unmapped.body.code).toBe('unmapped_account');
    expect(
      (await B.post(url('/imports/preview'), csv(acc, [row(2, '2026-01-01', -1, 'X')]))).status,
    ).toBe(403);
  });

  it('accepts a large file', async () => {
    const acc = await account('Big checking');
    const rows = Array.from({ length: 12_000 }, (_, i) =>
      row(
        i + 2,
        `2025-${String((i % 12) + 1).padStart(2, '0')}-10`,
        -(i + 1),
        `PURCHASE NUMBER ${i}`,
      ),
    );
    const r = await A.post(url('/imports'), csv(acc, rows));
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201);
    expect(r.body.data.totals.new).toBe(12_000);
  }, 120_000);

  describe('Monarch', () => {
    const worthOn = async (day: string) =>
      (
        await A.get(url(`/net-worth?range=custom&from=${day}&to=${day}&granularity=day`))
      ).body.data.series.at(-1).netWorthMinor as number;
    // Made-up rows in the format of a real export (October 2026).
    const exportFiles = () =>
      readMonarch(
        {
          transactions: parseCsv(
            [
              'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id',
              '2026-09-03,Harmons,Coffee Beans,Blue Cash Preferred® ,HARMONS #12,,-97.55,,Shared,,9001',
              '2026-09-03,Harmons,Coffee Beans,Blue Cash Preferred® ,HARMONS #12,,-97.55,,Shared,,9002',
              '2026-09-04,Payroll,Pretax Paycheck,SoFi Checking,ACME PAYROLL,"Bonus month\nnice",2500.00,"Work, Taxes",Bea,Needs Review,9003',
              '2026-09-05,Amex,Credit Card Payment,SoFi Checking,AMEX EPAYMENT,,-195.10,,Shared,Reviewed,9004',
              '2026-09-05,Amex,Credit Card Payment,Blue Cash Preferred® ,PAYMENT THANK YOU,,195.10,,Shared,,9005',
              '2026-09-06,Mystery,Uncategorized,SoFi Checking,POS 1234,,-5.00,,Shared,,9006',
            ].join('\n'),
          ),
          balances: parseCsv(
            [
              'Date,Balance,Account',
              '2026-09-03,1000.00,SoFi Checking',
              '2026-09-04,3500.00,SoFi Checking',
              '2026-09-05,3304.90,SoFi Checking',
              '2026-09-06,3299.90,SoFi Checking',
              '2026-09-07,3299.90,SoFi Checking',
              '2026-09-08,3299.90,SoFi Checking',
              '2024-01-30,15.00,Old Savings',
              '2024-01-31,0.00,Old Savings',
              '2026-09-08,39010.00,Truck',
            ].join('\n'),
          ),
        },
        2,
      );

    it('imports accounts, categories, tags, notes, people, and balance history in one go', async () => {
      const m = exportFiles();
      const accounts = m.accounts.map((a) => ({
        key: a.key,
        create: { name: a.key, type: a.suggestedType, balanceMode: a.suggestedMode },
        ...(a.closeOn ? { closeOn: a.closeOn } : {}),
      }));
      const body = {
        format: 'monarch',
        filename: 'Transactions.csv',
        accounts,
        members: [{ name: 'Bea', memberId: bea }],
        transactions: m.transactions,
        balances: m.balances,
      };
      const worthBefore = await worthOn('2026-09-08');
      const r = await A.post(url('/imports'), body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const data = r.body.data;
      expect(data.totals).toEqual({ new: 6, duplicates: 0, overlaps: 0, skipped: 0, errors: 0 });
      expect(data.newCategories).toEqual([
        // Everyday spending goes in its own group; income and transfers join the existing ones.
        { name: 'Coffee Beans', kind: 'flexible', group: 'From Monarch' },
        { name: 'Pretax Paycheck', kind: 'income', group: 'Income' },
        { name: 'Credit Card Payment', kind: 'transfer', group: 'Transfers' },
      ]);
      expect(data.newTags).toEqual(['Work', 'Taxes']);
      expect(data.batches).toHaveLength(4); // each account its own batch

      const all = (await A.get(url('/accounts?include=closed'))).body.data as {
        id: string;
        name: string;
        type: string;
        closedAt: string | null;
      }[];
      const byName = (n: string) => all.find((a) => a.name === n)!;
      expect(byName('Blue Cash Preferred®').type).toBe('credit');
      expect(byName('Truck').type).toBe('vehicle');
      expect(byName('Old Savings').closedAt).not.toBeNull();

      const sofi = byName('SoFi Checking').id;
      const rows = await list(sofi);
      const payroll = rows.find((t) => t.displayName === 'Payroll')!;
      expect(payroll).toMatchObject({
        originalDescription: 'ACME PAYROLL',
        reviewStatus: 'needs_review',
        amountMinor: 250000,
      });
      expect(payroll.tagIds).toHaveLength(2);
      const detail = (await A.get(url(`/transactions/${payroll.id}`))).body.data;
      expect(detail.sharedNote).toBe('Bonus month\nnice');
      expect(detail.attribution).toEqual([{ memberId: bea, shareBps: 10000 }]);
      const groups = (await A.get(url('/categories'))).body.data as {
        categories: { id: string; systemKey: string | null }[];
      }[];
      const uncategorized = groups
        .flatMap((g) => g.categories)
        .find((c) => c.systemKey === 'uncategorized')!;
      expect(rows.find((t) => t.displayName === 'Mystery')!.categoryId).toBe(uncategorized.id);
      expect(rows.find((t) => t.displayName === 'Amex')!.reviewStatus).toBe('reviewed');

      // Identical rows stay apart through Monarch's ids.
      expect(
        (await list(byName('Blue Cash Preferred®').id)).filter((t) => t.displayName === 'Harmons'),
      ).toHaveLength(2);

      // Balances: only the first day, changes, and days with transactions are stored, and every
      // day reads as in the file.
      const balances = (await A.get(url(`/accounts/${sofi}/balances`))).body.data as {
        asOf: string;
        amountMinor: number;
        source: string;
      }[];
      expect(balances.map((b) => [b.asOf, b.amountMinor])).toEqual([
        ['2026-09-03', 100000],
        ['2026-09-04', 350000],
        ['2026-09-05', 330490],
        ['2026-09-06', 329990],
      ]);
      // Net worth on the last day grows by SoFi's 3 299.90 and the truck's 39 010; the card nets
      // to zero (−97.55 × 2 + 195.10), and Old Savings was closed in 2024.
      expect((await worthOn('2026-09-08')) - worthBefore).toBe(329990 + 3901000);
    });

    it('imports only what’s new from a later export, and can be undone completely', async () => {
      const m = exportFiles();
      const existing = (await A.get(url('/accounts?include=closed'))).body.data as {
        id: string;
        name: string;
      }[];
      const accounts = m.accounts.map((a) => ({
        key: a.key,
        accountId: existing.find((e) => e.name === a.key)!.id,
      }));
      const body = {
        format: 'monarch',
        filename: 'Transactions-2.csv',
        accounts,
        transactions: [
          ...m.transactions,
          {
            line: 99,
            account: 'SoFi Checking',
            date: '2026-09-09',
            amountMinor: -1200,
            description: 'NEW THING',
            externalId: '9007',
          },
        ],
      };
      const r = await A.post(url('/imports'), body);
      expect(r.body.data.totals).toMatchObject({ new: 1, duplicates: 6 });

      // Undoing the first import removes the accounts it created, unless something else is in them.
      const batches = (await A.get(url('/imports'))).body.data as {
        id: string;
        accountName: string;
        filename: string;
      }[];
      for (const b of batches.filter((x) => x.filename === 'Transactions.csv')) {
        expect((await A.post(url(`/imports/${b.id}/revert`))).status).toBe(204);
      }
      const after = (await A.get(url('/accounts?include=closed'))).body.data.map(
        (a: { name: string }) => a.name,
      );
      expect(after).toContain('SoFi Checking'); // the later import is still in it
      expect(after).not.toContain('Truck');
      expect(after).not.toContain('Old Savings');
    });
  });
});
