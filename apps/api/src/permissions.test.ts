// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from './testing/test-app.js';

/**
 * The permissions matrix (docs/design/permissions.md) as tests: one per (rule, actor) cell,
 * keyed '<ROW>/<ACTOR>'. permissions-coverage.test.ts fails if a built rule has an untested cell.
 *
 * OWN = household owner (A), MEM = member (B), VIEW = viewer (V). "acct-own" cells are checked
 * on both sides: allowed on an account the actor owns, refused on one they only see.
 */

type Res = Awaited<ReturnType<TestClient['request']>>;
type Actor = 'OWN' | 'MEM' | 'VIEW';

const ok = (r: Res) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
const refused = (r: Res, status = 403, code?: string) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body.code).toBe(code);
};

interface Fixture {
  hh: string;
  A: TestClient;
  B: TestClient;
  V: TestClient;
  member: Record<'A' | 'B' | 'V', string>;
  accA: string; // A's, full
  accAview: string; // A's, view-only
  accAprivate: string; // A's, private
  accB: string; // B's, full
  tA: string;
  tAview: string;
  tPriv: string;
  tB: string;
  uncategorized: string;
  firstGroup: string;
  signup: (name: string) => Promise<TestClient>;
  join: (role: 'member' | 'viewer') => Promise<TestClient>;
}

let f: Fixture;
const url = (path = '') => `/api/v1/households/${f.hh}${path}`;
const version = async (c: TestClient, path: string) =>
  (await c.get(url(path))).body.data.version as number;
const patch = async (c: TestClient, path: string, body: unknown, versionFrom: TestClient = f.A) =>
  c.request('PATCH', url(path), body, {
    headers: { 'if-match': `"v${await version(versionFrom, path)}"` },
  });
const txn = async (c: TestClient, accountId: string, amountMinor = -1500) =>
  (
    await c.post(url('/transactions'), {
      accountId,
      amountMinor,
      date: '2026-03-01',
      displayName: 'Item',
    })
  ).body.data.id as string;
const account = async (c: TestClient, visibility = 'full') =>
  (await c.post(url('/accounts'), { name: 'Extra', type: 'depository', visibility })).body.data
    .id as string;
let imported = 0;
/** A one-row CSV import into an account; each call imports a new row. */
const importInto = (c: TestClient, accountId: string) =>
  c.post(url('/imports'), {
    format: 'csv',
    filename: 'perm.csv',
    accounts: [{ key: 'file', accountId }],
    transactions: [
      {
        line: 2,
        account: 'file',
        date: '2026-02-01',
        amountMinor: -++imported,
        description: `Imported ${imported}`,
      },
    ],
  });
const attribute = (c: TestClient, id: string, members: string[]) =>
  c.request('PUT', url(`/transactions/${id}/attribution`), {
    attribution: members.map((memberId) => ({ memberId })),
  });

/** Every built cell. Rows not built yet are listed in permissions-coverage.test.ts. */
const CELLS: Record<string, (a: Actor) => Promise<void>> = {
  // ── 4.1 Household and membership ──
  'HH-01/OWN': async () => ok(await f.A.get(url())),
  'HH-01/MEM': async () => ok(await f.B.get(url())),
  'HH-01/VIEW': async () => ok(await f.V.get(url())),
  'HH-02/OWN': async () => ok(await patch(f.A, '', { name: 'Home' })),
  'HH-02/MEM': async () => refused(await patch(f.B, '', { name: 'Hijacked' })),
  'HH-02/VIEW': async () => refused(await patch(f.V, '', { name: 'Hijacked' })),
  'HH-03/OWN': async () => {
    const r = await f.A.get(url('/members'));
    ok(r);
    expect(r.body.data.every((m: { email?: string }) => m.email)).toBe(true);
  },
  'HH-03/MEM': async () => {
    const r = await f.B.get(url('/members'));
    ok(r);
    expect(r.body.data.some((m: { email?: string }) => m.email)).toBe(false);
  },
  'HH-03/VIEW': async () => {
    const r = await f.V.get(url('/members'));
    ok(r);
    expect(r.body.data.some((m: { email?: string }) => m.email)).toBe(false);
  },
  'HH-04/OWN': async () => ok(await f.A.post(url('/invites'), { email: 'own@perm.test' })),
  'HH-04/MEM': async () => refused(await f.B.post(url('/invites'), { email: 'mem@perm.test' })),
  'HH-04/VIEW': async () => refused(await f.V.post(url('/invites'), { email: 'view@perm.test' })),
  // Anyone can leave, except the last owner (EDGE-06).
  'HH-05/OWN': async () => refused(await f.A.post(url('/leave')), 409, 'last_owner'),
  'HH-05/MEM': async () => ok(await (await f.join('member')).post(url('/leave'))),
  'HH-05/VIEW': async () => ok(await (await f.join('viewer')).post(url('/leave'))),
  // Nobody can make an account owner a viewer; their accounts must be handed over first.
  'HH-06/OWN': async () =>
    refused(
      await f.A.request('PATCH', url(`/members/${f.member.B}`), { role: 'viewer' }),
      409,
      'owns_accounts',
    ),
  'HH-06/MEM': async () =>
    refused(await f.B.request('PATCH', url(`/members/${f.member.B}`), { role: 'viewer' })),
  'HH-06/VIEW': async () =>
    refused(await f.V.request('PATCH', url(`/members/${f.member.B}`), { role: 'viewer' })),
  // Your own preferences: anyone sets theirs, and nobody sees anyone else's.
  'HH-10/OWN': async () => {
    ok(await f.A.request('PUT', url('/preferences/range:reports'), { value: 'last_6m' }));
    expect((await f.A.get(url('/preferences'))).body.data['range:reports']).toBe('last_6m');
  },
  'HH-10/MEM': async () => {
    await f.A.request('PUT', url('/preferences/range:reports'), { value: 'last_6m' });
    ok(await f.B.request('PUT', url('/preferences/range:transactions'), { value: 'ytd' }));
    expect((await f.B.get(url('/preferences'))).body.data).toEqual({ 'range:transactions': 'ytd' });
  },
  'HH-10/VIEW': async () => {
    ok(await f.V.request('PUT', url('/preferences/density'), { value: 'compact' }));
    expect((await f.V.get(url('/preferences'))).body.data).toEqual({ density: 'compact' });
  },
  'HH-12/OWN': async () => {
    const r = await f.A.get(url('/activity?limit=200'));
    ok(r);
    expect(JSON.stringify(r.body)).toContain(f.accAprivate);
  },
  'HH-12/MEM': async () => {
    const r = await f.B.get(url('/activity?limit=200'));
    ok(r);
    expect(JSON.stringify(r.body)).not.toContain(f.accAprivate);
  },
  'HH-12/VIEW': async () => {
    const r = await f.V.get(url('/activity?limit=200'));
    ok(r);
    expect(JSON.stringify(r.body)).not.toContain(f.accAprivate);
  },

  // ── 4.2 Accounts ──
  'ACC-04/OWN': async () => expect(await account(f.A)).toBeTruthy(),
  'ACC-04/MEM': async () => expect(await account(f.B)).toBeTruthy(),
  'ACC-04/VIEW': async () =>
    refused(await f.V.post(url('/accounts'), { name: 'Mine', type: 'other' })),
  'ACC-05/OWN': async () => ok(await f.A.get(url(`/accounts/${f.accAprivate}`))),
  'ACC-05/MEM': async () => {
    ok(await f.B.get(url(`/accounts/${f.accA}`)));
    refused(await f.B.get(url(`/accounts/${f.accAprivate}`)), 404);
  },
  'ACC-05/VIEW': async () => {
    ok(await f.V.get(url(`/accounts/${f.accA}`)));
    refused(await f.V.get(url(`/accounts/${f.accAprivate}`)), 404);
  },
  'ACC-06/OWN': async () => ok(await patch(f.A, `/accounts/${f.accA}`, { notes: 'Bills autopay' })),
  'ACC-06/MEM': async () => {
    ok(await patch(f.B, `/accounts/${f.accB}`, { notes: 'Mine' }, f.B));
    refused(await patch(f.B, `/accounts/${f.accA}`, { notes: 'Not mine' }));
  },
  'ACC-06/VIEW': async () => refused(await patch(f.V, `/accounts/${f.accA}`, { name: 'Renamed' })),
  'ACC-07/OWN': async () => ok(await patch(f.A, `/accounts/${f.accA}`, { visibility: 'full' })),
  'ACC-07/MEM': async () => {
    ok(await patch(f.B, `/accounts/${f.accB}`, { visibility: 'full' }, f.B));
    refused(await patch(f.B, `/accounts/${f.accA}`, { visibility: 'private' }));
  },
  'ACC-07/VIEW': async () =>
    refused(await patch(f.V, `/accounts/${f.accA}`, { visibility: 'private' })),
  'ACC-08/OWN': async () =>
    ok(
      await f.A.request('PUT', url(`/accounts/${f.accA}/owners`), {
        owners: [{ memberId: f.member.A }],
      }),
    ),
  'ACC-08/MEM': async () => {
    ok(
      await f.B.request('PUT', url(`/accounts/${f.accB}/owners`), {
        owners: [{ memberId: f.member.B }],
      }),
    );
    refused(
      await f.B.request('PUT', url(`/accounts/${f.accA}/owners`), {
        owners: [{ memberId: f.member.B }],
      }),
    );
  },
  'ACC-08/VIEW': async () =>
    refused(
      await f.V.request('PUT', url(`/accounts/${f.accA}/owners`), {
        owners: [{ memberId: f.member.A }],
      }),
    ),
  'ACC-09/OWN': async () => ok(await f.A.post(url(`/accounts/${await account(f.A)}/close`))),
  'ACC-09/MEM': async () => {
    ok(await f.B.post(url(`/accounts/${await account(f.B)}/close`)));
    refused(await f.B.post(url(`/accounts/${f.accA}/close`)));
  },
  'ACC-09/VIEW': async () => refused(await f.V.post(url(`/accounts/${f.accA}/close`))),
  'ACC-11/OWN': async () => ok(await patch(f.A, `/accounts/${f.accA}`, { isBusiness: false })),
  'ACC-11/MEM': async () => {
    ok(await patch(f.B, `/accounts/${f.accB}`, { isBusiness: false }, f.B));
    refused(await patch(f.B, `/accounts/${f.accA}`, { isBusiness: true }));
  },
  'ACC-11/VIEW': async () => refused(await patch(f.V, `/accounts/${f.accA}`, { isBusiness: true })),

  // ── 4.3 Transactions ──
  'TXN-01/OWN': async () => ok(await f.A.get(url(`/transactions/${f.tPriv}`))),
  'TXN-01/MEM': async () => {
    ok(await f.B.get(url(`/transactions/${f.tA}`)));
    refused(await f.B.get(url(`/transactions/${f.tPriv}`)), 404);
  },
  'TXN-01/VIEW': async () => {
    ok(await f.V.get(url(`/transactions/${f.tA}`)));
    refused(await f.V.get(url(`/transactions/${f.tPriv}`)), 404);
  },
  'TXN-02/OWN': async () => ok(await f.A.delete(url(`/transactions/${await txn(f.A, f.accA)}`))),
  'TXN-02/MEM': async () => {
    ok(await f.B.delete(url(`/transactions/${await txn(f.B, f.accB)}`)));
    refused(
      await f.B.post(url('/transactions'), {
        accountId: f.accA,
        amountMinor: -1,
        date: '2026-03-01',
        displayName: 'x',
      }),
    );
    refused(await f.B.delete(url(`/transactions/${f.tA}`)));
  },
  'TXN-02/VIEW': async () =>
    refused(
      await f.V.post(url('/transactions'), {
        accountId: f.accA,
        amountMinor: -1,
        date: '2026-03-01',
        displayName: 'x',
      }),
    ),
  'TXN-03/OWN': async () => ok(await patch(f.A, `/transactions/${f.tA}`, { amountMinor: -2500 })),
  'TXN-03/MEM': async () => {
    ok(await patch(f.B, `/transactions/${f.tB}`, { amountMinor: -2500 }, f.B));
    refused(await patch(f.B, `/transactions/${f.tA}`, { amountMinor: -1 }));
  },
  'TXN-03/VIEW': async () =>
    refused(await patch(f.V, `/transactions/${f.tA}`, { date: '2026-03-02' })),
  'TXN-04/OWN': async () =>
    ok(await patch(f.A, `/transactions/${f.tA}`, { reviewStatus: 'reviewed' })),
  'TXN-04/MEM': async () => {
    ok(await patch(f.B, `/transactions/${f.tA}`, { categoryId: f.uncategorized })); // full access
    refused(await patch(f.B, `/transactions/${f.tAview}`, { categoryId: f.uncategorized })); // view-only
  },
  'TXN-04/VIEW': async () =>
    refused(await patch(f.V, `/transactions/${f.tA}`, { reviewStatus: 'reviewed' })),
  'TXN-05/OWN': async () => ok(await patch(f.A, `/transactions/${f.tA}`, { excluded: false })),
  'TXN-05/MEM': async () => {
    ok(await patch(f.B, `/transactions/${f.tB}`, { excluded: false }, f.B));
    refused(await patch(f.B, `/transactions/${f.tA}`, { excluded: true }));
  },
  'TXN-05/VIEW': async () => refused(await patch(f.V, `/transactions/${f.tA}`, { excluded: true })),
  'TXN-06/OWN': async () =>
    ok(
      await f.A.request('PUT', url(`/transactions/${await txn(f.A, f.accA)}/splits`), {
        parts: [{ amountMinor: -1000 }, { amountMinor: -500 }],
      }),
    ),
  'TXN-06/MEM': async () => {
    ok(
      await f.B.request('PUT', url(`/transactions/${await txn(f.B, f.accB)}/splits`), {
        parts: [{ amountMinor: -1000 }, { amountMinor: -500 }],
      }),
    );
    refused(
      await f.B.request('PUT', url(`/transactions/${f.tA}/splits`), {
        parts: [{ amountMinor: -1 }, { amountMinor: -1 }],
      }),
    );
  },
  'TXN-06/VIEW': async () =>
    refused(
      await f.V.request('PUT', url(`/transactions/${f.tA}/splits`), {
        parts: [{ amountMinor: -1 }, { amountMinor: -1 }],
      }),
    ),
  // Importing needs ownership of the account (acct-own); undoing, the importer or an owner.
  'TXN-09/OWN': async () => ok(await importInto(f.A, f.accA)),
  'TXN-09/MEM': async () => {
    ok(await importInto(f.B, f.accB));
    refused(await importInto(f.B, f.accA));
    refused(await importInto(f.B, f.accAprivate), 404);
  },
  'TXN-09/VIEW': async () => refused(await importInto(f.V, f.accA)),
  'TXN-10/OWN': async () => {
    const batch = (await importInto(f.A, f.accA)).body.data.batches[0].id;
    ok(await f.A.post(url(`/imports/${batch}/revert`)));
  },
  'TXN-10/MEM': async () => {
    const own = (await importInto(f.B, f.accB)).body.data.batches[0].id;
    ok(await f.B.post(url(`/imports/${own}/revert`)));
    // Not the importer, and only full access to the account.
    const others = (await importInto(f.A, f.accA)).body.data.batches[0].id;
    refused(await f.B.post(url(`/imports/${others}/revert`)));
    // Not the importer, but an owner of the account.
    const joint = (
      await f.A.post(url('/accounts'), {
        name: 'Joint',
        type: 'depository',
        owners: [{ memberId: f.member.A }, { memberId: f.member.B }],
      })
    ).body.data.id;
    const theirs = (await importInto(f.A, joint)).body.data.batches[0].id;
    ok(await f.B.post(url(`/imports/${theirs}/revert`)));
  },
  'TXN-10/VIEW': async () => {
    const batch = (await importInto(f.A, f.accA)).body.data.batches[0].id;
    refused(await f.V.post(url(`/imports/${batch}/revert`)));
  },

  // ── 4.4 Attribution ──
  'ATT-01/OWN': async () => ok(await attribute(f.A, f.tA, [f.member.A, f.member.B])),
  'ATT-01/MEM': async () => {
    ok(await attribute(f.B, f.tB, [f.member.B]));
    refused(await attribute(f.B, f.tA, [f.member.B])); // full access isn't enough
  },
  'ATT-01/VIEW': async () => refused(await attribute(f.V, f.tA, [f.member.V])),
  // Attributing shares the purchase with them, never the account (F1).
  'ATT-02/OWN': async () => {
    const id = await txn(f.A, f.accAprivate);
    ok(await attribute(f.A, id, [f.member.B]));
    const seen = await f.B.get(url(`/transactions/${id}`));
    ok(seen);
    expect(seen.body.data).toMatchObject({ account: null, paidBy: [f.member.A] });
    expect(JSON.stringify(seen.body)).not.toContain(f.accAprivate);
  },
  'ATT-02/MEM': async () => {
    const hidden = await account(f.B, 'private');
    const id = await txn(f.B, hidden);
    ok(await attribute(f.B, id, [f.member.A]));
    const seen = await f.A.get(url(`/transactions/${id}`));
    expect(seen.body.data).toMatchObject({ account: null, paidBy: [f.member.B] });
    expect(JSON.stringify(seen.body)).not.toContain(hidden);
  },
  'ATT-02/VIEW': async () => refused(await attribute(f.V, f.tA, [f.member.B])),
  // Nobody removes their own share of something they don't own: they flag it instead (M3).
  'ATT-05/OWN': async () => {
    const id = await txn(f.B, f.accB);
    ok(await attribute(f.B, id, [f.member.A]));
    refused(await f.A.request('PUT', url(`/transactions/${id}/attribution`), { attribution: [] }));
  },
  'ATT-05/MEM': async () => {
    const id = await txn(f.A, f.accAprivate);
    ok(await attribute(f.A, id, [f.member.B]));
    refused(await f.B.request('PUT', url(`/transactions/${id}/attribution`), { attribution: [] }));
  },
  'ATT-05/VIEW': async () => {
    const id = await txn(f.A, f.accA);
    ok(await attribute(f.A, id, [f.member.V]));
    refused(await f.V.request('PUT', url(`/transactions/${id}/attribution`), { attribution: [] }));
  },

  // ── 4.5 Notes ──
  'NOTE-01/OWN': async () =>
    expect((await f.A.get(url(`/transactions/${f.tA}`))).body.data.sharedNote).toBe('Shared note'),
  'NOTE-01/MEM': async () =>
    expect((await f.B.get(url(`/transactions/${f.tA}`))).body.data.sharedNote).toBe('Shared note'),
  'NOTE-01/VIEW': async () => {
    expect((await f.V.get(url(`/transactions/${f.tA}`))).body.data.sharedNote).toBe('Shared note');
    refused(await f.V.get(url(`/transactions/${f.tPriv}`)), 404);
  },
  'NOTE-02/OWN': async () =>
    ok(
      await f.A.request('PUT', url(`/transactions/${f.tA}/notes/shared`), { body: 'Shared note' }),
    ),
  'NOTE-02/MEM': async () => {
    ok(
      await f.B.request('PUT', url(`/transactions/${f.tA}/notes/shared`), { body: 'Shared note' }),
    ); // full
    const forB = await txn(f.A, f.accAprivate);
    ok(await attribute(f.A, forB, [f.member.B]));
    ok(await f.B.request('PUT', url(`/transactions/${forB}/notes/shared`), { body: 'For me' })); // attributed
    refused(await f.B.request('PUT', url(`/transactions/${f.tAview}/notes/shared`), { body: 'x' })); // view-only
  },
  'NOTE-02/VIEW': async () =>
    refused(await f.V.request('PUT', url(`/transactions/${f.tA}/notes/shared`), { body: 'x' })),
  'NOTE-03/OWN': async () => {
    ok(await f.A.request('PUT', url(`/transactions/${f.tA}/notes/mine`), { body: 'A private' }));
    expect((await f.A.get(url(`/transactions/${f.tA}`))).body.data.myNote).toBe('A private');
  },
  'NOTE-03/MEM': async () => {
    ok(await f.B.request('PUT', url(`/transactions/${f.tA}/notes/mine`), { body: 'B private' }));
    expect((await f.B.get(url(`/transactions/${f.tA}`))).body.data.myNote).toBe('B private');
  },
  'NOTE-03/VIEW': async () => {
    ok(await f.V.request('PUT', url(`/transactions/${f.tA}/notes/mine`), { body: 'V private' }));
    expect((await f.V.get(url(`/transactions/${f.tA}`))).body.data.myNote).toBe('V private');
  },
  'NOTE-04/OWN': async () => {
    await f.B.request('PUT', url(`/transactions/${f.tA}/notes/mine`), { body: 'B private' });
    const body = JSON.stringify((await f.A.get(url('/transactions?limit=200'))).body);
    expect(body).not.toContain('B private');
    expect(body).not.toContain('V private');
  },
  'NOTE-04/MEM': async () => {
    await f.A.request('PUT', url(`/transactions/${f.tA}/notes/mine`), { body: 'A private' });
    expect(JSON.stringify((await f.B.get(url('/transactions?limit=200'))).body)).not.toContain(
      'A private',
    );
  },
  'NOTE-04/VIEW': async () => {
    await f.A.request('PUT', url(`/transactions/${f.tA}/notes/mine`), { body: 'A private' });
    expect(JSON.stringify((await f.V.get(url('/transactions?limit=200'))).body)).not.toContain(
      'A private',
    );
  },

  // ── 4.6 Categories, tags ──
  'CAT-01/OWN': async () => ok(await f.A.get(url('/categories'))),
  'CAT-01/MEM': async () => ok(await f.B.get(url('/tags'))),
  'CAT-01/VIEW': async () => ok(await f.V.get(url('/categories'))),
  'CAT-02/OWN': async () =>
    ok(await f.A.post(url('/categories'), { name: 'By owner', groupId: f.firstGroup })),
  'CAT-02/MEM': async () =>
    ok(await f.B.post(url('/tags'), { name: 'By member', color: '#2f6fdb' })),
  'CAT-02/VIEW': async () => {
    refused(await f.V.post(url('/categories'), { name: 'By viewer', groupId: f.firstGroup }));
    refused(await f.V.post(url('/tags'), { name: 'By viewer', color: '#2f6fdb' }));
  },
  'CAT-03/OWN': async () => {
    const cat = (await f.A.post(url('/categories'), { name: 'Doomed A', groupId: f.firstGroup }))
      .body.data.id;
    const id = await txn(f.A, f.accA);
    ok(await patch(f.A, `/transactions/${id}`, { categoryId: cat }));
    refused(await f.A.delete(url(`/categories/${cat}`)), 409, 'category_in_use');
    const r = await f.A.request('DELETE', url(`/categories/${cat}?replaceWith=${f.uncategorized}`));
    ok(r);
    expect(r.body.data.moved).toBe(1);
  },
  'CAT-03/MEM': async () => {
    const cat = (await f.B.post(url('/categories'), { name: 'Doomed B', groupId: f.firstGroup }))
      .body.data.id;
    // A's private transaction in this category: B can't see it, but it moves too.
    const hidden = await txn(f.A, f.accAprivate);
    ok(await patch(f.A, `/transactions/${hidden}`, { categoryId: cat }));
    const r = await f.B.request('DELETE', url(`/categories/${cat}?replaceWith=${f.uncategorized}`));
    ok(r);
    expect(r.body.data.moved).toBe(0); // counts only what B can see
    expect((await f.A.get(url(`/transactions/${hidden}`))).body.data.categoryId).toBe(
      f.uncategorized,
    );
  },
  'CAT-03/VIEW': async () => {
    const cat = (await f.A.post(url('/categories'), { name: 'Kept', groupId: f.firstGroup })).body
      .data.id;
    refused(await f.V.delete(url(`/categories/${cat}`)));
  },
  'CAT-04/OWN': async () =>
    refused(await f.A.delete(url(`/categories/${f.uncategorized}`)), 409, 'system_category'),
  'CAT-04/MEM': async () =>
    refused(await f.B.delete(url(`/categories/${f.uncategorized}`)), 409, 'system_category'),
  'CAT-04/VIEW': async () => refused(await f.V.delete(url(`/categories/${f.uncategorized}`))),

  // ── 4.8 Sessions ──
  'TOK-04/OWN': async () => ok(await f.A.get('/api/v1/me/sessions')),
  'TOK-04/MEM': async () => ok(await f.B.get('/api/v1/me/sessions')),
  'TOK-04/VIEW': async () => ok(await f.V.get('/api/v1/me/sessions')),

  // ── 6 Edge cases ──
  'EDGE-05': async () => {
    refused(await f.V.get(url(`/accounts/${f.accAprivate}`)), 404);
    expect(JSON.stringify((await f.V.get(url('/accounts'))).body)).not.toContain(f.accAprivate);
  },
  'EDGE-06': async () =>
    refused(
      await f.A.request('PATCH', url(`/members/${f.member.A}`), { role: 'member' }),
      409,
      'last_owner',
    ),
  'EDGE-08': async () => {
    ok(await f.B.get(url(`/accounts/${f.accAview}`)));
    ok(await patch(f.A, `/accounts/${f.accAview}`, { visibility: 'private' }));
    refused(await f.B.get(url(`/accounts/${f.accAview}`)), 404);
    refused(await f.B.get(url(`/transactions/${f.tAview}`)), 404);
    ok(await patch(f.A, `/accounts/${f.accAview}`, { visibility: 'view_only' }));
  },
};

describe('permissions matrix', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    let n = 0;
    const signup = async (name: string) => {
      const c = new TestClient(app);
      await c.post('/api/v1/auth/signup', {
        email: `${name.toLowerCase()}${n++}@perm.test`,
        password: 'permissions matrix password',
        displayName: name,
      });
      return c;
    };
    const A = await signup('Ada');
    const hh = (
      await A.post('/api/v1/households', { name: 'Home', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data;
    const join = async (role: 'member' | 'viewer') => {
      const c = await signup(role === 'member' ? 'Mel' : 'Val');
      const me = (await c.get('/api/v1/me')).body.data;
      const invite = await A.post(`/api/v1/households/${hh.id}/invites`, { email: me.email, role });
      const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
      expect((await c.post('/api/v1/invites/accept', { token })).status).toBe(200);
      return c;
    };
    const B = await join('member');
    const V = await join('viewer');
    const memberId = async (c: TestClient) =>
      (await c.get(`/api/v1/households/${hh.id}`)).body.data.you.memberId as string;
    f = {
      hh: hh.id,
      A,
      B,
      V,
      member: { A: hh.you.memberId, B: await memberId(B), V: await memberId(V) },
      signup,
      join,
    } as Fixture;
    f.accA = await account(A, 'full');
    f.accAview = await account(A, 'view_only');
    f.accAprivate = await account(A, 'private');
    f.accB = await account(B, 'full');
    f.tA = await txn(A, f.accA);
    f.tAview = await txn(A, f.accAview);
    f.tPriv = await txn(A, f.accAprivate);
    f.tB = await txn(B, f.accB);
    const groups = (await A.get(url('/categories'))).body.data;
    f.firstGroup = groups[0].id;
    f.uncategorized = groups
      .flatMap((g: { categories: { id: string; systemKey: string | null }[] }) => g.categories)
      .find((c: { systemKey: string | null }) => c.systemKey === 'uncategorized').id;
    ok(await A.request('PUT', url(`/transactions/${f.tA}/notes/shared`), { body: 'Shared note' }));
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  for (const [cell, check] of Object.entries(CELLS)) {
    it(`[${cell}]`, () => check(cell.split('/')[1] as Actor));
  }
});
