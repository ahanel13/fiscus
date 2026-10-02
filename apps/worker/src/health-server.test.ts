import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startHealthServer } from './health-server.js';

describe('worker health server', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function get(dbReady: boolean, path: string) {
    const server = startHealthServer(0, async () => dbReady);
    close = () => server.close();
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: res.status === 404 ? null : await res.json() };
  }

  it('serves liveness regardless of dependencies', async () => {
    expect(await get(false, '/healthz')).toEqual({
      status: 200,
      body: { status: 'ok', service: 'worker' },
    });
  });

  it('reports readiness from the database check', async () => {
    expect((await get(true, '/readyz')).status).toBe(200);
    expect(await get(false, '/readyz')).toEqual({
      status: 503,
      body: { status: 'degraded', service: 'worker', checks: { database: 'failing' } },
    });
  });

  it('404s unknown paths', async () => {
    expect((await get(true, '/nope')).status).toBe(404);
  });
});
