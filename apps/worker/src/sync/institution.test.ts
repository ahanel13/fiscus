// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { AggregationProvider, ProviderInstitution } from '@fiscus/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';
import { INSTITUTION_REFRESH_MS, refreshInstitution } from './institution.js';

/** A connection's bank kept as its provider shows it (#423): asked again once a month. */
describe('refreshInstitution', { timeout: 60_000 }, () => {
  let h: WorkerHarness;
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 300_000);
  afterAll(() => h?.close(), 60_000);

  /** A connection to a bank Fiscus stored with no logo, last checked `checkedAgo` ms ago. */
  async function bankConnection(checkedAgo: number | null) {
    const institutionId = randomUUID();
    await h.owner.query(
      `INSERT INTO institutions (id, provider, provider_institution_id, name, display_checked_at)
       VALUES ($1, 'plaid', $2, 'Harbor CU', $3)`,
      [
        institutionId,
        `ins_${institutionId}`,
        checkedAgo === null ? null : new Date(Date.now() - checkedAgo),
      ],
    );
    const connectionId = await h.connection({ provider: 'plaid', next: null });
    await h.owner.query('UPDATE connections SET institution_id = $1 WHERE id = $2', [
      institutionId,
      connectionId,
    ]);
    return { institutionId, connectionId };
  }
  const provider = (shown: () => Promise<ProviderInstitution>) =>
    ({ institution: shown }) as unknown as AggregationProvider;
  const row = async (id: string) =>
    (await h.owner.query('SELECT * FROM institutions WHERE id = $1', [id])).rows[0];

  it('fills in a bank never checked: its name, logo and color', async () => {
    const { institutionId, connectionId } = await bankConnection(null);
    const out = await refreshInstitution(
      { db: h.worker.db, householdId: h.householdId, connectionId },
      provider(async () => ({ name: 'Harbor Credit Union', logoPng: PNG, color: '#1f4e79' })),
    );
    expect(out).toBe('refreshed');
    const bank = await row(institutionId);
    expect(bank.name).toBe('Harbor Credit Union');
    expect(bank.color).toBe('#1f4e79');
    expect(Buffer.from(bank.logo_png).equals(Buffer.from(PNG))).toBe(true);
    expect(bank.display_checked_at).toBeInstanceOf(Date);
  });

  it('leaves a bank checked this month alone, and asks again after a month', async () => {
    const fresh = await bankConnection(INSTITUTION_REFRESH_MS / 2);
    let asked = 0;
    const counting = provider(async () => {
      asked++;
      return { name: 'Harbor Credit Union' };
    });
    const job = { db: h.worker.db, householdId: h.householdId };
    expect(await refreshInstitution({ ...job, connectionId: fresh.connectionId }, counting)).toBe(
      'fresh',
    );
    const stale = await bankConnection(INSTITUTION_REFRESH_MS + 60_000);
    expect(await refreshInstitution({ ...job, connectionId: stale.connectionId }, counting)).toBe(
      'refreshed',
    );
    expect(asked).toBe(1);
  });

  it('changes nothing when the provider fails or has no display data', async () => {
    const { institutionId, connectionId } = await bankConnection(null);
    const job = { db: h.worker.db, householdId: h.householdId, connectionId };
    expect(
      await refreshInstitution(
        job,
        provider(async () => {
          throw new Error('Plaid is down');
        }),
      ),
    ).toBe('skipped');
    expect(await refreshInstitution(job, {} as AggregationProvider)).toBe('skipped');
    expect((await row(institutionId)).display_checked_at).toBeNull();
  });
});
