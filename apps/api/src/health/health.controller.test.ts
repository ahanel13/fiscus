import { randomBytes } from 'node:crypto';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';

async function startApp(databaseUrl: string): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        databaseUrl,
        encryptionKey: randomBytes(32).toString('base64'),
        encryptionKeyVersion: 1,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('health endpoints', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let unreachable: NestFastifyApplication;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await startApp(tdb.appUrl);
    unreachable = await startApp('postgres://fiscus_app:x@127.0.0.1:1/fiscus');
  }, 120_000);

  afterAll(async () => {
    await Promise.all([app?.close(), unreachable?.close()]);
    await tdb?.stop();
  });

  it('GET /healthz reports ok without checking dependencies', async () => {
    const res = await unreachable.inject({ method: 'GET', url: '/healthz' });
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
