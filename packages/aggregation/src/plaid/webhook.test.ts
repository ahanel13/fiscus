// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signPlaidWebhook, startFakePlaid, type FakePlaid } from '../testing/fake-plaid.js';
import { PlaidClient } from './client.js';
import { plaidWebhookUrl } from './config.js';
import {
  PLAID_WEBHOOK_PATH,
  plaidWebhookAction,
  PlaidWebhookKeys,
  readPlaidWebhookToken,
  verifyPlaidWebhookToken,
  type PlaidWebhookRejection,
} from './webhook.js';

let plaid: FakePlaid;
let client: PlaidClient;
beforeEach(async () => {
  plaid = await startFakePlaid();
  client = new PlaidClient({
    clientId: plaid.clientId,
    secret: plaid.secret,
    env: 'sandbox',
    apiBaseUrl: plaid.url,
  });
});
afterEach(() => plaid.close());

const BODY = JSON.stringify({
  webhook_type: 'TRANSACTIONS',
  webhook_code: 'SYNC_UPDATES_AVAILABLE',
  item_id: 'item-harbor-rivera',
});
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = () => Date.now();
const keyFetches = () =>
  plaid.requests.filter((r) => r.path === '/webhook_verification_key/get').length;

/** The whole check, as the receiver runs it: shape, then key, then signature. */
async function verify(
  header: string | undefined,
  body = BODY,
  keys = new PlaidWebhookKeys(),
): Promise<'ok' | PlaidWebhookRejection | 'unavailable'> {
  const read = readPlaidWebhookToken(header, Buffer.from(body), now());
  if (!read.ok) return read.reason;
  const key = await keys.get('server', read.token.kid, () => client);
  if (!key.found) return key.reason;
  const verified = await verifyPlaidWebhookToken(read.token, key.key, Buffer.from(body), now());
  return verified.ok ? 'ok' : verified.reason;
}

describe('Plaid webhook verification (#84, WEBHOOK-003/004)', () => {
  it('accepts a body signed with ES256 by the key Plaid serves for its kid', async () => {
    const signed = plaid.signWebhook(BODY);
    expect(await verify(signed.headers['plaid-verification'])).toBe('ok');
  });

  it('refuses a missing or empty header, and anything that is not a JWT', async () => {
    expect(await verify(undefined)).toBe('missing');
    expect(await verify('')).toBe('missing');
    expect(await verify('not-a-jwt')).toBe('malformed');
    expect(await verify('a.b.c')).toBe('malformed');
    expect(keyFetches()).toBe(0);
  });

  it('refuses alg none and HS256, without fetching a key', async () => {
    const payload = part({
      iat: Math.floor(now() / 1000),
      request_body_sha256: readHash(plaid.signWebhook(BODY).headers['plaid-verification']!),
    });
    const none = `${part({ alg: 'none', kid: plaid.webhookKey.kid })}.${payload}.`;
    expect(await verify(none)).toBe('algorithm');
    // HS256 with the public key's bytes as the secret: the classic confusion attack.
    const hsHeader = part({ alg: 'HS256', kid: plaid.webhookKey.kid });
    const mac = createHmac('sha256', 'any-secret')
      .update(`${hsHeader}.${payload}`)
      .digest('base64url');
    expect(await verify(`${hsHeader}.${payload}.${mac}`)).toBe('algorithm');
    expect(keyFetches()).toBe(0);
  });

  it('refuses a signature made with another key under Plaid’s kid', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const forged = plaid.signWebhook(BODY, { privateKey });
    expect(await verify(forged.headers['plaid-verification'])).toBe('signature');
    // One with its signature changed.
    const real = plaid.signWebhook(BODY).headers['plaid-verification']!;
    const [h, p, s] = real.split('.') as [string, string, string];
    const flipped = Buffer.from(s, 'base64url');
    flipped[10] = flipped[10]! ^ 1;
    expect(await verify(`${h}.${p}.${flipped.toString('base64url')}`)).toBe('signature');
  });

  it('refuses an unknown kid, and remembers it', async () => {
    const keys = new PlaidWebhookKeys();
    const signed = plaid.signWebhook(BODY, { kid: 'not-a-plaid-key' });
    expect(await verify(signed.headers['plaid-verification'], BODY, keys)).toBe('unknown_key');
    expect(await verify(signed.headers['plaid-verification'], BODY, keys)).toBe('unknown_key');
    expect(keyFetches()).toBe(1);
  });

  it('refuses a token older than five minutes, or from the future', async () => {
    const old = plaid.signWebhook(BODY, { iat: Math.floor(now() / 1000) - 5 * 60 - 5 });
    expect(await verify(old.headers['plaid-verification'])).toBe('stale');
    const ahead = plaid.signWebhook(BODY, { iat: Math.floor(now() / 1000) + 120 });
    expect(await verify(ahead.headers['plaid-verification'])).toBe('stale');
    const fresh = plaid.signWebhook(BODY, { iat: Math.floor(now() / 1000) - 4 * 60 });
    expect(await verify(fresh.headers['plaid-verification'])).toBe('ok');
  });

  it('refuses a changed body, even by whitespace: the raw bytes are hashed', async () => {
    const signed = plaid.signWebhook(BODY);
    const header = signed.headers['plaid-verification'];
    expect(await verify(header, BODY.replace('SYNC_UPDATES_AVAILABLE', 'LOGIN_REPAIRED'))).toBe(
      'body_hash',
    );
    expect(await verify(header, JSON.stringify(JSON.parse(BODY), null, 2))).toBe('body_hash');
    expect(await verify(header, `${BODY} `)).toBe('body_hash');
  });

  it('caches keys by credential set and kid, and fetches with that set’s own client', async () => {
    const keys = new PlaidWebhookKeys();
    const header = plaid.signWebhook(BODY).headers['plaid-verification'];
    expect(await verify(header, BODY, keys)).toBe('ok');
    expect(await verify(header, BODY, keys)).toBe('ok');
    expect(keyFetches()).toBe(1);
    // Another set asks with its own keys, even for the same kid.
    const read = readPlaidWebhookToken(header, Buffer.from(BODY), now());
    if (!read.ok) throw new Error(read.reason);
    let used = 0;
    const other = () => {
      used++;
      return client;
    };
    expect((await keys.get('household-set', read.token.kid, other)).found).toBe(true);
    expect(used).toBe(1);
    expect(keyFetches()).toBe(2);
  });

  it('caps key fetches per credential set per minute: the rest are unavailable (503)', async () => {
    let t = 1_000_000;
    const keys = new PlaidWebhookKeys({ fetchesPerMinute: 3, now: () => t });
    for (let i = 0; i < 3; i++) {
      expect(await keys.get('server', `made-up-${i}`, () => client)).toEqual({
        found: false,
        reason: 'unknown_key',
      });
    }
    expect(await keys.get('server', 'made-up-4', () => client)).toEqual({
      found: false,
      reason: 'unavailable',
    });
    expect(keyFetches()).toBe(3);
    // Another set has its own allowance; a minute later, so does this one.
    expect(keys.fetchesLeft('other')).toBe(3);
    t += 60_001;
    expect(keys.fetchesLeft('server')).toBe(3);
  });

  it('drops a key once Plaid says it has expired (rotation), and never uses an expired one', async () => {
    let t = Date.now();
    const keys = new PlaidWebhookKeys({ now: () => t });
    const expiresAt = Math.floor(t / 1000) + 60;
    const jwk = plaid.webhookKey.privateKey.export({ format: 'jwk' });
    const expired = expiresAt;
    plaid.override('/webhook_verification_key/get', () => ({
      body: {
        key: {
          alg: 'ES256',
          crv: 'P-256',
          kid: plaid.webhookKey.kid,
          kty: 'EC',
          use: 'sig',
          x: jwk.x,
          y: jwk.y,
          created_at: 1,
          expired_at: expired,
        },
        request_id: 'r',
      },
    }));
    expect((await keys.get('server', plaid.webhookKey.kid, () => client)).found).toBe(true);
    t += 61_000;
    // Fetched again, and Plaid still says it expired: no key.
    expect(await keys.get('server', plaid.webhookKey.kid, () => client)).toEqual({
      found: false,
      reason: 'unknown_key',
    });
    expect(keyFetches()).toBe(2);
  });

  it('answers unavailable, not unknown, when Plaid can’t be reached', async () => {
    plaid.failNext('/webhook_verification_key/get', {
      error_type: 'API_ERROR',
      error_code: 'INTERNAL_SERVER_ERROR',
    });
    const keys = new PlaidWebhookKeys();
    expect(await keys.get('server', plaid.webhookKey.kid, () => client)).toEqual({
      found: false,
      reason: 'unavailable',
    });
    expect((await keys.get('server', plaid.webhookKey.kid, () => client)).found).toBe(true);
  });

  it('signs as Plaid does, with the helper the api tests use', () => {
    const token = signPlaidWebhook(BODY, plaid.webhookKey);
    const read = readPlaidWebhookToken(token, Buffer.from(BODY), now());
    expect(read.ok).toBe(true);
  });
});

describe('verifyPlaidWebhookToken: jose checks it all again, past the quick refusal', () => {
  const keyFor = async () => {
    const read = readPlaidWebhookToken(
      plaid.signWebhook(BODY).headers['plaid-verification'],
      Buffer.from(BODY),
      now(),
    );
    if (!read.ok) throw new Error(read.reason);
    const key = await new PlaidWebhookKeys().get('server', read.token.kid, () => client);
    if (!key.found) throw new Error(key.reason);
    return key.key;
  };
  const token = (jwt: string) => ({ jwt, kid: plaid.webhookKey.kid });

  it('allows ES256 only, whatever the header says', async () => {
    const key = await keyFor();
    const real = plaid.signWebhook(BODY).headers['plaid-verification']!;
    const [, p, s] = real.split('.') as [string, string, string];
    const hs = `${part({ alg: 'HS256', kid: plaid.webhookKey.kid })}.${p}.${s}`;
    expect(await verifyPlaidWebhookToken(token(hs), key, Buffer.from(BODY), now())).toEqual({
      ok: false,
      reason: 'algorithm',
    });
    const none = `${part({ alg: 'none', kid: plaid.webhookKey.kid })}.${p}.`;
    expect((await verifyPlaidWebhookToken(token(none), key, Buffer.from(BODY), now())).ok).toBe(
      false,
    );
  });

  it('refuses a stale iat, and a body the verified payload doesn’t hash to', async () => {
    const key = await keyFor();
    const old = plaid.signWebhook(BODY, { iat: Math.floor(now() / 1000) - 6 * 60 });
    expect(
      await verifyPlaidWebhookToken(
        token(old.headers['plaid-verification']!),
        key,
        Buffer.from(BODY),
        now(),
      ),
    ).toEqual({ ok: false, reason: 'stale' });
    const fresh = plaid.signWebhook(BODY).headers['plaid-verification']!;
    expect(
      await verifyPlaidWebhookToken(token(fresh), key, Buffer.from(`${BODY} `), now()),
    ).toEqual({ ok: false, reason: 'body_hash' });
    expect(await verifyPlaidWebhookToken(token(fresh), key, Buffer.from(BODY), now())).toEqual({
      ok: true,
    });
  });
});

describe('what a webhook asks for (WEBHOOK-005, WEBHOOK-006)', () => {
  it('queues a sync for new data, a check for Item changes, and ignores the rest', () => {
    const action = (webhook_type: string, webhook_code: string) =>
      plaidWebhookAction({ webhook_type, webhook_code });
    expect(action('TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE')).toBe('sync');
    expect(action('LIABILITIES', 'DEFAULT_UPDATE')).toBe('sync');
    for (const code of [
      'ERROR',
      'LOGIN_REPAIRED',
      'PENDING_DISCONNECT',
      'PENDING_EXPIRATION',
      'USER_PERMISSION_REVOKED',
      'NEW_ACCOUNTS_AVAILABLE',
    ]) {
      expect(action('ITEM', code)).toBe('check');
    }
    expect(action('ITEM', 'WEBHOOK_UPDATE_ACKNOWLEDGED')).toBe('acknowledged');
    expect(action('TRANSACTIONS', 'DEFAULT_UPDATE')).toBe('ignore');
    expect(action('HOLDINGS', 'DEFAULT_UPDATE')).toBe('ignore');
    expect(action('constructor', 'toString')).toBe('ignore');
  });
});

describe('PLAID_WEBHOOK_URL (#84)', () => {
  it('is the public base URL with the receiver’s path added; unset, webhooks are off', () => {
    expect(plaidWebhookUrl({})).toBeUndefined();
    expect(plaidWebhookUrl({ PLAID_WEBHOOK_URL: 'https://fiscus.example' })).toBe(
      `https://fiscus.example${PLAID_WEBHOOK_PATH}`,
    );
    expect(plaidWebhookUrl({ PLAID_WEBHOOK_URL: 'https://example.org/fiscus/' })).toBe(
      `https://example.org/fiscus${PLAID_WEBHOOK_PATH}`,
    );
  });
});

function readHash(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
    request_body_sha256: string;
  };
  return payload.request_body_sha256;
}
