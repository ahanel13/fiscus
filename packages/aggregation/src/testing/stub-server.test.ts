// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { jsonBody, startStubServer, type StubServer } from './stub-server.js';

let server: StubServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('startStubServer', () => {
  it('answers from routes on a local port and records requests', async () => {
    server = await startStubServer({
      'POST /transactions/sync': (request) => ({
        body: { cursor: jsonBody<{ cursor: string }>(request).cursor, has_more: false },
      }),
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${server.url}/transactions/sync?env=sandbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'plaid-version': '2020-09-14' },
      body: JSON.stringify({ cursor: 'abc' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ cursor: 'abc', has_more: false });

    const [request] = server.requests;
    expect(request).toMatchObject({ method: 'POST', path: '/transactions/sync' });
    expect(request!.query.get('env')).toBe('sandbox');
    expect(request!.headers['plaid-version']).toBe('2020-09-14');
  });

  it('replaces handlers, sends text as is, and 404s unknown routes', async () => {
    server = await startStubServer();
    server.route('GET /accounts', () => ({ status: 403, body: 'Forbidden' }));
    const forbidden = await fetch(`${server.url}/accounts`);
    expect([forbidden.status, await forbidden.text()]).toEqual([403, 'Forbidden']);

    server.route('GET /accounts', async () => ({
      headers: { 'retry-after': '30' },
      body: { accounts: [] },
    }));
    const ok = await fetch(`${server.url}/accounts`);
    expect(ok.headers.get('retry-after')).toBe('30');
    expect(await ok.json()).toEqual({ accounts: [] });

    expect((await fetch(`${server.url}/nowhere`)).status).toBe(404);
    expect(server.requests.map((r) => r.path)).toEqual(['/accounts', '/accounts', '/nowhere']);
  });

  it('turns a throwing handler into a 500', async () => {
    server = await startStubServer({
      'GET /boom': () => {
        throw new Error('scripted failure');
      },
    });
    expect((await fetch(`${server.url}/boom`)).status).toBe(500);
  });

  it('listens where it’s told, as the e2e stack’s plaid-stub service does', async () => {
    const free = await startStubServer();
    const port = Number(new URL(free.url).port);
    await free.close();
    server = await startStubServer(
      { 'GET /up': () => ({ body: 'up' }) },
      { host: '0.0.0.0', port },
    );
    expect(server.url).toBe(`http://127.0.0.1:${port}`);
    expect(await (await fetch(`${server.url}/up`)).text()).toBe('up');
  });
});
