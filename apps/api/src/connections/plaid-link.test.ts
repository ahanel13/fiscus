// SPDX-License-Identifier: AGPL-3.0-or-later
import { jsonBody, RIVERA, startFakePlaid, type FakePlaid } from '@fiscus/aggregation/testing';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, todayIn } from '../common/dates.js';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Connecting a bank through Plaid Link (#79, the bank connections walkthrough §2–§3, D2, D4–D6),
 * against the fake Plaid server: the link token (ACC-01), the exchange, the suggestions, and
 * confirming owners and visibility before anything syncs.
 */

type Res = Awaited<ReturnType<TestClient['request']>>;
const ok = (r: Res) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
const refused = (r: Res, status: number, code?: string) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body.code).toBe(code);
};

/** Plaid's message for failures: untrusted text that never reaches a response. */
const UNTRUSTED = 'Alex Rivera, please sign in again at Harbor Credit Union';

let tdb: TestDatabase;
let app: NestFastifyApplication;
let plaid: FakePlaid;
let db: pg.Client;
let hh = '';
let A: TestClient;
let B: TestClient;
let V: TestClient;
const member = { A: '', B: '', V: '' };
const url = (p = '') => `/api/v1/households/${hh}${p}`;

/** Exchanges give a new Item each time, as Plaid does; `public-replay` gives the same one. */
let items = 0;
const exchange = (c: TestClient, publicToken = plaid.publicToken) =>
  c.post(url('/plaid/exchange'), { publicToken });
const linkTokenRequests = () =>
  plaid.requests.filter((r) => r.path === '/link/token/create').map((r) => jsonBody<any>(r));
const account = async (c: TestClient, body: Record<string, unknown>) => {
  const r = await c.post(url('/accounts'), { type: 'depository', ...body });
  ok(r);
  return r.body.data.id as string;
};
const connectionRow = async (id: string) =>
  (await db.query('SELECT * FROM connections WHERE id = $1', [id])).rows[0];
const connectionIds = async (c: TestClient) =>
  ((await c.get(url('/connections'))).body.data as { id: string }[]).map((x) => x.id);
const actions = async (c: TestClient) =>
  ((await c.get(url('/activity?limit=200'))).body.data as { action: string }[]).map(
    (e) => e.action,
  );

beforeAll(async () => {
  tdb = await startTestDatabase();
  plaid = await startFakePlaid();
  plaid.override('/item/public_token/exchange', (request) => {
    const { public_token } = jsonBody<{ public_token: string }>(request);
    if (public_token === plaid.publicToken || public_token === 'public-replay') {
      const item_id = public_token === 'public-replay' ? 'item-replay' : `item-${++items}`;
      return { body: { access_token: plaid.accessToken, item_id, request_id: 'r' } };
    }
    return {
      status: 400,
      body: {
        error_type: 'INVALID_INPUT',
        error_code: 'INVALID_PUBLIC_TOKEN',
        error_message: UNTRUSTED,
        request_id: 'r',
      },
    };
  });
  // Removing an Item would revoke the fake's one access token for every later test.
  plaid.override('/item/remove', { body: { request_id: 'r' } });
  app = await createTestApp(tdb.appUrl, {
    signupMode: 'open',
    plaid: {
      clientId: plaid.clientId,
      secret: plaid.secret,
      env: 'sandbox',
      apiBaseUrl: plaid.url,
    },
  });
  db = new pg.Client({ connectionString: tdb.ownerUrl });
  await db.connect();

  let n = 0;
  const signup = async (name: string) => {
    const c = new TestClient(app);
    await c.post('/api/v1/auth/signup', {
      email: `${name.toLowerCase()}${n++}@plaid.test`,
      password: 'plaid link test Password1!',
      displayName: name,
    });
    return c;
  };
  A = await signup('Alex');
  const created = (
    await A.post('/api/v1/households', { name: 'Riveras', baseCurrency: 'USD', timezone: 'UTC' })
  ).body.data;
  hh = created.id;
  member.A = created.you.memberId;
  const join = async (name: string, role: 'member' | 'viewer') => {
    const c = await signup(name);
    const me = (await c.get('/api/v1/me')).body.data;
    const invite = await A.post(url('/invites'), { email: me.email, role });
    const token = new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token')!;
    ok(await c.post('/api/v1/invites/accept', { token }));
    return c;
  };
  B = await join('Sam', 'member');
  V = await join('Val', 'viewer');
  member.B = (await B.get(url())).body.data.you.memberId;
  member.V = (await V.get(url())).body.data.you.memberId;
}, 180_000);

afterAll(async () => {
  await db?.end();
  await app?.close();
  await plaid?.close();
  await tdb?.stop();
});

describe('connecting a bank through Plaid Link (#79)', () => {
  /** A's accounts the suggestions are checked against. */
  const mine = { everyday: '', visa: '', old: '', notMine: '', spare: '' };
  /** A's connection, made by the exchange. */
  let connA = '';
  let offered: any[] = [];

  beforeAll(async () => {
    // By last 4 and type, with history ending on 2026-05-10.
    mine.everyday = await account(A, { name: 'Everyday', mask: '4410' });
    ok(
      await A.post(url('/transactions'), {
        accountId: mine.everyday,
        amountMinor: -1500,
        date: '2026-05-10',
        displayName: 'Coffee',
      }),
    );
    // By name, without a mask.
    mine.visa = await account(A, { name: 'harbor cu visa', type: 'credit' });
    // The closed one the bank still lists.
    mine.old = await account(A, { name: 'Old savings', mask: '0071' });
    ok(await A.post(url(`/accounts/${mine.old}/close`)));
    // Sam's savings has the same last 4 as the bank's: it isn't Alex's to link (ACC-01).
    mine.notMine = await account(B, { name: 'Harbor CU Savings', mask: '8812' });
    mine.spare = await account(A, { name: 'Spare' });
    // A Separate household: new accounts start view-only (ADR 0006 §8).
    await db.query(`UPDATE households SET finance_style = 'separate' WHERE id = $1`, [hh]);
  });

  it('[ACC-01/VIEW] viewers can’t ask for a link token or connect a bank', async () => {
    refused(await V.get(url('/plaid')), 403);
    refused(await V.post(url('/plaid/link-token')), 403);
    refused(await exchange(V), 403);
    expect(linkTokenRequests()).toEqual([]);
  });

  it('says Plaid is available, and in which environment, to owners and members', async () => {
    for (const c of [A, B]) {
      const r = await c.get(url('/plaid'));
      ok(r);
      expect(r.body.data).toEqual({ available: true, env: 'sandbox' });
    }
  });

  it('[ACC-01/OWN] gives a link token for the household’s keys: transactions, US/CA, 730 days', async () => {
    const r = await A.post(url('/plaid/link-token'));
    ok(r);
    expect(r.body.data).toEqual({
      linkToken: expect.stringMatching(/^link-sandbox-/),
      expiration: expect.any(String),
    });
    const [sent] = linkTokenRequests();
    expect(sent).toEqual({
      client_id: plaid.clientId,
      secret: plaid.secret,
      client_name: 'Fiscus',
      language: 'en',
      country_codes: ['US', 'CA'],
      user: { client_user_id: expect.stringMatching(/^[0-9a-f]{32}$/) },
      products: ['transactions'],
      // Consented now, billed only once called: no bank is hidden for them (LIAB-007).
      additional_consented_products: ['liabilities', 'investments'],
      transactions: { days_requested: 730 },
    });
    // Opaque: not the member id, nor an email; and the same for the same person.
    expect(sent.user.client_user_id).not.toContain(member.A.replaceAll('-', ''));
    ok(await A.post(url('/plaid/link-token')));
    expect(linkTokenRequests()[1].user.client_user_id).toBe(sent.user.client_user_id);
  });

  it('exchanges the public token once, keeping only an encrypted secret, in setup', async () => {
    const r = await exchange(A);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    connA = r.body.data.connectionId;
    offered = r.body.data.accounts;
    expect(r.body.data.institutionName).toBe('Harbor Credit Union');
    expect(JSON.stringify(r.body)).not.toContain(plaid.accessToken);

    const row = await connectionRow(connA);
    expect(row).toMatchObject({
      household_id: hh,
      owner_member_id: member.A,
      provider: 'plaid',
      status: 'setup',
      provider_env: 'sandbox',
      provider_client_id: plaid.clientId,
      provider_item_id: 'item-1',
      credential_set_id: null,
      next_sync_at: null,
    });
    const institution = (
      await db.query('SELECT * FROM institutions WHERE id = $1', [row.institution_id])
    ).rows[0];
    expect(institution).toMatchObject({
      provider: 'plaid',
      provider_institution_id: plaid.institutionId,
      name: 'Harbor Credit Union',
    });
    const secrets = (
      await db.query('SELECT secret_enc FROM connection_secrets WHERE connection_id = $1', [connA])
    ).rows;
    expect(secrets).toHaveLength(1);
    expect(Buffer.from(secrets[0].secret_enc).toString('latin1')).not.toContain(plaid.accessToken);

    // The same Item again (a replayed token) isn't a second connection.
    ok(await exchange(A, 'public-replay'));
    refused(await exchange(A, 'public-replay'), 409, 'already_connected');
  });

  it('suggests linking by last 4 and type, then name; new; or not tracking a closed one', () => {
    const by = Object.fromEntries(offered.map((a) => [a.providerAccountId, a]));
    expect(by[RIVERA.checking]).toMatchObject({
      name: 'Harbor CU Checking',
      officialName: 'Harbor Credit Union Everyday Checking',
      type: 'depository',
      subtype: 'checking',
      mask: '4410',
      currency: 'USD',
      balance: { amountMinor: 651_240, currency: 'USD' },
      suggestion: { choice: 'link', accountId: mine.everyday, by: 'mask' },
    });
    // Plaid's positive balance owed is negative in Fiscus.
    expect(by[RIVERA.visa]).toMatchObject({
      type: 'credit',
      balance: { amountMinor: -180_722, currency: 'USD' },
      suggestion: { choice: 'link', accountId: mine.visa, by: 'name' },
    });
    // Sam's account with the same last 4 isn't offered to Alex.
    expect(by[RIVERA.savings].suggestion).toEqual({
      choice: 'new',
      owners: [{ memberId: member.A }],
      // Private to start with, even in a Separate household (whose default is view-only).
      visibility: 'private',
    });
    expect(by[RIVERA.oldSavings].suggestion).toEqual({
      choice: 'skip',
      reason: 'closed',
      accountId: mine.old,
    });
  });

  it('[D4] shows a connection in setup to nobody else, and only its owner may confirm it', async () => {
    for (const c of [B, V]) {
      expect(await connectionIds(c)).not.toContain(connA);
      refused(await c.get(url(`/connections/${connA}/setup`)), c === V ? 403 : 404);
      refused(
        await c.post(url(`/connections/${connA}/confirm`), {
          accounts: [{ providerAccountId: RIVERA.checking, choice: 'skip' }],
        }),
        c === V ? 403 : 404,
      );
      expect((await actions(c)).filter((a) => a.startsWith('connection.'))).toEqual([]);
    }
    expect(await connectionIds(A)).toContain(connA);
    // Its owner can come back to it.
    const again = await A.get(url(`/connections/${connA}/setup`));
    ok(again);
    expect(again.body.data.accounts).toEqual(offered);
    expect((await connectionRow(connA)).status).toBe('setup');
  });

  it('refuses choices that don’t fit what the bank offers, or aren’t yours', async () => {
    const confirm = (accounts: unknown[]) =>
      A.post(url(`/connections/${connA}/confirm`), { accounts });
    const skipRest = (except: string[]) =>
      offered
        .filter((a) => !except.includes(a.providerAccountId))
        .map((a) => ({ providerAccountId: a.providerAccountId, choice: 'skip' }));
    refused(
      await confirm([{ providerAccountId: RIVERA.checking, choice: 'new' }]),
      422,
      'choices_mismatch',
    );
    refused(
      await confirm([...skipRest([]), { providerAccountId: 'not-offered', choice: 'skip' }]),
      422,
      'choices_mismatch',
    );
    refused(await confirm(skipRest([])), 422, 'nothing_tracked');
    refused(
      await confirm([
        ...skipRest([RIVERA.checking]),
        { providerAccountId: RIVERA.checking, choice: 'link', accountId: mine.notMine },
      ]),
      403,
    );
    refused(
      await confirm([
        ...skipRest([RIVERA.checking, RIVERA.savings]),
        { providerAccountId: RIVERA.checking, choice: 'link', accountId: mine.spare },
        { providerAccountId: RIVERA.savings, choice: 'link', accountId: mine.spare },
      ]),
      422,
      'linked_twice',
    );
    refused(
      await confirm([
        ...skipRest([RIVERA.savings]),
        { providerAccountId: RIVERA.savings, choice: 'new', owners: [{ memberId: member.B }] },
      ]),
      422,
      'must_own',
    );
    // Nothing was kept from the refused attempts.
    expect((await connectionRow(connA)).status).toBe('setup');
    expect(
      (await db.query('SELECT count(*)::int AS n FROM accounts WHERE connection_id = $1', [connA]))
        .rows[0].n,
    ).toBe(0);
  });

  it('confirms: links and creates accounts with their sync start, then syncs right away', async () => {
    const r = await A.post(url(`/connections/${connA}/confirm`), {
      accounts: [
        { providerAccountId: RIVERA.checking, choice: 'link', accountId: mine.everyday },
        { providerAccountId: RIVERA.visa, choice: 'link', accountId: mine.visa },
        { providerAccountId: RIVERA.savings, choice: 'new', visibility: 'full' },
        { providerAccountId: RIVERA.oldSavings, choice: 'skip' },
      ],
    });
    ok(r);
    const today = todayIn('UTC');
    const tracked = Object.fromEntries(
      (r.body.data.accounts as any[]).map((a) => [a.providerAccountId, a]),
    );
    expect(Object.keys(tracked).sort()).toEqual(
      [RIVERA.checking, RIVERA.savings, RIVERA.visa].sort(),
    );
    // Linked: a week before its history ends (D6); without history, 90 days back, as new ones.
    expect(tracked[RIVERA.checking]).toMatchObject({
      accountId: mine.everyday,
      linked: true,
      syncFrom: '2026-05-03',
    });
    expect(tracked[RIVERA.visa]).toMatchObject({
      accountId: mine.visa,
      linked: true,
      syncFrom: addDays(today, -90),
    });
    expect(tracked[RIVERA.savings]).toMatchObject({ linked: false, syncFrom: addDays(today, -90) });

    const rows = (
      await db.query(
        `SELECT id, name, official_name, type, mask_last4, provider_account_id, sync_from::text,
                visibility, currency
         FROM accounts WHERE connection_id = $1 ORDER BY provider_account_id`,
        [connA],
      )
    ).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        id: mine.everyday,
        name: 'Everyday',
        mask_last4: '4410',
        provider_account_id: RIVERA.checking,
      }),
      expect.objectContaining({
        provider_account_id: RIVERA.savings,
        name: 'Harbor CU Savings',
        type: 'depository',
        mask_last4: '8812',
        visibility: 'full',
        currency: 'USD',
      }),
      // A linked account keeps its name, and gains the last 4 it didn't have.
      expect.objectContaining({
        id: mine.visa,
        name: 'harbor cu visa',
        mask_last4: '3301',
        provider_account_id: RIVERA.visa,
      }),
    ]);
    const owners = (
      await db.query('SELECT member_id FROM account_owners WHERE account_id = $1', [
        tracked[RIVERA.savings].accountId,
      ])
    ).rows;
    expect(owners).toEqual([{ member_id: member.A }]);
    // The closed account stays as it was.
    expect((await A.get(url(`/accounts/${mine.old}`))).body.data.closedAt).not.toBeNull();

    const row = await connectionRow(connA);
    expect(row.status).toBe('ok');
    expect(row.next_sync_at.getTime()).toBeLessThanOrEqual(Date.now());

    // "Connection added" for each tracked account, without names or numbers.
    const events = (
      await db.query(
        `SELECT metadata FROM audit_events WHERE action = 'connection.added'
         AND target_id = $1`,
        [connA],
      )
    ).rows;
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.metadata).toEqual({ provider: 'plaid', linked: expect.any(Boolean) });
    }
    // Now its accounts are what others see it by (ACC-02).
    expect(await connectionIds(B)).toContain(connA);
    expect(await actions(B)).toContain('connection.added');
  });

  it('confirms once', async () => {
    refused(
      await A.post(url(`/connections/${connA}/confirm`), {
        accounts: [{ providerAccountId: RIVERA.checking, choice: 'skip' }],
      }),
      409,
      'not_in_setup',
    );
    refused(await A.get(url(`/connections/${connA}/setup`)), 409, 'not_in_setup');
  });

  describe('Link’s metadata', () => {
    const link = (masks: (string | null)[], extra: Record<string, unknown> = {}) => ({
      sessionId: 'link-session-1',
      institutionId: plaid.institutionId,
      accounts: masks.map((mask) => ({ mask, subtype: 'checking' })),
      ...extra,
    });
    const exchangeWith = (c: TestClient, body: Record<string, unknown>) =>
      c.post(url('/plaid/exchange'), { publicToken: plaid.publicToken, ...body });
    /** Events only their actor sees, which the household's feed leaves out. */
    const privateEvents = async (action: string, targetId?: string) =>
      (
        await db.query(
          `SELECT metadata, actor_member_id, visible_to_household FROM audit_events
            WHERE household_id = $1 AND action = $2 AND ($3::text IS NULL OR target_id = $3)`,
          [hh, action, targetId ?? null],
        )
      ).rows;
    const cancel = async (c: TestClient, id: string) =>
      expect((await c.delete(url(`/connections/${id}`))).status).toBeLessThan(300);

    it('[ITEM-011] refuses connecting the same accounts at a bank twice, before the exchange', async () => {
      const exchanges = () =>
        plaid.requests.filter((r) => r.path === '/item/public_token/exchange').length;
      // The replayed Item from the first test is still in setup: finish it, rather than another.
      const [replay] = (
        await db.query(
          `SELECT id FROM connections WHERE provider_item_id = 'item-replay' AND status = 'setup'`,
        )
      ).rows;
      const before = exchanges();
      let r = await exchangeWith(A, { link: link(['9999']) });
      refused(r, 409, 'bank_already_connected');
      expect(r.body).toMatchObject({ connectionId: replay.id, status: 'setup' });
      await cancel(A, replay.id);

      // connA tracks the checking account ending 4410.
      r = await exchangeWith(A, { link: link(['4410', null]) });
      refused(r, 409, 'bank_already_connected');
      expect(r.body).toMatchObject({ connectionId: connA, status: 'ok' });
      expect(r.body.detail).toContain('sign in to the bank again');
      expect(exchanges()).toBe(before);

      // Other accounts at the same bank, another bank, someone else's connection, or on purpose.
      for (const [c, body] of [
        [A, { link: link(['9999']) }],
        [A, { link: link(['4410'], { institutionId: 'ins_another' }) }],
        [B, { link: link(['4410']) }],
        [A, { link: link(['4410']), duplicateOk: true }],
      ] as const) {
        r = await exchangeWith(c, body);
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        await cancel(c, r.body.data.connectionId);
      }
      expect(exchanges()).toBe(before + 4);
    });

    it('keeps the Link session id with the setup, for Plaid’s support', async () => {
      const r = await exchangeWith(A, { link: link(['9999']) });
      expect(r.status).toBe(201);
      const [started] = await privateEvents('connection.setup_started', r.body.data.connectionId);
      expect(started.metadata).toEqual({
        provider: 'plaid',
        linkSessionId: 'link-session-1',
        institutionId: plaid.institutionId,
      });
      await cancel(A, r.body.data.connectionId);
    });

    it('records Link’s exits for the person only, with Plaid’s codes and never its message', async () => {
      const exit = {
        sessionId: 'link-session-2',
        status: 'requires_credentials',
        institutionId: plaid.institutionId,
        errorType: 'ITEM_ERROR',
        errorCode: 'INVALID_CREDENTIALS',
        requestId: 'req-1',
      };
      expect((await A.post(url('/plaid/link-exit'), exit)).status).toBe(204);
      expect((await A.post(url('/plaid/link-exit'), { sessionId: 'link-session-3' })).status).toBe(
        204,
      );
      const mine = await privateEvents('connection.link_exited');
      expect(mine.every((e) => e.actor_member_id === member.A && !e.visible_to_household)).toBe(
        true,
      );
      expect(mine.map((e) => e.metadata)).toEqual(
        expect.arrayContaining([
          {
            provider: 'plaid',
            linkSessionId: 'link-session-2',
            status: 'requires_credentials',
            institutionId: plaid.institutionId,
            errorType: 'ITEM_ERROR',
            errorCode: 'INVALID_CREDENTIALS',
            requestId: 'req-1',
          },
          { provider: 'plaid', linkSessionId: 'link-session-3' },
        ]),
      );
      refused(await V.post(url('/plaid/link-exit'), exit), 403);
      refused(await A.post(url('/plaid/link-exit'), { ...exit, errorMessage: UNTRUSTED }), 422);
      refused(await A.post(url('/plaid/link-exit'), {}), 422);
    });
  });

  it('[ACC-01/MEM] members connect too, and a private account keeps its connection theirs', async () => {
    ok(await B.post(url('/plaid/link-token')));
    const r = await exchange(B);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const connB = r.body.data.connectionId as string;
    expect((await connectionRow(connB)).owner_member_id).toBe(member.B);
    // Alex can't confirm it: not theirs, and in setup they can't even see it.
    refused(
      await A.post(url(`/connections/${connB}/confirm`), {
        accounts: [{ providerAccountId: RIVERA.checking, choice: 'new' }],
      }),
      404,
    );
    ok(
      await B.post(url(`/connections/${connB}/confirm`), {
        accounts: (r.body.data.accounts as any[]).map((a) =>
          a.providerAccountId === RIVERA.checking
            ? // No visibility given: a bank's new account starts private.
              { providerAccountId: a.providerAccountId, choice: 'new' }
            : { providerAccountId: a.providerAccountId, choice: 'skip' },
        ),
      }),
    );
    expect(await connectionIds(B)).toContain(connB);
    expect(await connectionIds(A)).not.toContain(connB);
    const [made] = (
      await db.query('SELECT visibility FROM accounts WHERE connection_id = $1', [connB])
    ).rows;
    expect(made.visibility).toBe('private');

    // Update mode (re-auth, ACC-03): its owner only, with the Item's access token, no products.
    const update = await B.post(url(`/plaid/link-token?connection=${connB}`));
    ok(update);
    const sent = linkTokenRequests().at(-1);
    expect(sent).toMatchObject({ access_token: plaid.accessToken, country_codes: ['US', 'CA'] });
    expect(sent).not.toHaveProperty('products');
    expect(sent).not.toHaveProperty('transactions');
    expect(JSON.stringify(update.body)).not.toContain(plaid.accessToken);
    // Someone else's connection is refused, even one they see; an unknown one doesn't exist.
    refused(await A.post(url(`/plaid/link-token?connection=${connB}`)), 404);
    refused(await B.post(url(`/plaid/link-token?connection=${connA}`)), 403);
    refused(await V.post(url(`/plaid/link-token?connection=${connA}`)), 403);
    refused(await A.post(url(`/plaid/link-token?connection=${crypto.randomUUID()}`)), 404);
    ok(await A.post(url(`/plaid/link-token?connection=${connA}`)));
  });

  it('update mode needs the keys the connection was made with, and a finished setup', async () => {
    const setup = (await exchange(A)).body.data.connectionId as string;
    refused(await A.post(url(`/plaid/link-token?connection=${setup}`)), 409, 'connection_in_setup');
    await db.query(`UPDATE connections SET provider_client_id = 'another-client' WHERE id = $1`, [
      connA,
    ]);
    try {
      refused(
        await A.post(url(`/plaid/link-token?connection=${connA}`)),
        409,
        'credentials_changed',
      );
    } finally {
      await db.query(`UPDATE connections SET provider_client_id = $1 WHERE id = $2`, [
        plaid.clientId,
        connA,
      ]);
    }
  });

  describe('when Plaid fails', () => {
    it('reports a used or expired public token, without Plaid’s message', async () => {
      const r = await exchange(A, 'public-sandbox-expired');
      refused(r, 422, 'invalid_public_token');
      expect(JSON.stringify(r.body)).not.toContain('Harbor');
    });

    it('ends the Item and stores nothing when the accounts can’t be read', async () => {
      const before = (await db.query('SELECT count(*)::int AS n FROM connections')).rows[0].n;
      const removes = plaid.requests.filter((q) => q.path === '/item/remove').length;
      plaid.failNext('/accounts/get', {
        error_type: 'ITEM_ERROR',
        error_code: 'ITEM_LOGIN_REQUIRED',
        error_message: UNTRUSTED,
      });
      const r = await exchange(A);
      refused(r, 409, 'login_required');
      expect(r.body.providerCode).toBe('ITEM_LOGIN_REQUIRED');
      expect(JSON.stringify(r.body)).not.toContain('Harbor');
      expect(plaid.requests.filter((q) => q.path === '/item/remove')).toHaveLength(removes + 1);
      expect((await db.query('SELECT count(*)::int AS n FROM connections')).rows[0].n).toBe(before);
    });

    it('passes on rate limits and outages as problems', async () => {
      plaid.failNext('/link/token/create', {
        error_type: 'RATE_LIMIT_EXCEEDED',
        error_code: 'RATE_LIMIT_EXCEEDED',
        error_message: UNTRUSTED,
        headers: { 'retry-after': '30' },
      });
      const limited = await A.post(url('/plaid/link-token'));
      refused(limited, 429, 'rate_limited');
      expect(limited.headers['retry-after']).toBe('30');
      plaid.failNext('/link/token/create', {
        error_type: 'API_ERROR',
        error_code: 'INTERNAL_SERVER_ERROR',
        error_message: UNTRUSTED,
      });
      const down = await A.post(url('/plaid/link-token'));
      refused(down, 502, 'provider_unavailable');
      expect(JSON.stringify([limited.body, down.body])).not.toContain('Harbor');
    });
  });

  describe('when Plaid isn’t available to the household', () => {
    it('says so when the household’s own keys can’t be read (#83)', async () => {
      const { rows } = await db.query(
        `INSERT INTO aggregation_credentials (id, household_id, provider, client_id, secret_enc, env)
         VALUES (gen_random_uuid(), $1, 'plaid', 'household-client', $2, 'sandbox') RETURNING id`,
        [hh, Buffer.from([0])],
      );
      try {
        expect((await A.get(url('/plaid'))).body.data).toEqual({
          available: false,
          reason: 'household_keys_unavailable',
        });
        refused(await A.post(url('/plaid/link-token')), 409, 'plaid_unavailable');
        refused(await exchange(A), 409, 'plaid_unavailable');
      } finally {
        await db.query('DELETE FROM aggregation_credentials WHERE id = $1', [rows[0].id]);
      }
    });

    it('says so when the server has no Plaid keys', async () => {
      const bare = await createTestApp(tdb.appUrl, { signupMode: 'open' });
      try {
        const c = new TestClient(bare);
        await c.post('/api/v1/auth/signup', {
          email: 'nokeys@plaid.test',
          password: 'plaid link test Password1!',
          displayName: 'Noa',
        });
        const id = (
          await c.post('/api/v1/households', {
            name: 'No keys',
            baseCurrency: 'USD',
            timezone: 'UTC',
          })
        ).body.data.id;
        expect((await c.get(`/api/v1/households/${id}/plaid`)).body.data).toEqual({
          available: false,
          reason: 'not_configured',
        });
        const r = await c.post(`/api/v1/households/${id}/plaid/link-token`);
        refused(r, 409, 'plaid_unavailable');
        expect(r.body.detail).toContain('no Plaid keys');
        refused(
          await c.post(`/api/v1/households/${id}/plaid/exchange`, { publicToken: 'public-x' }),
          409,
          'plaid_unavailable',
        );
      } finally {
        await bare.close();
      }
    });
  });
});
