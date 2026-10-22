// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineEnv, loadEnv, redactEnv } from '@fiscus/env';
import { describe, expect, it } from 'vitest';
import {
  instancePlaidConfig,
  plaidBaseUrl,
  PlaidConfigError,
  plaidEnvVars,
  plaidStatus,
} from './config.js';

const def = defineEnv('test', plaidEnvVars);
const load = (source: Record<string, string>, files: Record<string, string> = {}) =>
  loadEnv(def, {
    source,
    readFile: (path) => {
      const value = files[path];
      if (value === undefined) throw new Error('ENOENT');
      return value;
    },
  });

const KEYS = {
  PLAID_CLIENT_ID: 'client-id-canary',
  PLAID_SECRET: 'secret-canary-31337',
  PLAID_ENV: 'sandbox',
};

describe('the Plaid keys in the env (#82)', () => {
  it('leaves Plaid unavailable when none are set', () => {
    const warnings: string[] = [];
    expect(instancePlaidConfig(load({}), (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(plaidStatus(undefined)).toBe('Plaid: not configured');
  });

  it('loads all three, each also from a file', () => {
    const env = load(
      {
        PLAID_CLIENT_ID: KEYS.PLAID_CLIENT_ID,
        PLAID_SECRET_FILE: '/run/secrets/plaid',
        PLAID_ENV_FILE: '/e',
      },
      { '/run/secrets/plaid': `${KEYS.PLAID_SECRET}\n`, '/e': 'production' },
    );
    const config = instancePlaidConfig(env);
    expect(config).toEqual({
      clientId: KEYS.PLAID_CLIENT_ID,
      secret: KEYS.PLAID_SECRET,
      env: 'production',
    });
    expect(plaidStatus(config)).toBe('Plaid: configured (production)');
    expect(plaidStatus(instancePlaidConfig(load(KEYS)))).toBe('Plaid: configured (sandbox)');
  });

  it('redacts the secret, and only the secret', () => {
    const redacted = redactEnv(def, load(KEYS));
    expect(redacted).toMatchObject({
      PLAID_SECRET: '[redacted]',
      PLAID_CLIENT_ID: KEYS.PLAID_CLIENT_ID,
      PLAID_ENV: 'sandbox',
    });
    expect(JSON.stringify(redacted)).not.toContain(KEYS.PLAID_SECRET);
  });

  it.each([
    [['PLAID_CLIENT_ID'], ['PLAID_SECRET, PLAID_ENV']],
    [['PLAID_SECRET'], ['PLAID_CLIENT_ID, PLAID_ENV']],
    [['PLAID_CLIENT_ID', 'PLAID_ENV'], ['PLAID_SECRET']],
  ] as const)('refuses only %j, naming the missing ones and no values', (set, missing) => {
    const source = Object.fromEntries(set.map((name) => [name, KEYS[name]]));
    const run = () => instancePlaidConfig(load(source));
    expect(run).toThrow(PlaidConfigError);
    expect(run).toThrow(`Missing: ${missing.join(', ')}.`);
    try {
      run();
    } catch (err) {
      for (const value of Object.values(KEYS)) expect(String(err)).not.toContain(value);
    }
  });

  it('accepts only sandbox and production, and an https redirect', () => {
    expect(() => load({ ...KEYS, PLAID_ENV: 'development' })).toThrow(/PLAID_ENV/);
    expect(() => load({ ...KEYS, PLAID_REDIRECT_URI: 'http://fiscus.example/plaid' })).toThrow(
      /PLAID_REDIRECT_URI: must be an https URL/,
    );
    const config = instancePlaidConfig(
      load({ ...KEYS, PLAID_REDIRECT_URI: 'https://fiscus.example/connect/plaid/oauth' }),
    );
    expect(config?.redirectUri).toBe('https://fiscus.example/connect/plaid/oauth');
    // The web app's one return page, exactly: Plaid matches it exactly too.
    for (const other of [
      'https://fiscus.example/plaid/oauth',
      'https://fiscus.example/connect/plaid/oauth?x=1',
      'https://fiscus.example/connect/plaid/oauth#x',
    ]) {
      expect(() => load({ ...KEYS, PLAID_REDIRECT_URI: other })).toThrow(/connect\/plaid\/oauth/);
    }
  });

  describe('the test-only base URL', () => {
    const override = 'http://127.0.0.1:4010';

    it('is kept in sandbox', () => {
      const config = instancePlaidConfig(load({ ...KEYS, PLAID_API_BASE_URL: override }));
      expect(config?.apiBaseUrl).toBe(override);
      expect(plaidBaseUrl('sandbox', `${override}/`)).toBe(override);
      expect(plaidBaseUrl('sandbox')).toBe('https://sandbox.plaid.com');
    });

    it('is ignored in production, with a warning', () => {
      const warnings: string[] = [];
      const config = instancePlaidConfig(
        load({ ...KEYS, PLAID_ENV: 'production', PLAID_API_BASE_URL: override }),
        (m) => warnings.push(m),
      );
      expect(config).not.toHaveProperty('apiBaseUrl');
      expect(warnings).toEqual([
        'PLAID_API_BASE_URL is ignored: it applies only when PLAID_ENV=sandbox.',
      ]);
      expect(plaidBaseUrl('production', override)).toBe('https://production.plaid.com');
    });
  });
});
