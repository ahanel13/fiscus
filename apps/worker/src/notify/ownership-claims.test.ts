// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import {
  EmailChannel,
  GotifyChannel,
  type MailTransport,
  NtfyChannel,
  WebhookChannel,
} from '@fiscus/notify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';
import { Notifier } from './notifier.js';
import { openNotice, OwnershipClaimNotices } from './ownership-claims.js';

/**
 * Ownership claims in the worker (#267, D35), against Postgres as fiscus_worker: telling the
 * owners, cancelling a claim when an owner comes back or the claimant can't claim, granting it
 * after 30 days, and telling the people involved how it ended. Each step is in the activity.
 */

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const DAY = 24 * 60 * 60_000;

describe('ownership claims (worker)', { timeout: 60_000 }, () => {
  let h: WorkerHarness;
  let claims: OwnershipClaimNotices;
  const since = () => new Date(Date.now() - 60 * 60_000);

  beforeAll(async () => {
    h = await startWorkerHarness();
    claims = new OwnershipClaimNotices(h.worker.db, h.crypto, {}, quiet);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  /** A household whose owner (Ada) was last here `ownerAwayDays` ago, with a member, Sam. */
  async function household(ownerAwayDays = 40) {
    const { householdId, memberId: ownerId } = await h.household();
    await h.owner.query(`UPDATE household_members SET display_name = 'Ada' WHERE id = $1`, [
      ownerId,
    ]);
    const samId = await h.member(householdId, 'Sam');
    await h.owner.query(
      `UPDATE users SET last_active_at = now() - make_interval(days => $2::int)
       WHERE id = (SELECT user_id FROM household_members WHERE id = $1)`,
      [ownerId, ownerAwayDays],
    );
    return { householdId, ownerId, samId };
  }
  /** Sam's claim, opened `daysAgo` days ago, as the api would have made it (no trigger). */
  async function claim(
    householdId: string,
    claimant: string,
    daysAgo: number,
    status = 'open',
    closedBy: string | null = null,
  ) {
    const id = randomUUID();
    await h.owner.query('SET session_replication_role = replica');
    try {
      await h.owner.query(
        `INSERT INTO ownership_claims (id, household_id, claimant_member_id, status, created_at,
           ends_at, closed_at, closed_by_member_id)
         VALUES ($1, $2, $3, $4::ownership_claim_status,
           now() - make_interval(hours => ($5::float8 * 24)::int),
           now() - make_interval(hours => ($5::float8 * 24)::int) + interval '30 days',
           CASE WHEN $4::text = 'open' THEN NULL ELSE now() END, $6)`,
        [id, householdId, claimant, status, daysAgo, closedBy],
      );
    } finally {
      await h.owner.query('SET session_replication_role = origin');
    }
    return id;
  }
  const notes = async (memberId: string) =>
    (
      await h.owner.query(
        `SELECT kind, dedupe_key, title, link FROM notifications WHERE member_id = $1
         ORDER BY created_at`,
        [memberId],
      )
    ).rows;
  const activity = async (householdId: string) =>
    (
      await h.owner.query(
        `SELECT action, actor_kind, metadata FROM audit_events WHERE household_id = $1 ORDER BY seq`,
        [householdId],
      )
    ).rows;
  const status = async (id: string) =>
    (await h.owner.query('SELECT status, cancel_reason FROM ownership_claims WHERE id = $1', [id]))
      .rows[0];
  const role = async (memberId: string) =>
    (await h.owner.query('SELECT role FROM household_members WHERE id = $1', [memberId])).rows[0]
      .role;

  it('picks the notice an open claim is due', () => {
    const now = new Date('2026-12-01T12:00:00Z');
    const ends = (days: number) => new Date(now.getTime() + days * DAY);
    expect(openNotice(ends(30), now)).toBe('started');
    expect(openNotice(ends(8), now)).toBe('started');
    expect(openNotice(ends(7), now)).toBe('reminder');
    expect(openNotice(ends(1.5), now)).toBe('reminder');
    expect(openNotice(ends(1), now)).toBe('final');
  });

  it('tells every owner once, and records that it did', async () => {
    const { householdId, ownerId, samId } = await household();
    const other = await h.member(householdId, 'Bo', 'owner');
    await h.owner.query(
      `UPDATE users SET last_active_at = now() - interval '35 days'
       WHERE id = (SELECT user_id FROM household_members WHERE id = $1)`,
      [other],
    );
    const id = await claim(householdId, samId, 1);
    expect(await claims.runHousehold(householdId, since())).toBe(2);
    expect(await claims.runHousehold(householdId, since())).toBe(0);
    for (const m of [ownerId, other]) {
      expect(await notes(m)).toEqual([
        {
          kind: 'ownership_claim',
          dedupe_key: `ownership_claim:${id}:started`,
          title: 'Sam asked to become an owner of H',
          link: `/h/${householdId}/settings/members`,
        },
      ]);
    }
    // Sam isn't told about their own claim, and it stays open.
    expect(await notes(samId)).toEqual([]);
    expect(await status(id)).toEqual({ status: 'open', cancel_reason: null });
    expect(await activity(householdId)).toEqual([
      {
        action: 'ownership_claim.notified',
        actor_kind: 'system',
        metadata: { notice: 'started', recipients: 2 },
      },
    ]);
  });

  it('reminds the owners a week before it ends, and the day before', async () => {
    const { householdId, ownerId, samId } = await household();
    const id = await claim(householdId, samId, 24);
    await claims.runHousehold(householdId, since());
    const later = await household();
    const lateId = await claim(later.householdId, later.samId, 29.5);
    await claims.runHousehold(later.householdId, since());
    expect((await notes(ownerId)).map((n) => n.dedupe_key)).toEqual([
      `ownership_claim:${id}:reminder`,
    ]);
    expect((await notes(later.ownerId)).map((n) => [n.dedupe_key, n.title])).toEqual([
      [`ownership_claim:${lateId}:final`, 'Sam becomes an owner of H tomorrow'],
    ]);
  });

  it('ends a claim when an owner comes back, and tells the claimant', async () => {
    const { householdId, ownerId, samId } = await household(0);
    const id = await claim(householdId, samId, 3);
    await claims.runHousehold(householdId, since());
    expect(await status(id)).toEqual({ status: 'cancelled', cancel_reason: 'owner_returned' });
    expect(await role(samId)).toBe('member');
    expect((await notes(samId)).map((n) => n.title)).toEqual(['Your ownership claim has ended']);
    // The owner who came back isn't told about a claim that has ended.
    expect(await notes(ownerId)).toEqual([]);
    expect((await activity(householdId)).map((a) => [a.action, a.metadata])).toEqual([
      ['ownership_claim.cancelled', { claimantMemberId: samId, reason: 'owner_returned' }],
      ['ownership_claim.notified', { notice: 'owner_returned', recipients: 1 }],
    ]);
  });

  it('ends a claim whose claimant left, and tells the owners', async () => {
    const { householdId, ownerId, samId } = await household();
    const id = await claim(householdId, samId, 3);
    await h.owner.query('UPDATE household_members SET left_at = now() WHERE id = $1', [samId]);
    await claims.runHousehold(householdId, since());
    expect(await status(id)).toEqual({ status: 'cancelled', cancel_reason: 'claimant_ineligible' });
    expect((await notes(ownerId)).map((n) => n.title)).toEqual(['Sam’s ownership claim has ended']);
  });

  it('makes the claimant an owner too once 30 days are over, and tells everyone', async () => {
    const { householdId, ownerId, samId } = await household();
    const id = await claim(householdId, samId, 30.1);
    await claims.runHousehold(householdId, since());
    expect(await status(id)).toEqual({ status: 'granted', cancel_reason: null });
    expect(await role(samId)).toBe('owner');
    // Nobody is demoted.
    expect(await role(ownerId)).toBe('owner');
    expect((await notes(samId)).map((n) => n.title)).toEqual(['You’re now an owner of H']);
    expect((await notes(ownerId)).map((n) => n.title)).toEqual(['Sam is now an owner of H too']);
    expect((await activity(householdId)).map((a) => [a.action, a.actor_kind, a.metadata])).toEqual([
      ['ownership_claim.granted', 'system', { claimantMemberId: samId }],
      ['member.role_changed', 'system', { from: 'member', to: 'owner', ownershipClaimId: id }],
      ['ownership_claim.notified', 'system', { notice: 'granted_to_you', recipients: 1 }],
      ['ownership_claim.notified', 'system', { notice: 'granted', recipients: 1 }],
    ]);
    // Once ended, nothing more happens.
    expect(await claims.runHousehold(householdId, since())).toBe(0);
  });

  it('tells the claimant who rejected it, and the owners when it was withdrawn', async () => {
    const a = await household();
    await claim(a.householdId, a.samId, 2, 'rejected', a.ownerId);
    await claims.runHousehold(a.householdId, since());
    expect((await notes(a.samId)).map((n) => n.title)).toEqual([
      'Ada rejected your ownership claim',
    ]);
    const b = await household();
    await claim(b.householdId, b.samId, 2, 'withdrawn', b.samId);
    await claims.runHousehold(b.householdId, since());
    expect((await notes(b.ownerId)).map((n) => n.title)).toEqual([
      'Sam withdrew their ownership claim',
    ]);
  });

  it('finds the households to look at itself', async () => {
    const { householdId, ownerId, samId } = await household();
    await claim(householdId, samId, 1);
    await claims.pass();
    expect((await notes(ownerId)).map((n) => n.title)).toEqual([
      'Sam asked to become an owner of H',
    ]);
  });

  it('sends a claim to every channel, whatever the owner’s rules say', async () => {
    const { householdId, ownerId, samId } = await household();
    await h.owner.query(
      `INSERT INTO notification_preferences (household_id, member_id, kind, channels)
       VALUES ($1, $2, 'ownership_claim', ARRAY[]::text[])`,
      [householdId, ownerId],
    );
    await claim(householdId, samId, 1);
    await claims.runHousehold(householdId, since());
    const transport: MailTransport = { sendMail: async () => {} };
    const fetch = async () => new Response(null, { status: 200 });
    const notifier = new Notifier({
      db: h.worker.db,
      crypto: h.crypto,
      channels: {
        email: new EmailChannel(transport, 'Fiscus <fiscus@worker.test>'),
        ntfy: new NtfyChannel({ fetch }),
        gotify: new GotifyChannel({ fetch }),
        webhook: new WebhookChannel({ fetch }),
      },
      logger: quiet,
    });
    const [n] = (
      await h.owner.query('SELECT id FROM notifications WHERE member_id = $1', [ownerId])
    ).rows;
    await notifier.route(householdId, n.id);
    const { rows } = await h.owner.query(
      `SELECT n.in_app, d.channel FROM notifications n
       LEFT JOIN notification_deliveries d ON d.notification_id = n.id WHERE n.id = $1`,
      [n.id],
    );
    expect(rows).toEqual([{ in_app: true, channel: 'email' }]);
  });
});
