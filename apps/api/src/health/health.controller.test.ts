import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../testing/test-app.js';

describe('health endpoints', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let unreachable: NestFastifyApplication;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl);
    // Starts even though the database is down (readiness reports it instead).
    unreachable = await createTestApp('postgres://fiscus_app:x@127.0.0.1:1/fiscus');
  }, 120_000);

  afterAll(async () => {
    await Promise.all([app?.close(), unreachable?.close()]);
    await tdb?.stop();
  });

  it('GET /healthz reports ok without checking dependencies, even with a session cookie', async () => {
    const res = await unreachable.inject({
      method: 'GET',
      url: '/healthz',
      headers: { cookie: '__Host-fiscus_session=whatever' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'api' });
  });

  it('GET /readyz is 200 when the database is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'api', checks: { database: 'ok' } });
  });

  it('GET /readyz is 503 when the database is not', async () => {
    const res = await unreachable.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'degraded',
      service: 'api',
      checks: { database: 'failing' },
    });
  });
});
