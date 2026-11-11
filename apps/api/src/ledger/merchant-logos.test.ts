// SPDX-License-Identifier: AGPL-3.0-or-later
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Merchants' logos (#423): a transaction offers its logo once the worker has fetched it, and the
 * logo comes from Fiscus's own origin. How sync names and fetches them is the worker's plaid.test.
 */
describe('merchant logos', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  let db: pg.Client;
  let A: TestClient;
  let hh = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    db = new pg.Client({ connectionString: tdb.ownerUrl });
    await db.connect();
    A = new TestClient(app);
    await A.post('/api/v1/auth/signup', {
      email: 'alex@logos.test',
      password: 'merchant logos Password1!',
      displayName: 'Alex',
    });
    hh = (
      await A.post('/api/v1/households', { name: 'Riveras', baseCurrency: 'USD', timezone: 'UTC' })
    ).body.data.id;
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
    await tdb?.stop();
  });

  it('offers a logo once it’s fetched, and serves it from Fiscus itself', async () => {
    const checking = (await A.post(url('/accounts'), { name: 'Checking', type: 'depository' })).body
      .data.id;
    const made = await A.post(url('/transactions'), {
      accountId: checking,
      amountMinor: -450,
      date: '2026-11-02',
      displayName: 'Corner Coffee',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const logo = (
      await db.query(
        `INSERT INTO merchant_logos (id, provider, provider_key, source_url)
         VALUES (gen_random_uuid(), 'plaid', 'ent-corner-coffee', 'https://plaid-merchant-logos.plaid.com/c.png')
         RETURNING id`,
      )
    ).rows[0].id as string;
    await db.query('UPDATE transactions SET merchant_logo_id = $1 WHERE id = $2', [
      logo,
      made.body.data.id,
    ]);
    const listed = async () =>
      (
        (await A.get(url('/transactions'))).body.data as {
          id: string;
          merchantLogoId: string | null;
        }[]
      ).find((t) => t.id === made.body.data.id)!.merchantLogoId;

    // Not fetched yet: no logo to show, and nothing to serve.
    expect(await listed()).toBeNull();
    expect((await A.request('GET', `/api/v1/merchant-logos/${logo}`)).status).toBe(404);

    await db.query(
      `UPDATE merchant_logos SET image = $1, content_type = 'image/png', fetched_at = now() WHERE id = $2`,
      [PNG, logo],
    );
    expect(await listed()).toBe(logo);
    const served = await A.request('GET', `/api/v1/merchant-logos/${logo}`);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.raw.rawPayload.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    expect((await A.request('GET', `/api/v1/merchant-logos/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
    // Only for someone signed in.
    expect(
      (await new TestClient(app).request('GET', `/api/v1/merchant-logos/${logo}`)).status,
    ).toBe(401);
  });

  it('refuses an image that isn’t a small PNG, JPEG or WebP', async () => {
    const insert = (bytes: number, type: string) =>
      db.query(
        `INSERT INTO merchant_logos (id, provider, provider_key, source_url, image, content_type)
         VALUES (gen_random_uuid(), 'plaid', gen_random_uuid()::text, 'https://x.plaid.com/a', $1, $2)`,
        [Buffer.alloc(bytes), type],
      );
    await expect(insert(65_537, 'image/png')).rejects.toThrow(/merchant_logos_image/);
    await expect(insert(10, 'image/svg+xml')).rejects.toThrow(/merchant_logos_image/);
  });
});
