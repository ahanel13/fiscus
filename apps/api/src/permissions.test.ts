// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
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
  connA: string; // A's, behind accA
  connAprivate: string; // A's, behind accAprivate
  connB: string; // B's, behind accB
  db: pg.Client; // as the schema owner
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
/** A bank connection owned by `memberId`, syncing these accounts. */
const connection = async (memberId: string, accountIds: string[]) => {
  const id = crypto.randomUUID();
  await f.db.query(
    `INSERT INTO connections (id, household_id, owner_member_id, provider, provider_item_id, status)
     VALUES ($1, $2, $3, 'plaid', $4, 'ok')`,
    [id, f.hh, memberId, `item-${id}`],
  );
  await f.db.query('UPDATE accounts SET connection_id = $1 WHERE id = ANY($2)', [id, accountIds]);
  return id;
};
const connectionIds = async (c: TestClient) => {
  const r = await c.get(url('/connections'));
  ok(r);
  return r.body.data.map((x: { id: string }) => x.id) as string[];
};
const RULE = {
  conditions: { description: { op: 'contains', value: 'zzz-never' } },
  actions: { markReviewed: true },
};
/** A rule of the client's own (#58). */
const ownRule = async (c: TestClient) => {
  const r = await c.post(url('/rules'), { scope: 'mine', ...RULE });
  ok(r);
  return r.body.data.id as string;
};
const ruleIds = async (c: TestClient) =>
  ((await c.get(url('/rules'))).body.data as { id: string }[]).map((r) => r.id);
/** Categorizes every uncategorized transaction in the fixture ("Item"). */
const PREVIEW = () => ({
  conditions: { description: { op: 'contains', value: 'item' }, categoryId: null },
  actions: { categoryId: f.uncategorized },
});
let imported = 0;
/** A one-row import into an account (start, then rows); each call imports a new row. */
const importInto = async (
  c: TestClient,
  accountId: string,
): Promise<Res & { batchId?: string }> => {
  const start = await c.post(url('/imports'), {
    format: 'csv',
    filename: 'perm.csv',
    accounts: [{ key: 'file', accountId }],
  });
  if (start.status >= 300) return start;
  const batchId = start.body.data.batches[0].batchId as string;
  const rows = await c.post(url(`/imports/${batchId}/rows`), {
    transactions: [
      {
        line: 2,
        date: '2026-02-01',
        amountMinor: -++imported,
        description: `Imported ${imported}`,
      },
    ],
  });
  return Object.assign(rows, { batchId });
};
const attribute = (c: TestClient, id: string, members: string[]) =>
  c.request('PUT', url(`/transactions/${id}/attribution`), {
    attribution: members.map((memberId) => ({ memberId })),
  });

/** HH-19: the server's check, a proof from the current head (empty), and a report. */
const checkHistory = async (c: TestClient) => {
  ok(await c.get(url('/activity/verify')));
  const head = (await c.get(url('/activity/proof'))).body.data.head;
  const r = await c.get(url(`/activity/proof?after=${head.seq}&hash=${head.hash}`));
  ok(r);
  expect(r.body.data.leaves).toEqual([]);
  expect(JSON.stringify(r.body)).not.toContain(f.accAprivate);
  ok(
    await c.post(url('/activity/integrity-reports'), {
      lastVerified: head,
      observed: { seq: head.seq },
      reason: 'fold_mismatch',
    }),
  );
};

/** Every built cell. Rows not built yet are listed in permissions-coverage.test.ts. */
const CELLS: Record<string, (a: Actor) => Promise<void>> = {
  // ── 4.1 Household and membership ──
  'HH-01/OWN': async () => ok(await f.A.get(url())),
  'HH-01/MEM': async () => ok(await f.B.get(url())),
  'HH-01/VIEW': async () => ok(await f.V.get(url())),
  // Your own name and color, nobody else's (there's no route to change another member's).
  'HH-18/OWN': async () => ok(await f.A.request('PATCH', url('/me'), { displayName: 'Ada' })),
  'HH-18/MEM': async () => ok(await f.B.request('PATCH', url('/me'), { displayName: 'Bea' })),
  'HH-18/VIEW': async () => ok(await f.V.request('PATCH', url('/me'), { displayName: 'Vic' })),
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
  // Anyone checks the history for themselves, and reports a failed check (#264).
  'HH-19/OWN': async () => checkHistory(f.A),
  'HH-19/MEM': async () => checkHistory(f.B),
  'HH-19/VIEW': async () => checkHistory(f.V),

  // ── 4.2 Accounts ──
  // Connections are made by the link flow (ACC-01: connections/plaid-link.test.ts); here,
  // straight in the database.
  // Visible to their owner and to anyone who sees one of their accounts.
  'ACC-02/OWN': async () => {
    const ids = await connectionIds(f.A);
    expect(ids).toContain(f.connA);
    expect(ids).toContain(f.connB); // B's, behind B's full account
  },
  'ACC-02/MEM': async () => {
    const r = await f.B.get(url('/connections'));
    ok(r);
    expect(r.body.data.map((c: { id: string }) => c.id)).not.toContain(f.connAprivate);
    expect(r.body.data.find((c: { id: string }) => c.id === f.connA)).toMatchObject({
      owner: { memberId: f.member.A, name: 'Ada' },
      accountCount: 1,
      status: 'ok',
      provider: 'plaid',
    });
  },
  'ACC-02/VIEW': async () => {
    const ids = await connectionIds(f.V);
    expect(ids).toEqual(expect.arrayContaining([f.connA, f.connB]));
    expect(ids).not.toContain(f.connAprivate);
  },
  // Its owner disconnects it; a household owner may once its owner has left.
  'ACC-03/OWN': async () => {
    const acc = await account(f.A);
    ok(await f.A.delete(url(`/connections/${await connection(f.member.A, [acc])}`)));
    ok(await f.A.get(url(`/accounts/${acc}`))); // the account stays (D14)
    refused(await f.A.delete(url(`/connections/${f.connB}`)));
    const leaver = await f.join('member');
    const leaverId = (await leaver.get(url())).body.data.you.memberId as string;
    const theirs = await connection(leaverId, [await account(f.A)]);
    refused(await f.A.delete(url(`/connections/${theirs}`)));
    ok(await leaver.post(url('/leave')));
    refused(await f.B.delete(url(`/connections/${theirs}`)));
    ok(await f.A.delete(url(`/connections/${theirs}`)));
  },
  'ACC-03/MEM': async () => {
    ok(await f.B.delete(url(`/connections/${await connection(f.member.B, [])}`)));
    refused(await f.B.delete(url(`/connections/${f.connA}`)));
    refused(await f.B.delete(url(`/connections/${f.connAprivate}`)), 404);
  },
  'ACC-03/VIEW': async () => refused(await f.V.delete(url(`/connections/${f.connA}`))),
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
  // Your own arrangement of the accounts list: anyone arranges what they see, privately.
  'ACC-12/OWN': async () => {
    const layout = { groups: [{ name: 'Mine', accountIds: [f.accAprivate] }], ungrouped: [f.accB] };
    ok(await f.A.request('PUT', url('/account-layout'), layout));
    expect((await f.A.get(url('/account-layout'))).body.data).toMatchObject({
      groups: [{ name: 'Mine', accountIds: [f.accAprivate] }],
      ungrouped: [f.accB],
    });
  },
  'ACC-12/MEM': async () => {
    // Someone else's account is fine to arrange; one you can't see is "no such account".
    ok(await f.B.request('PUT', url('/account-layout'), { groups: [], ungrouped: [f.accA] }));
    refused(
      await f.B.request('PUT', url('/account-layout'), { groups: [], ungrouped: [f.accAprivate] }),
      422,
      'unknown_account',
    );
    expect((await f.B.get(url('/account-layout'))).body.data).toEqual({
      groups: [],
      ungrouped: [f.accA],
    });
  },
  'ACC-12/VIEW': async () => {
    const layout = { groups: [{ name: 'Watching', accountIds: [f.accAview] }], ungrouped: [] };
    ok(await f.V.request('PUT', url('/account-layout'), layout));
    expect((await f.V.get(url('/account-layout'))).body.data.groups).toMatchObject([
      { name: 'Watching', accountIds: [f.accAview] },
    ]);
  },

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
  // Rules: everyone reads household-wide rules; owners and members change and apply them.
  'RULE-01/OWN': async () => ok(await f.A.get(url('/rules'))),
  'RULE-01/MEM': async () => ok(await f.B.get(url('/rules'))),
  'RULE-01/VIEW': async () => ok(await f.V.get(url('/rules'))),
  'RULE-03/OWN': async () => {
    const r = await f.A.post(url('/rules'), RULE);
    ok(r);
    ok(await f.A.request('DELETE', url(`/rules/${r.body.data.id}`)));
  },
  'RULE-03/MEM': async () => {
    const r = await f.B.post(url('/rules'), RULE);
    ok(r);
    ok(await f.B.request('PATCH', url(`/rules/${r.body.data.id}`), { enabled: false }));
  },
  'RULE-03/VIEW': async () => refused(await f.V.post(url('/rules'), RULE)),
  // Rules of your own (#58): only you see them, and only you change them; viewers make none.
  'RULE-02/OWN': async () => {
    const id = await ownRule(f.A);
    expect(await ruleIds(f.A)).toContain(id);
    expect(await ruleIds(f.B)).not.toContain(id);
    expect(await ruleIds(f.V)).not.toContain(id);
  },
  'RULE-02/MEM': async () => {
    const id = await ownRule(f.B);
    expect(await ruleIds(f.B)).toContain(id);
    expect(await ruleIds(f.A)).not.toContain(id);
  },
  'RULE-02/VIEW': async () => {
    const theirs = [await ownRule(f.A), await ownRule(f.B)];
    const r = await f.V.get(url('/rules'));
    ok(r);
    const seen = r.body.data as { id: string; scope: string }[];
    expect(seen.filter((x) => x.scope === 'mine')).toEqual([]);
    for (const id of theirs) expect(seen.map((x) => x.id)).not.toContain(id);
  },
  'RULE-04/OWN': async () => {
    const id = await ownRule(f.A);
    ok(await f.A.request('PATCH', url(`/rules/${id}`), { enabled: false }));
    ok(await f.A.request('DELETE', url(`/rules/${id}`)));
    refused(
      await f.A.request('PATCH', url(`/rules/${await ownRule(f.B)}`), { enabled: false }),
      404,
    );
  },
  'RULE-04/MEM': async () => {
    const id = await ownRule(f.B);
    ok(await f.B.request('PATCH', url(`/rules/${id}`), { enabled: false }));
    ok(await f.B.request('DELETE', url(`/rules/${id}`)));
    refused(await f.B.request('DELETE', url(`/rules/${await ownRule(f.A)}`)), 404);
  },
  'RULE-04/VIEW': async () => refused(await f.V.post(url('/rules'), { scope: 'mine', ...RULE })),
  // The preview lists only rows the caller can see: B never sees A's private account's rows.
  'RULE-06/OWN': async () => {
    const r = await f.A.post(url('/rules/preview'), PREVIEW());
    ok(r);
    expect(JSON.stringify(r.body)).toContain(f.tPriv);
  },
  'RULE-06/MEM': async () => {
    const r = await f.B.post(url('/rules/preview'), PREVIEW());
    ok(r);
    expect(JSON.stringify(r.body)).not.toContain(f.tPriv);
  },
  'RULE-06/VIEW': async () => refused(await f.V.post(url('/rules/preview'), PREVIEW())),
  // Linking a transfer needs ownership of both legs' accounts (acct-own, both legs visible).
  'TXN-08/OWN': async () => {
    const out = await txn(f.A, f.accA, -7777);
    const into = await txn(f.A, f.accAview, 7777);
    // Entered a day apart is still within detection's window, so it may be linked already.
    if ((await f.A.get(url(`/transactions/${out}`))).body.data.transfer === null) {
      ok(await f.A.post(url(`/transactions/${out}/transfer`), { transactionId: into }));
    }
    ok(await f.A.request('DELETE', url(`/transactions/${out}/transfer`)));
    ok(await f.A.post(url(`/transactions/${out}/transfer`), { transactionId: into }));
  },
  'TXN-08/MEM': async () => {
    const out = await txn(f.B, f.accB, -8888);
    const extra = await account(f.B);
    const into = await txn(f.B, extra, 8888);
    ok(await f.B.request('DELETE', url(`/transactions/${out}/transfer`)));
    ok(await f.B.post(url(`/transactions/${out}/transfer`), { transactionId: into }));
    // One leg in an account they only see (full access): refused.
    const theirs = await txn(f.A, f.accA, 9999);
    const mine = await txn(f.B, f.accB, -9999);
    refused(await f.B.post(url(`/transactions/${mine}/transfer`), { transactionId: theirs }));
    refused(await f.B.post(url(`/transactions/${f.tPriv}/transfer`), { transactionId: mine }), 404);
    // Linking from the review, a group at a time (#332): the same, pair by pair.
    const group = await f.B.post(url('/transactions/transfer-review/link'), {
      pairs: [
        { out: mine, into: theirs },
        { out: f.tPriv, into: mine },
      ],
    });
    ok(group);
    expect(group.body.data).toMatchObject({
      linked: 0,
      refused: [
        { id: mine, code: 'forbidden' },
        { id: f.tPriv, code: 'not_found' },
      ],
    });
    // Undoing from the review: a transfer with a leg they don't own stays linked.
    const aOut = await txn(f.A, f.accA, -6666);
    const aIn = await txn(f.A, f.accAview, 6666);
    const made = await f.A.post(url('/transactions/transfer-review/link'), {
      pairs: [{ out: aOut, into: aIn }],
    });
    const groups = made.body.data.groups as string[];
    const undo = await f.B.post(url('/transactions/transfer-review/unlink'), {
      groups: groups.length ? groups : [crypto.randomUUID()],
    });
    ok(undo);
    expect(undo.body.data).toEqual({ unlinked: 0 });
  },
  'TXN-08/VIEW': async () => {
    refused(await f.V.post(url(`/transactions/${f.tA}/transfer`), { transactionId: f.tB }));
    refused(
      await f.V.post(url('/transactions/transfer-review/link'), {
        pairs: [{ out: f.tA, into: f.tB }],
      }),
    );
    refused(
      await f.V.post(url('/transactions/transfer-review/unlink'), {
        groups: [crypto.randomUUID()],
      }),
    );
  },
  // Moving needs ownership of both accounts (acct-own).
  // A transaction's history: whoever can see it, and 404 for one they can't (#46).
  'TXN-11/OWN': async () => ok(await f.A.get(url(`/transactions/${f.tPriv}/history`))),
  'TXN-11/MEM': async () => {
    ok(await f.B.get(url(`/transactions/${f.tA}/history`)));
    refused(await f.B.get(url(`/transactions/${f.tPriv}/history`)), 404);
  },
  'TXN-11/VIEW': async () => {
    ok(await f.V.get(url(`/transactions/${f.tA}/history`)));
    refused(await f.V.get(url(`/transactions/${f.tPriv}/history`)), 404);
  },
  'TXN-12/OWN': async () => {
    const t = await txn(f.A, f.accA);
    const r = await f.A.post(url('/transactions/move'), { ids: [t], accountId: f.accAview });
    ok(r);
    expect(r.body.data.updated).toEqual([t]);
  },
  'TXN-12/MEM': async () => {
    const t = await txn(f.B, f.accB);
    ok(await f.B.post(url('/transactions/move'), { ids: [t], accountId: await account(f.B) }));
    // Into a visible account they don't own: refused; out of one: refused per row.
    refused(await f.B.post(url('/transactions/move'), { ids: [t], accountId: f.accA }));
    const r = await f.B.post(url('/transactions/move'), { ids: [f.tA], accountId: f.accB });
    expect(r.body.data.refused).toEqual([{ id: f.tA, code: 'forbidden' }]);
  },
  'TXN-12/VIEW': async () =>
    refused(await f.V.post(url('/transactions/move'), { ids: [f.tA], accountId: f.accA })),
  // Importing needs ownership of the account (acct-own); undoing, the importer or an owner.
  'TXN-09/OWN': async () => ok(await importInto(f.A, f.accA)),
  'TXN-09/MEM': async () => {
    ok(await importInto(f.B, f.accB));
    refused(await importInto(f.B, f.accA));
    refused(await importInto(f.B, f.accAprivate), 404);
  },
  'TXN-09/VIEW': async () => refused(await importInto(f.V, f.accA)),
  'TXN-10/OWN': async () => {
    const batch = (await importInto(f.A, f.accA)).batchId;
    ok(await f.A.post(url(`/imports/${batch}/revert`)));
  },
  'TXN-10/MEM': async () => {
    const own = (await importInto(f.B, f.accB)).batchId;
    ok(await f.B.post(url(`/imports/${own}/revert`)));
    // Not the importer, and only full access to the account.
    const others = (await importInto(f.A, f.accA)).batchId;
    refused(await f.B.post(url(`/imports/${others}/revert`)));
    // Not the importer, but an owner of the account.
    const joint = (
      await f.A.post(url('/accounts'), {
        name: 'Joint',
        type: 'depository',
        owners: [{ memberId: f.member.A }, { memberId: f.member.B }],
      })
    ).body.data.id;
    const theirs = (await importInto(f.A, joint)).batchId;
    ok(await f.B.post(url(`/imports/${theirs}/revert`)));
  },
  'TXN-10/VIEW': async () => {
    const batch = (await importInto(f.A, f.accA)).batchId;
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
        password: 'permissions matrix Password1!',
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
    f.db = new pg.Client({ connectionString: tdb.ownerUrl });
    await f.db.connect();
    f.connA = await connection(f.member.A, [f.accA]);
    f.connAprivate = await connection(f.member.A, [f.accAprivate]);
    f.connB = await connection(f.member.B, [f.accB]);
    const groups = (await A.get(url('/categories'))).body.data;
    f.firstGroup = groups[0].id;
    f.uncategorized = groups
      .flatMap((g: { categories: { id: string; systemKey: string | null }[] }) => g.categories)
      .find((c: { systemKey: string | null }) => c.systemKey === 'uncategorized').id;
    ok(await A.request('PUT', url(`/transactions/${f.tA}/notes/shared`), { body: 'Shared note' }));
  }, 180_000);

  afterAll(async () => {
    await f?.db?.end();
    await app?.close();
    await tdb?.stop();
  });

  for (const [cell, check] of Object.entries(CELLS)) {
    it(`[${cell}]`, () => check(cell.split('/')[1] as Actor));
  }
});
