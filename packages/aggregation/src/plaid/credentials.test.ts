// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { PlaidInstanceConfig } from './config.js';
import { credentialsChanged, credentialStamp, resolvePlaidCredentials } from './credentials.js';

const instance: PlaidInstanceConfig = {
  clientId: 'client-a',
  secret: 'secret-1',
  env: 'production',
};

describe('resolvePlaidCredentials (#82)', () => {
  it("gives a connection without a credential set the server's keys", () => {
    expect(resolvePlaidCredentials(null, instance)).toEqual({
      available: true,
      credentials: { clientId: 'client-a', secret: 'secret-1', env: 'production' },
    });
  });

  it('passes the sandbox-only base URL along', () => {
    const sandbox = { ...instance, env: 'sandbox' as const, apiBaseUrl: 'http://127.0.0.1:1' };
    const result = resolvePlaidCredentials(null, sandbox);
    expect(result.available && result.credentials.apiBaseUrl).toBe('http://127.0.0.1:1');
  });

  it('says Plaid is unavailable without keys', () => {
    expect(resolvePlaidCredentials(null, undefined)).toEqual({
      available: false,
      reason: 'not_configured',
    });
  });

  it("doesn't fall back to the server's keys for a household's own set (#83)", () => {
    expect(resolvePlaidCredentials('set-1', instance)).toEqual({
      available: false,
      reason: 'household_keys_unavailable',
    });
  });
});

describe('credentialsChanged (#82)', () => {
  const stamp = credentialStamp({ clientId: 'client-a', secret: 'secret-1', env: 'production' });

  it('records the client id and environment, never the secret', () => {
    expect(stamp).toEqual({ providerEnv: 'production', providerClientId: 'client-a' });
  });

  it('is unchanged by a rotated secret', () => {
    const rotated = { ...instance, secret: 'secret-2' };
    expect(credentialsChanged(stamp, rotated)).toBe(false);
  });

  it('is changed by another client id or environment', () => {
    expect(credentialsChanged(stamp, { ...instance, clientId: 'client-b' })).toBe(true);
    expect(credentialsChanged(stamp, { ...instance, env: 'sandbox' })).toBe(true);
  });
});
