// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, onUnauthenticated, resetCsrf } from './client.js';

type Reply = { status: number; body: unknown };
let replies: Reply[];
let calls: { url: string; init: RequestInit }[];

beforeEach(() => {
  resetCsrf();
  replies = [];
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

const header = (i: number, name: string) =>
  (calls[i]!.init.headers as Record<string, string>)[name];

describe('api client', () => {
  it('fetches a CSRF token before the first unsafe request and sends it', async () => {
    replies = [
      { status: 200, body: { data: { csrfToken: 'tok-1' } } },
      { status: 200, body: { data: { ok: true } } },
    ];
    await api('POST', '/api/v1/x', { body: { a: 1 } });
    expect(calls[0]!.url).toBe('/api/v1/auth/csrf');
    expect(header(1, 'x-csrf-token')).toBe('tok-1');
    expect(calls[1]!.init.credentials).toBe('include');
  });

  it('never sends CSRF tokens on GET', async () => {
    await api('GET', '/api/v1/me');
    expect(calls).toHaveLength(1);
    expect(header(0, 'x-csrf-token')).toBeUndefined();
  });

  it('refreshes the token once on csrf_failed and retries', async () => {
    replies = [
      { status: 200, body: { data: { csrfToken: 'stale' } } },
      { status: 403, body: { code: 'csrf_failed', title: 'x' } },
      { status: 200, body: { data: { csrfToken: 'fresh' } } },
      { status: 200, body: { data: {} } },
    ];
    await api('POST', '/api/v1/x', { body: {} });
    expect(header(3, 'x-csrf-token')).toBe('fresh');
  });

  it('picks up CSRF tokens returned by sign-in', async () => {
    replies = [
      { status: 200, body: { data: { csrfToken: 'pre' } } },
      { status: 200, body: { data: { csrfToken: 'post-login' } } },
      { status: 200, body: {} },
    ];
    await api('POST', '/api/v1/auth/login', { body: {} });
    await api('POST', '/api/v1/auth/logout');
    expect(header(2, 'x-csrf-token')).toBe('post-login');
  });

  it('turns problem documents into ApiError with field errors', async () => {
    replies = [
      {
        status: 422,
        body: {
          code: 'validation_failed',
          title: 'Some fields are invalid',
          errors: [{ path: 'password', code: 'too_small', message: 'Use at least 12 characters' }],
        },
      },
    ];
    const err = await api('GET', '/api/v1/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('validation_failed');
    expect((err as ApiError).fieldError('password')).toBe('Use at least 12 characters');
  });

  it('notifies listeners on 401', async () => {
    const seen = vi.fn();
    const off = onUnauthenticated(seen);
    replies = [{ status: 401, body: { code: 'unauthenticated', title: 'Sign in' } }];
    await api('GET', '/api/v1/me').catch(() => undefined);
    off();
    expect(seen).toHaveBeenCalledOnce();
  });
});
