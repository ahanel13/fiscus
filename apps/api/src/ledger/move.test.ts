// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../testing/imports.js';
import { createTestApp, TestClient } from '../testing/test-app.js';

/** Moving transactions between accounts (TXN-12, docs/design/transactions.md). */
describe('moving transactions', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let A: TestClient;
  let B: TestClient;
  let hh = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const account = async (c: TestClient, name: string, extra: Record<string, unknown> = {}) =>
    (await c.post(url('/accounts'), { name, type: 'depository', ...extra })).body.data.id as string;
  const txn = async (accountId: string, amountMinor: number, displayName = 'T') =>
    (
      await A.post(url('/transactions'), {
        accountId,
        date: '2026-03-01',
        amountMinor,
        displayName,
      })
    ).body.data.id as string;
  const balance = async (accountId: string) =>
    ((await A.get(url(`/accounts/${accountId}`))).body.data.balance?.amountMinor ?? 0) as number;
  const move = (c: TestClient, ids: string[], accountId: string) =>
    c.post(url('/transactions/move'), { ids, accountId });

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@move.test`,
        password: 'move test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('ada');
    B = await signup('bea');
    hh = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
    const invite = await A.post(url('/invites'), { email: 'bea@move.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('moves transactions, splits with their parts, and both balances follow', async () => {
    const sofi = await account(A, 'SoFi Checking');
    const savings = await account(A, 'SoFi Savings');
    const deposit = await txn(sofi, 50000, 'To savings');
    const groceries = await txn(sofi, -3000, 'Groceries');
    await A.request('PUT', url(`/transactions/${groceries}/splits`), {
      parts: [{ amountMinor: -2000 }, { amountMinor: -1000 }],
    });
    expect(await balance(sofi)).toBe(47000);

    const r = await move(A, [deposit, groceries], savings);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ updated: [deposit, groceries], refused: [] });
    expect(await balance(sofi)).toBe(0);
    expect(await balance(savings)).toBe(47000);
    const parts = (await A.get(url(`/transactions?accounts=${savings}`))).body.data as {
      displayName: string;
      account: { id: string };
    }[];
    expect(parts.filter((t) => t.displayName.startsWith('Groceries'))).toHaveLength(2);
  });

  it('refuses what can’t move, row by row', async () => {
    const mine = await account(A, 'Mine');
    const other = await account(A, 'Euro', { currency: 'EUR' });
    const beas = await account(B, 'Bea’s', { visibility: 'full' });
    const t = await txn(mine, -500);
    const split = await txn(mine, -900);
    const [part] = (
      await A.request('PUT', url(`/transactions/${split}/splits`), {
        parts: [{ amountMinor: -400 }, { amountMinor: -500 }],
      })
    ).body.data.filter((x: { parentId: string | null }) => x.parentId) as { id: string }[];
    // Another currency, a single part of a split: refused, the rest moves.
    const elsewhere = await account(A, 'Elsewhere');
    const r = await move(A, [t, part!.id], other);
    expect(r.body.data.refused).toEqual([
      { id: t, code: 'different_currency' },
      { id: part!.id, code: 'not_editable' },
    ]);
    expect((await move(A, [t], elsewhere)).body.data.updated).toEqual([t]);
    // Into an account you don't own: refused outright; out of one you don't own: per row.
    expect((await move(A, [t], beas)).status).toBe(403);
    const beasTxn = (
      await B.post(url('/transactions'), {
        accountId: beas,
        date: '2026-03-01',
        amountMinor: -1,
        displayName: 'x',
      })
    ).body.data.id;
    expect((await move(A, [beasTxn], mine)).body.data.refused).toEqual([
      { id: beasTxn, code: 'forbidden' },
    ]);
  });

  it('remembers where an import put a row, so re-importing doesn’t bring it back', async () => {
    const one = await account(A, 'One account');
    const real = await account(A, 'Its real account');
    const body = {
      format: 'csv' as const,
      filename: 'bank.csv',
      accounts: [{ key: 'file', accountId: one }],
      transactions: [
        { line: 2, account: 'file', date: '2026-02-01', amountMinor: -700, description: 'BOOKS' },
      ],
    };
    const first = await runImport(A, url(), body);
    const id = (await A.get(url(`/transactions?accounts=${one}`))).body.data[0].id;
    expect((await move(A, [id], real)).body.data.updated).toEqual([id]);

    const again = await runImport(A, url(), body);
    expect(again.preview.totals).toMatchObject({ new: 0, duplicates: 1 });

    // Undoing the import removes it from where it is now, and that balance follows.
    expect(await balance(real)).toBe(-700);
    expect((await A.post(url(`/import-runs/${first.run!.runId}/revert`))).status).toBe(204);
    expect(await balance(real)).toBe(0);
  });
});
