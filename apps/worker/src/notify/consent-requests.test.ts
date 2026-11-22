// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';
import { ConsentRequestNotices } from './consent-requests.js';

/**
 * Consent requests in the worker (#265, D34): after 14 days without an answer a request expires,
 * recorded as the system's doing; whoever was asked is told once, and whoever asked is told once
 * it's answered or has ended. A withdrawn one tells nobody, and someone who left isn't told.
 */
describe('consent requests (worker)', () => {
  let h: WorkerHarness;
  let ada = '';
  let bea = '';
  let cal = '';

  /** A request from `from` to `to`, made `ago` days back, and ended as `status` when given. */
  const request = async (from: string, to: string, ago = 0, status?: string) =>
    (
      await h.owner.query(
        `INSERT INTO consent_requests (id, household_id, kind, requested_by_member_id, member_id,
           created_at, expires_at, status, closed_at)
         VALUES (gen_random_uuid(), $1, 'income_split', $2, $3, now() - make_interval(days => $4),
           now() - make_interval(days => $4) + interval '14 days',
           coalesce($5, 'pending')::consent_request_status,
           CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [h.householdId, from, to, ago, status ?? null],
      )
    ).rows[0].id as string;
  const notifications = async () =>
    (
      await h.owner.query(
        `SELECT member_id, kind, dedupe_key, title, body, summary, link FROM notifications
         WHERE kind = 'consent_request' ORDER BY dedupe_key`,
      )
    ).rows;
  const notices = () => new ConsentRequestNotices(h.worker.db, h.crypto);

  beforeAll(async () => {
    h = await startWorkerHarness();
    ada = h.memberId;
    await h.owner.query(`UPDATE household_members SET display_name = 'Ada' WHERE id = $1`, [ada]);
    bea = await h.member(h.householdId, 'Bea');
    cal = await h.member(h.householdId, 'Cal');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.owner.query('DELETE FROM notifications');
    await h.owner.query('DELETE FROM consent_requests');
  });

  it('tells whoever was asked, once', async () => {
    const id = await request(ada, bea);
    await notices().pass();
    await notices().pass();
    const rows = await notifications();
    expect(rows).toEqual([
      expect.objectContaining({
        member_id: bea,
        dedupe_key: `consent_request:${id}`,
        title: 'Ada asks you to agree to a split by income',
        summary: 'Someone in your household asks for your agreement.',
        link: `/h/${h.householdId}/settings/shared-costs`,
      }),
    ]);
    // Never an income, and when it ends.
    expect(rows[0].body).toMatch(/never your income\. The request ends on \w+day, \w+ \d+\.$/);
  });

  it('expires one after 14 days, as the system, and tells whoever asked', async () => {
    const id = await request(ada, bea, 15);
    const open = await request(ada, cal, 3);
    await notices().pass();
    const { rows } = await h.owner.query(
      `SELECT id, status, closed_at IS NOT NULL AS closed FROM consent_requests ORDER BY id`,
    );
    expect(new Map(rows.map((r) => [r.id, r.status]))).toEqual(
      new Map([
        [id, 'expired'],
        [open, 'pending'],
      ]),
    );
    const { rows: events } = await h.owner.query(
      `SELECT action, actor_kind, actor_member_id, target_id FROM audit_events
       WHERE action LIKE 'consent_request.%'`,
    );
    expect(events).toEqual([
      {
        action: 'consent_request.expired',
        actor_kind: 'system',
        actor_member_id: null,
        target_id: id,
      },
    ]);
    expect((await notifications()).map((n) => [n.member_id, n.dedupe_key, n.title])).toEqual(
      expect.arrayContaining([
        [ada, `consent_request:${id}:expired`, 'Your request to Bea has ended'],
        [cal, `consent_request:${open}`, 'Ada asks you to agree to a split by income'],
      ]),
    );
    // Bea, who never answered, isn't told again about a request that's over.
    expect((await notifications()).filter((n) => n.member_id === bea)).toEqual([]);
  });

  it('tells whoever asked how it was answered, and nobody about a withdrawn one', async () => {
    const yes = await request(ada, bea, 1, 'accepted');
    const no = await request(bea, cal, 1, 'declined');
    await request(cal, ada, 1, 'withdrawn');
    await notices().pass();
    expect((await notifications()).map((n) => [n.member_id, n.dedupe_key, n.title])).toEqual(
      expect.arrayContaining([
        [ada, `consent_request:${yes}:accepted`, 'Bea agreed to a split by income'],
        [bea, `consent_request:${no}:declined`, 'Cal declined a split by income'],
      ]),
    );
    expect(await notifications()).toHaveLength(2);
  });

  it('doesn’t tell someone who has left', async () => {
    await request(ada, cal);
    await h.owner.query(`UPDATE household_members SET left_at = now() WHERE id = $1`, [cal]);
    try {
      await notices().pass();
      expect(await notifications()).toEqual([]);
    } finally {
      await h.owner.query(`UPDATE household_members SET left_at = NULL WHERE id = $1`, [cal]);
    }
  });
});
