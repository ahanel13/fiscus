// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { TransactionHistoryEntry } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../testing/imports.js';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Each transaction's history (TXN-11, #46): every kind of change appears with who made it, newest
 * first, and only what the caller may see. The permission cells are in permissions.test.ts.
 */
describe('transaction history', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let owner: pg.Client;
  let A: TestClient;
  let B: TestClient;
  let hh: string;
  const member = {} as Record<'A' | 'B', string>;
  const cats = new Map<string, string>();
  /** A's, which B sees with full access. */
  let shared = '';
  /** A's, hidden from B. */
  let hidden = '';
  let other = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const sql = async (text: string, params: unknown[] = []) =>
    (await owner.query(text, params)).rows;
  const cat = (name: string) => cats.get(name)!;

  const account = async (c: TestClient, name: string, visibility = 'full') => {
    const r = await c.post(url('/accounts'), { name, type: 'depository', visibility });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const txn = async (
    c: TestClient,
    accountId: string,
    displayName = 'Item',
    amountMinor = -1200,
    date = '2026-04-01',
  ) => {
    const r = await c.post(url('/transactions'), { accountId, date, amountMinor, displayName });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const patch = async (c: TestClient, id: string, body: Record<string, unknown>) => {
    const t = (await c.get(url(`/transactions/${id}`))).body.data;
    const r = await c.request('PATCH', url(`/transactions/${id}`), body, {
      headers: { 'if-match': `"v${t.version}"` },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const history = async (c: TestClient, id: string) => {
    const r = await c.get(url(`/transactions/${id}/history`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as TransactionHistoryEntry[];
  };
  const actions = async (c: TestClient, id: string) =>
    (await history(c, id)).map((e) => `${e.action} by ${e.actor.label}`);

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name}@history.test`,
        password: 'history test Password1!',
        displayName: name,
      });
      return c;
    };
    A = await signup('Ada');
    B = await signup('Bea');
    const h = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data;
    hh = h.id;
    member.A = h.you.memberId;
    const invite = await A.post(url('/invites'), { email: 'bea@history.test' });
    await B.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    member.B = (await B.get(url())).body.data.you.memberId;
    for (const g of (await A.get(url('/categories'))).body.data) {
      for (const c of g.categories) cats.set(c.name, c.id);
    }
    shared = await account(A, 'Joint-ish checking');
    hidden = await account(A, 'Ada’s own', 'private');
    other = await account(A, 'Ada’s savings');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await owner?.end();
    await tdb?.stop();
  });

  it('shows adding and editing it, newest first, with who did it and what changed', async () => {
    const id = await txn(A, shared, 'Beans');
    await patch(A, id, { categoryId: cat('Groceries') });
    await patch(B, id, { categoryId: cat('Coffee') });
    await patch(A, id, { reviewStatus: 'needs_review' });
    const entries = await history(B, id);
    expect(entries.map((e) => [e.action, e.actor.label])).toEqual([
      ['transaction.updated', 'Ada'],
      ['transaction.updated', 'Bea'],
      ['transaction.updated', 'Ada'],
      ['transaction.created', 'Ada'],
    ]);
    expect(entries[1]).toMatchObject({
      actor: { kind: 'member', memberId: member.B },
      changes: [{ field: 'categoryId', from: cat('Groceries'), to: cat('Coffee') }],
    });
    expect(entries[3]!.changes).toEqual(
      expect.arrayContaining([
        { field: 'displayName', to: 'Beans' },
        { field: 'amountMinor', to: -1200 },
      ]),
    );
    // Opaque ids: no positions in the household's history.
    for (const e of entries) expect(e.id).not.toMatch(/^\d+$/);
  });

  it('links a bulk edit as one entry to every transaction it changed', async () => {
    const ids = [await txn(A, shared, 'One'), await txn(A, shared, 'Two'), await txn(A, shared)];
    const before = await sql(
      'SELECT count(*)::int AS n FROM audit_events WHERE household_id = $1',
      [hh],
    );
    const r = await A.request('PATCH', url('/transactions'), {
      ids,
      changes: { categoryId: cat('Coffee'), addTagIds: [] },
    });
    expect(r.body.data.updated).toEqual(ids);
    const after = await sql('SELECT count(*)::int AS n FROM audit_events WHERE household_id = $1', [
      hh,
    ]);
    expect(after[0].n - before[0].n).toBe(1);
    const links = await sql(
      `SELECT l.transaction_id FROM activity_transactions l
       JOIN audit_events e ON e.scope_id = l.household_id AND e.seq = l.seq
       WHERE e.household_id = $1 AND e.action = 'transaction.bulk_updated'
         AND l.seq = (SELECT max(seq) FROM audit_events WHERE household_id = $1)`,
      [hh],
    );
    expect(links.map((l) => l.transaction_id).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const [newest] = await history(B, id);
      expect(newest).toMatchObject({
        action: 'transaction.bulk_updated',
        actor: { label: 'Ada' },
        detail: { bulk: true },
      });
      expect(newest!.changes).toContainEqual({ field: 'categoryId', to: cat('Coffee') });
    }
  });

  it('shows splitting on the whole and on each part, and deleting it', async () => {
    const id = await txn(A, shared, 'Costco', -5000);
    const parts = (
      await A.request('PUT', url(`/transactions/${id}/splits`), {
        parts: [{ amountMinor: -3000 }, { amountMinor: -2000 }],
      })
    ).body.data as { id: string }[];
    expect(parts).toHaveLength(2);
    expect((await history(A, id))[0]).toMatchObject({
      action: 'transaction.split',
      detail: { parts: 2 },
    });
    for (const p of parts) {
      expect((await history(A, p.id))[0]).toMatchObject({ action: 'transaction.split' });
    }
    await A.request('DELETE', url(`/transactions/${id}/splits`));
    expect((await history(A, id))[0]!.action).toBe('transaction.unsplit');

    expect((await A.request('DELETE', url(`/transactions/${id}`))).status).toBe(204);
    // Gone from view, so its history is too; the deletion is still linked to it.
    expect((await A.get(url(`/transactions/${id}/history`))).status).toBe(404);
    const linked = await sql(
      `SELECT e.action FROM activity_transactions l
       JOIN audit_events e ON e.scope_id = l.household_id AND e.seq = l.seq
       WHERE l.transaction_id = $1 ORDER BY l.seq DESC LIMIT 1`,
      [id],
    );
    expect(linked).toEqual([{ action: 'transaction.deleted' }]);
  });

  it('names the rule that changed it, when applied to existing transactions', async () => {
    const id = await txn(A, shared, 'BEANERY 42');
    const rule = (
      await A.post(url('/rules'), {
        name: 'Coffee',
        conditions: { description: { op: 'contains', value: 'beanery' } },
        actions: { categoryId: cat('Coffee') },
      })
    ).body.data.id as string;
    expect((await A.post(url(`/rules/${rule}/apply`))).body.data.changed).toBeGreaterThan(0);
    const [newest] = await history(B, id);
    expect(newest).toMatchObject({
      action: 'transaction.rules_applied',
      actor: { kind: 'rule', rules: [{ id: rule, name: 'Coffee' }], label: 'Rule: Coffee' },
      changes: [{ field: 'categoryId', from: null, to: cat('Coffee') }],
    });
  });

  it('starts an imported transaction with its import, then what rules did on arrival', async () => {
    await A.post(url('/rules'), {
      name: 'Tea',
      conditions: { description: { op: 'contains', value: 'teahouse' } },
      actions: { categoryId: cat('Coffee'), markReviewed: true },
    });
    const r = await runImport(A, url(), {
      format: 'monarch',
      filename: 'Transactions.csv',
      accounts: [{ key: 'file', accountId: shared }],
      transactions: [
        {
          line: 2,
          account: 'file',
          date: '2026-02-03',
          amountMinor: -650,
          description: 'TEAHOUSE',
        },
      ],
    });
    expect(r.res.status, JSON.stringify(r.res.body)).toBe(200);
    const list = (await A.get(url(`/transactions?accounts=${shared}&q=TEAHOUSE`))).body.data;
    const id = (list as { id: string; originalDescription: string }[]).find(
      (t) => t.originalDescription === 'TEAHOUSE',
    )!.id;
    const entries = await history(B, id);
    expect(entries.map((e) => [e.action, e.actor.kind, e.actor.label])).toEqual([
      ['transaction.rules_applied', 'rule', 'Rule: Tea'],
      ['import.rows_added', 'import', 'Import'],
    ]);
    expect(entries[1]!.detail).toEqual({ format: 'monarch' });
    expect(entries[0]!.changes).toEqual(
      expect.arrayContaining([
        { field: 'categoryId', from: null, to: cat('Coffee') },
        { field: 'reviewStatus', from: 'needs_review', to: 'reviewed' },
      ]),
    );

    // Undoing the import is the last thing that happened to it.
    const batch = r.run!.batches[0]!.batchId;
    expect((await A.post(url(`/imports/${batch}/revert`))).status).toBe(204);
    const [undone] = await sql(
      `SELECT e.action, e.actor_member_id FROM activity_transactions l
       JOIN audit_events e ON e.scope_id = l.household_id AND e.seq = l.seq
       WHERE l.transaction_id = $1 ORDER BY l.seq DESC LIMIT 1`,
      [id],
    );
    expect(undone).toEqual({ action: 'import.reverted', actor_member_id: member.A });
  });

  it('shows linking and unlinking a transfer, and moving and attributing it', async () => {
    const out = await txn(A, shared, 'To savings', -40_000, '2026-01-01');
    const into = await txn(A, other, 'From checking', 40_000, '2026-03-01'); // too far to detect
    expect(
      (await A.post(url(`/transactions/${out}/transfer`), { transactionId: into })).status,
    ).toBe(200);
    expect((await A.request('DELETE', url(`/transactions/${out}/transfer`))).status).toBe(204);
    expect(await actions(A, out)).toEqual([
      'transaction.transfer_unlinked by Ada',
      'transaction.transfer_linked by Ada',
      'transaction.created by Ada',
    ]);
    expect((await history(A, into))[0]!.detail).toEqual({ cause: 'unlinked' });

    const moved = await A.post(url('/transactions/move'), { ids: [into], accountId: shared });
    expect(moved.body.data.updated).toEqual([into]);
    expect((await history(A, into))[0]).toMatchObject({
      action: 'transaction.moved_in',
      detail: { accountId: shared },
    });

    await A.request('PUT', url(`/transactions/${into}/attribution`), {
      attribution: [{ memberId: member.B }],
    });
    const [attributed] = await history(B, into);
    expect(attributed).toMatchObject({ action: 'transaction.attribution_changed' });
    expect(attributed!.changes[0]!.to).toEqual([
      expect.objectContaining({ memberId: member.B, shareBps: 10000 }),
    ]);
  });

  it('shows a private note’s changes to its author only, and the shared note’s to everyone', async () => {
    const id = await txn(A, shared, 'Gift');
    await B.request('PUT', url(`/transactions/${id}/notes/mine`), { body: 'For Ada’s birthday' });
    await A.request('PUT', url(`/transactions/${id}/notes/shared`), { body: 'Split later' });
    expect(await actions(B, id)).toEqual([
      'transaction.shared_note_set by Ada',
      'transaction.mine_note_set by Bea',
      'transaction.created by Ada',
    ]);
    expect(await actions(A, id)).toEqual([
      'transaction.shared_note_set by Ada',
      'transaction.created by Ada',
    ]);
  });

  it('shows nothing of an account hidden from the caller', async () => {
    const id = await txn(A, hidden, 'Secret');
    await patch(A, id, { categoryId: cat('Coffee') });
    // Not visible at all: 404, as reading it is.
    expect((await B.get(url(`/transactions/${id}/history`))).status).toBe(404);
    expect((await B.get(url(`/transactions/${crypto.randomUUID()}/history`))).status).toBe(404);
    expect((await A.get(url(`/transactions/${crypto.randomUUID()}/history`))).status).toBe(404);

    // Attributed to them, so they see the transaction (F1), but not its account's events.
    await A.request('PUT', url(`/transactions/${id}/attribution`), {
      attribution: [{ memberId: member.B }],
    });
    expect((await B.get(url(`/transactions/${id}`))).status).toBe(200);
    expect(await history(B, id)).toEqual([]);
    expect(await actions(A, id)).toEqual([
      'transaction.attribution_changed by Ada',
      'transaction.updated by Ada',
      'transaction.created by Ada',
    ]);
  });
});
