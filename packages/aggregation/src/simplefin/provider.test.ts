// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isProviderError,
  type ProviderErrorKind,
  type ProviderSecret,
  type SyncPage,
  type SyncRequest,
} from '@fiscus/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { describeProviderConformance } from '../testing/conformance.js';
import {
  type FakeSimpleFin,
  type FakeSimpleFinFailure,
  startFakeSimpleFin,
} from '../testing/fake-simplefin.js';
import { RIVERA, riveraScenario } from '../testing/rivera.js';
import {
  claimSetupToken,
  decodeSetupToken,
  SimpleFinClient,
  simpleFinItemId,
  SimpleFinTokenError,
} from './client.js';
import { SIMPLEFIN_CAPABILITIES, SimpleFinProvider } from './provider.js';

// The SimpleFIN adapter (#91) against the fake Bridge: the conformance suite every adapter
// passes, then what's particular to SimpleFIN (tokens, where they may point, errors, windows).

/** The Bridge's answer for each kind it can report. */
const FAILURES: Partial<Record<ProviderErrorKind, FakeSimpleFinFailure>> = {
  login_required: { status: 403 },
  consent_expired: { status: 402 },
  rate_limited: { status: 429, headers: { 'retry-after': '60' } },
  transient: { status: 503 },
};

const local = (fake: FakeSimpleFin) => ({ allowedHosts: [fake.host], allowHttp: true });
const NOW = () => new Date(riveraScenario().now);

describeProviderConformance(
  'SimpleFinProvider',
  async ({ scenario, fail }) => {
    const fake = await startFakeSimpleFin({ scenario });
    let syncs = 0;
    class Scripted extends SimpleFinProvider {
      override sync(secret: ProviderSecret, request: SyncRequest): Promise<SyncPage> {
        if (fail && syncs++ === fail.onSync) {
          fake.failNext({
            ...(FAILURES[fail.kind] as object),
            body: fail.providerMessage,
          } as never);
        }
        return super.sync(secret, request);
      }
    }
    return {
      provider: new Scripted({ ...local(fake), now: NOW }),
      secret: fake.accessUrl,
      release: () => fake.release(),
      close: () => fake.close(),
    };
  },
  {
    errorKinds: Object.keys(FAILURES) as ProviderErrorKind[],
    // SimpleFIN has no merchant names or original foreign amounts; it doesn't give an account's
    // official name, last 4 (unless its name has them), or whether it's closed; nor a credit limit.
    unsupportedFields: ['merchantName', 'foreignAmountMinor', 'foreignCurrency'],
    unsupportedAccountFields: ['officialName', 'mask', 'closed'],
    unsupportedBalanceFields: ['creditLimitMinor'],
  },
);

describe('SimpleFinProvider', () => {
  let fake: FakeSimpleFin | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  describe('setup tokens', () => {
    it('claims a token once, from the server, and keeps only the access URL', async () => {
      fake = await startFakeSimpleFin();
      const access = await claimSetupToken(fake.setupToken, local(fake));
      expect(access).toBe(`${fake.accessUrl}`);
      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'POST /claim/rivera-setup',
      ]);
      const again = await claimSetupToken(fake.setupToken, local(fake)).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(SimpleFinTokenError);
      expect((again as SimpleFinTokenError).code).toBe('token_used');
      expect((again as Error).message).toBe(
        'This token has been used. Create a new one at the SimpleFIN Bridge.',
      );
      // A stable id that says nothing about the credentials.
      expect(simpleFinItemId(access)).toMatch(/^sfin-[0-9a-f]{32}$/);
      expect(simpleFinItemId(access)).not.toContain('rivera');
    });

    it('refuses what isn’t a token, or one pointing anywhere but the Bridge, before any request', async () => {
      const refuse = (token: string, options = {}) => {
        try {
          decodeSetupToken(token, options);
        } catch (e) {
          return (e as SimpleFinTokenError).code;
        }
        return 'accepted';
      };
      const b64 = (s: string) => Buffer.from(s).toString('base64');
      expect(refuse('hello there')).toBe('not_a_token');
      expect(refuse(b64('just some text'))).toBe('not_a_token');
      expect(refuse(b64('https://bridge.simplefin.org/simplefin/claim/abc'))).toBe('accepted');
      expect(refuse(b64('https://beta-bridge.simplefin.org/simplefin/claim/abc'))).toBe('accepted');
      for (const url of [
        'http://bridge.simplefin.org/simplefin/claim/abc', // not https
        'https://evil.example/claim/abc',
        'https://bridge.simplefin.org.evil.example/claim/abc',
        'https://169.254.169.254/latest/meta-data',
        'https://localhost/claim',
      ]) {
        expect(refuse(b64(url)), url).toBe('host_not_allowed');
      }
    });

    it('refuses an access URL on another host than the claim', async () => {
      fake = await startFakeSimpleFin();
      fake.failNext({ status: 500 });
      const claim = Buffer.from(`${fake.url}/claim/elsewhere`).toString('base64');
      const elsewhere = async () => ({ body: 'https://user:pass@evil.example/simplefin' });
      const fetcher: typeof fetch = async () => new Response((await elsewhere()).body);
      const e = await claimSetupToken(claim, { ...local(fake), fetch: fetcher }).catch(
        (err: unknown) => err,
      );
      expect((e as SimpleFinTokenError).code).toBe('host_not_allowed');
    });
  });

  describe('requests', () => {
    it('sends the credentials as Basic auth, never in the URL, and refuses redirects', async () => {
      fake = await startFakeSimpleFin();
      const provider = new SimpleFinProvider({ ...local(fake), now: NOW });
      await provider.listAccounts(fake.accessUrl);
      const [r] = fake.requests;
      expect(r!.path).toBe('/simplefin/accounts');
      expect(r!.query.get('version')).toBe('2');
      expect(r!.query.get('balances-only')).toBe('1');
      expect(r!.headers.authorization).toMatch(/^Basic /);
      let init: RequestInit | undefined;
      await new SimpleFinClient(fake.accessUrl, {
        ...local(fake),
        fetch: async (_url, i) => {
          init = i;
          return new Response(JSON.stringify({ errlist: [], connections: [], accounts: [] }));
        },
      }).accounts();
      expect(init?.redirect).toBe('error');
    });

    it('keeps the access URL out of errors and of the client’s printed form', async () => {
      fake = await startFakeSimpleFin();
      const { accessUrl } = fake;
      const client = new SimpleFinClient(accessUrl, {
        ...local(fake),
        fetch: async () => {
          throw new TypeError(`fetch failed for ${accessUrl}`);
        },
      });
      const e = await client.accounts().catch((err: unknown) => err);
      expect(isProviderError(e) && e.kind).toBe('transient');
      for (const shown of [String(e), JSON.stringify(e), String(client), JSON.stringify(client)]) {
        expect(shown).not.toContain('rivera-bridge-password');
        expect(shown).not.toContain('rivera-bridge-user');
      }
    });

    it('caps how much it reads', async () => {
      fake = await startFakeSimpleFin();
      const client = new SimpleFinClient(fake.accessUrl, { ...local(fake), maxBytes: 1000 });
      const e = await client.accounts().catch((err: unknown) => err);
      expect(isProviderError(e) && e.providerCode).toBe('RESPONSE_TOO_LARGE');
    });

    it('maps 402 to the subscription and 403 to revoked access', async () => {
      fake = await startFakeSimpleFin();
      const provider = new SimpleFinProvider({ ...local(fake), now: NOW });
      fake.failNext({ status: 402, body: 'Pay up, Alex Rivera' });
      let e = await provider.sync(fake.accessUrl, { cursor: null }).catch((err: unknown) => err);
      expect(isProviderError(e) && [e.kind, e.providerCode]).toEqual([
        'consent_expired',
        'SIMPLEFIN_PAYMENT_REQUIRED',
      ]);
      expect(String(e)).not.toContain('Alex');
      fake.failNext({ status: 403 });
      e = await provider.sync(fake.accessUrl, { cursor: null }).catch((err: unknown) => err);
      expect(isProviderError(e) && [e.kind, e.providerCode]).toEqual([
        'login_required',
        'SIMPLEFIN_ACCESS_REVOKED',
      ]);
    });
  });

  describe('sync', () => {
    it('asks for 90 days with pending by default, as one window ending today', async () => {
      fake = await startFakeSimpleFin();
      const provider = new SimpleFinProvider({ ...local(fake), now: NOW });
      const page = await provider.sync(fake.accessUrl, { cursor: null });
      expect(page.window).toMatchObject({ from: '2026-07-22', to: '2026-10-20' });
      expect(fake.requests[0]!.query.get('pending')).toBe('1');
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
      expect(SIMPLEFIN_CAPABILITIES.minRefreshMs).toBe(6 * 60 * 60_000);
    });

    it('dates transactions in the household’s time zone, and bare dates as they are', async () => {
      fake = await startFakeSimpleFin();
      const provider = new SimpleFinProvider({ ...local(fake), now: NOW });
      // The fake sends bare dates (midnight UTC): the same day in any zone.
      const tokyo = await provider.sync(fake.accessUrl, { cursor: null, timeZone: 'Asia/Tokyo' });
      const la = await provider.sync(fake.accessUrl, {
        cursor: null,
        timeZone: 'America/Los_Angeles',
      });
      const dates = (p: SyncPage) => p.added.map((t) => [t.postedDate, t.authorizedDate]);
      expect(dates(tokyo)).toEqual(dates(la));
    });

    it('keeps what an account with an error had, and says which', async () => {
      fake = await startFakeSimpleFin();
      fake.failNext({
        errlist: [{ code: 'act.auth', msg: 'Alex, sign in again', account_id: RIVERA.visa }],
      });
      const provider = new SimpleFinProvider({ ...local(fake), now: NOW });
      const page = await provider.sync(fake.accessUrl, { cursor: null });
      expect(page.window!.providerAccountIds).not.toContain(RIVERA.visa);
      expect(page.added.some((t) => t.providerAccountId === RIVERA.visa)).toBe(false);
      expect(page.accountErrors).toEqual([{ providerAccountId: RIVERA.visa, code: 'act.auth' }]);
      expect(JSON.stringify(page)).not.toContain('Alex');
    });

    it('fails the sync when the Bridge returns errors and no accounts', async () => {
      fake = await startFakeSimpleFin({ scenario: { ...riveraScenario(), accounts: [] } });
      fake.failNext({ errlist: [{ code: 'gen.down', msg: 'Down for maintenance' }] });
      const provider = new SimpleFinProvider({ ...local(fake), now: NOW });
      const e = await provider.sync(fake.accessUrl, { cursor: null }).catch((err: unknown) => err);
      expect(isProviderError(e) && [e.kind, e.providerCode]).toEqual(['transient', 'gen.down']);
    });

    it('does nothing at the Bridge to remove a connection', async () => {
      fake = await startFakeSimpleFin();
      await new SimpleFinProvider(local(fake)).remove();
      expect(fake.requests).toEqual([]);
    });
  });
});
