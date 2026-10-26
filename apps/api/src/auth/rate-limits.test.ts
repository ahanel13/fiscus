// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';
import { RateLimiter } from './rate-limiter.js';

/**
 * Rate limits shared across api replicas, and on signup and imports (#377, threat model T1, T9):
 * two api instances on one Valkey count together.
 */
describe('rate limits', () => {
  let tdb: TestDatabase;
  let valkey: StartedTestContainer;
  let one: NestFastifyApplication;
  let two: NestFastifyApplication;
  let alone: NestFastifyApplication;
  let unreachable: NestFastifyApplication;

  const failLogin = (app: NestFastifyApplication, email: string) =>
    new TestClient(app).post('/api/v1/auth/login', { email, password: 'a wrong guess' });
  const signup = (app: NestFastifyApplication, name: string) =>
    new TestClient(app).post('/api/v1/auth/signup', {
      email: `${name}@limits.test`,
      password: 'rate limits Password1!',
      displayName: name,
    });

  beforeAll(async () => {
    [tdb, valkey] = await Promise.all([
      startTestDatabase(),
      new GenericContainer('valkey/valkey:9-alpine').withExposedPorts(6379).start(),
    ]);
    const valkeyUrl = `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`;
    [one, two, alone, unreachable] = await Promise.all([
      createTestApp(tdb.appUrl, { signupMode: 'open', valkeyUrl }),
      createTestApp(tdb.appUrl, { signupMode: 'open', valkeyUrl }),
      createTestApp(tdb.appUrl, { signupMode: 'open' }),
      // Nothing listens on port 1.
      createTestApp(tdb.appUrl, { signupMode: 'open', valkeyUrl: 'redis://127.0.0.1:1' }),
    ]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([one?.close(), two?.close(), alone?.close(), unreachable?.close()]);
    await Promise.all([tdb?.stop(), valkey?.stop()]);
  });

  it('holds a login limit across two api instances, and a success resets it on both', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await failLogin(one, 'shared@limits.test')).status).toBe(401);
      expect((await failLogin(two, 'shared@limits.test')).status).toBe(401);
    }
    const blocked = await failLogin(one, 'shared@limits.test');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(14 * 60);
    expect((await failLogin(two, 'shared@limits.test')).status).toBe(429);

    await one.get(RateLimiter).reset('login:account:shared@limits.test');
    expect((await failLogin(two, 'shared@limits.test')).status).toBe(401);
  });

  it('limits open signup per address, across instances', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await signup(i % 2 ? one : two, `new${i}`)).status).toBe(201);
    }
    const blocked = await signup(one, 'new10');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(59 * 60);
    await one.get(RateLimiter).reset('signup:ip:127.0.0.1');
  });

  it('counts in memory without Valkey, and when Valkey can’t be reached', async () => {
    for (const app of [alone, unreachable]) {
      for (let i = 0; i < 10; i++) {
        expect((await failLogin(app, 'here@limits.test')).status).toBe(401);
      }
      expect((await failLogin(app, 'here@limits.test')).status).toBe(429);
    }
    // Each counted only its own: the shared count saw none of it.
    expect((await failLogin(one, 'here@limits.test')).status).toBe(401);
  });

  it('limits a member’s imports, and not the household’s other members', async () => {
    const ada = new TestClient(one);
    await ada.post('/api/v1/auth/signup', {
      email: 'ada@limits.test',
      password: 'rate limits Password1!',
      displayName: 'Ada',
    });
    const hh = (
      await ada.post('/api/v1/households', {
        name: 'Home',
        baseCurrency: 'USD',
        timezone: 'America/Denver',
      })
    ).body.data.id as string;
    const url = (p: string) => `/api/v1/households/${hh}${p}`;
    const accountId = (await ada.post(url('/accounts'), { name: 'Checking', type: 'depository' }))
      .body.data.id;
    const preview = (c: TestClient, into = accountId) =>
      c.post(url('/imports/preview'), {
        format: 'csv',
        filename: 'bank.csv',
        accounts: [{ key: 'file', accountId: into }],
        transactions: [
          { line: 2, account: 'file', date: '2026-03-01', amountMinor: -450, description: 'X' },
        ],
      });
    expect((await preview(ada)).status).toBe(200);

    // Up to the hour's limit, counted on the other instance.
    const memberId = (await ada.get(url(''))).body.data.you.memberId as string;
    for (let i = 1; i < 120; i++) {
      await two.get(RateLimiter).consume(`import-preview:${memberId}`, 120, 60 * 60_000);
    }
    const blocked = await preview(ada);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    const bea = new TestClient(one);
    await bea.post('/api/v1/auth/signup', {
      email: 'bea@limits.test',
      password: 'rate limits Password1!',
      displayName: 'Bea',
    });
    const invite = await ada.post(url('/invites'), { email: 'bea@limits.test' });
    await bea.post('/api/v1/invites/accept', {
      token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
    });
    const beas = (await bea.post(url('/accounts'), { name: 'Savings', type: 'depository' })).body
      .data.id;
    expect((await preview(bea, beas)).status).toBe(200);
  });
});
