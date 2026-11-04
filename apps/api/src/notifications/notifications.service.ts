// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { FieldCrypto } from '@fiscus/crypto';
import {
  accounts,
  decryptChannelSecret,
  encryptChannelSecret,
  enqueueNotification,
  type Executor,
  notificationChannels,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  users,
} from '@fiscus/db';
import {
  type ChannelTestStatus,
  EXTERNAL_CHANNELS,
  type ExternalChannelKind,
  type Notification,
  NOTIFICATION_KINDS,
  type NotificationChannelKind,
  type NotificationChannelView,
  type NotificationKind,
  type NotificationList,
  type NotificationRowKind,
  type NotificationSettingsView,
  notificationSettingsSchemas,
  ruleChannels,
  ruleSettings,
  type SetChannel,
  type SetRule,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Problem, problems } from '../common/problem.js';
import { InstanceSettingsService } from '../admin/instance-settings.service.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

// Your notifications (#130) and their settings (bills walkthrough §7, D15–D18; HH-10): only
// yours, whatever your role. Row-level security keeps everyone else's out of reach (migration
// 0079); sending is the worker's. Channel secrets are write-only: encrypted with the household
// key, and shown back only as a hint.

/** The bell's list: the most recent, read or not. */
const RECENT = 50;

type ChannelRow = typeof notificationChannels.$inferSelect;

const hostOf = (url: string) => new URL(url).host;
const topicHint = (topic: string) =>
  `topic ${topic.length > 12 ? `${topic.slice(0, 12)}…` : topic}`;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
    private readonly instance: InstanceSettingsService,
  ) {}

  async list(ctx: HouseholdContext): Promise<NotificationList> {
    return this.scope.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(notifications)
        .where(and(eq(notifications.memberId, ctx.memberId), eq(notifications.inApp, true)))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(RECENT);
      return {
        notifications: rows.map((n): Notification => ({
          id: n.id,
          kind: n.kind as NotificationRowKind,
          title: n.title,
          body: n.body,
          link: n.link,
          createdAt: n.createdAt.toISOString(),
          readAt: n.readAt?.toISOString() ?? null,
        })),
        unread: await this.#unread(tx, ctx),
      };
    });
  }

  unreadCount(ctx: HouseholdContext): Promise<number> {
    return this.scope.run(ctx, (tx) => this.#unread(tx, ctx));
  }

  async #unread(tx: Executor, ctx: HouseholdContext): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.memberId, ctx.memberId),
          eq(notifications.inApp, true),
          isNull(notifications.readAt),
        ),
      );
    return row?.n ?? 0;
  }

  /** Marks one read; someone else's, or none, is not found. */
  async markRead(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [n] = await tx
        .select({ readAt: notifications.readAt })
        .from(notifications)
        .where(and(eq(notifications.id, id), eq(notifications.memberId, ctx.memberId)));
      if (!n) throw problems.notFound();
      if (n.readAt) return;
      await tx.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, id));
      await activity.record({
        action: 'notification.read',
        targetType: 'notification',
        targetId: id,
        visibleToHousehold: false,
      });
    });
  }

  async markAllRead(ctx: HouseholdContext): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      // Nothing to mark is fine, but not from outside the household: row-level security alone
      // would answer that with nothing to mark, as if it had worked.
      const { rows } = await tx.execute<{ ok: boolean }>(sql`SELECT fiscus_context_valid() AS ok`);
      if (!rows[0]?.ok) throw problems.notFound();
      const read = await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.memberId, ctx.memberId), isNull(notifications.readAt)))
        .returning({ id: notifications.id });
      if (read.length === 0) return;
      await activity.record({
        action: 'notification.all_read',
        metadata: { count: read.length },
        visibleToHousehold: false,
      });
    });
  }

  async settings(ctx: HouseholdContext): Promise<NotificationSettingsView> {
    return this.scope.run(ctx, (tx) => this.#settings(tx, ctx));
  }

  async #settings(tx: Executor, ctx: HouseholdContext): Promise<NotificationSettingsView> {
    const channelRows = await tx
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.memberId, ctx.memberId));
    const prefRows = await tx
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.memberId, ctx.memberId));
    const [user] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, ctx.userId));
    // The mail server in use: the environment's, or the Server page's (D16).
    const emailAvailable = !!(await this.instance.effectiveMail()).config;
    const byKind = new Map(channelRows.map((c) => [c.kind, c]));
    const channels = EXTERNAL_CHANNELS.map((kind): NotificationChannelView => {
      const row = byKind.get(kind);
      const settings = row?.settings ?? {};
      if (kind === 'email') {
        return {
          kind,
          configured: emailAvailable && !!user?.email,
          detail: (row?.detail ?? 'full') as NotificationChannelView['detail'],
          server: null,
          hint: user?.email ?? null,
          signed: false,
        };
      }
      return {
        kind,
        configured: !!row?.secretEnc,
        detail: (row?.detail ?? 'full') as NotificationChannelView['detail'],
        server: settings.server ?? null,
        hint: settings.hint ?? null,
        signed: settings.signed ?? false,
      };
    });
    const setUp = channels.filter((c) => c.configured).map((c) => c.kind);
    const prefs = new Map(prefRows.map((p) => [p.kind, p]));
    return {
      emailAvailable,
      channels,
      rules: NOTIFICATION_KINDS.map((kind) => {
        const pref = prefs.get(kind);
        return {
          kind,
          channels: ruleChannels(
            kind,
            pref?.channels as NotificationChannelKind[] | null | undefined,
            setUp,
          ),
          settings: ruleSettings(kind, pref?.settings),
          isDefault: !pref,
        };
      }),
    };
  }

  /**
   * Sets up or changes a channel. Its secrets are encrypted with the household key, bound to the
   * row; one left out on a change stays as it was. Recorded, but only you see it (HH-10).
   */
  async setChannel(
    ctx: HouseholdContext,
    kind: ExternalChannelKind,
    body: SetChannel,
  ): Promise<NotificationSettingsView> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [existing] = await tx
        .select()
        .from(notificationChannels)
        .where(
          and(eq(notificationChannels.memberId, ctx.memberId), eq(notificationChannels.kind, kind)),
        );
      const id = existing?.id ?? randomUUID();
      const before = existing?.secretEnc
        ? await this.#secret(ctx, existing).catch(() => ({}) as Record<string, string>)
        : {};
      let settings: ChannelRow['settings'] = {};
      let secret: Record<string, string> | null = null;
      if (kind === 'ntfy') {
        const b = body as SetChannel<'ntfy'>;
        const topic = b.topic ?? before.topic;
        if (!topic) throw required('topic', 'Enter a topic');
        const token = b.token === undefined ? (before.token ?? '') : b.token;
        secret = { topic, ...(token ? { token } : {}) };
        settings = { server: b.server, hint: topicHint(topic) };
      } else if (kind === 'gotify') {
        const b = body as SetChannel<'gotify'>;
        const token = b.token ?? before.token;
        if (!token) throw required('token', 'Enter the application token');
        secret = { token };
        settings = { server: b.server, hint: hostOf(b.server) };
      } else if (kind === 'webhook') {
        const b = body as SetChannel<'webhook'>;
        const url = b.url ?? before.url;
        if (!url) throw required('url', 'Enter the address to post to');
        const signing = b.secret === undefined ? (before.secret ?? '') : b.secret;
        secret = { url, ...(signing ? { secret: signing } : {}) };
        settings = { hint: hostOf(url), signed: !!signing };
      }
      const secretEnc = secret
        ? await encryptChannelSecret(this.crypto, ctx.householdId, id, secret)
        : null;
      await tx
        .insert(notificationChannels)
        .values({
          id,
          householdId: ctx.householdId,
          memberId: ctx.memberId,
          kind,
          detail: body.detail,
          settings,
          secretEnc,
        })
        .onConflictDoUpdate({
          target: [notificationChannels.memberId, notificationChannels.kind],
          set: { detail: body.detail, settings, secretEnc, updatedAt: new Date() },
        });
      // Which channel, and its detail level: never where it sends, or its secrets.
      await activity.record({
        action: existing ? 'notification_channel.changed' : 'notification_channel.set_up',
        metadata: { kind, detail: body.detail },
        visibleToHousehold: false,
      });
      return this.#settings(tx, ctx);
    });
  }

  /** Turns a channel off and forgets its secrets; email goes back to full detail. */
  async removeChannel(
    ctx: HouseholdContext,
    kind: ExternalChannelKind,
  ): Promise<NotificationSettingsView> {
    return this.scope.run(ctx, async (tx, activity) => {
      const removed = await tx
        .delete(notificationChannels)
        .where(
          and(eq(notificationChannels.memberId, ctx.memberId), eq(notificationChannels.kind, kind)),
        )
        .returning({ id: notificationChannels.id });
      if (removed.length === 0) throw problems.notFound();
      // Ticked rules stop going there; ticking it again after setting it up again is a choice.
      const prefs = await tx
        .select({ kind: notificationPreferences.kind, channels: notificationPreferences.channels })
        .from(notificationPreferences)
        .where(eq(notificationPreferences.memberId, ctx.memberId));
      for (const p of prefs.filter((p) => p.channels?.includes(kind))) {
        await tx
          .update(notificationPreferences)
          .set({ channels: p.channels!.filter((c) => c !== kind), updatedAt: new Date() })
          .where(
            and(
              eq(notificationPreferences.memberId, ctx.memberId),
              eq(notificationPreferences.kind, p.kind),
            ),
          );
      }
      await activity.record({
        action: 'notification_channel.removed',
        metadata: { kind },
        visibleToHousehold: false,
      });
      return this.#settings(tx, ctx);
    });
  }

  /** A test through one channel, for the worker to send; returns its id, to ask how it went. */
  async testChannel(ctx: HouseholdContext, kind: ExternalChannelKind): Promise<string> {
    return this.scope.run(ctx, async (tx, activity) => {
      const id = await enqueueNotification(tx, {
        householdId: ctx.householdId,
        memberId: ctx.memberId,
        kind: 'test',
        dedupeKey: `test:${randomUUID()}`,
        title: 'A test from Fiscus',
        body: 'If you can read this, Fiscus can reach you here. There’s nothing else to do.',
        summary: 'A test from Fiscus.',
        link: `/h/${ctx.householdId}/settings/notifications`,
        testChannel: kind,
      });
      await activity.record({
        action: 'notification_channel.tested',
        targetType: 'notification',
        targetId: id!,
        metadata: { kind },
        visibleToHousehold: false,
      });
      return id!;
    });
  }

  async testStatus(ctx: HouseholdContext, id: string): Promise<ChannelTestStatus> {
    return this.scope.run(ctx, async (tx) => {
      const [n] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.memberId, ctx.memberId),
            eq(notifications.kind, 'test'),
          ),
        );
      if (!n) throw problems.notFound();
      const [d] = await tx
        .select({
          status: notificationDeliveries.status,
          code: notificationDeliveries.lastErrorCode,
        })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.notificationId, id));
      // A failure it'll retry counts as failed here: the test answers now, or not at all.
      if (!d || (d.status === 'pending' && !d.code)) return { status: 'pending', code: null };
      return d.status === 'sent'
        ? { status: 'sent', code: null }
        : { status: 'failed', code: d.code };
    });
  }

  /** What a rule sends, where, and when (D18). Accounts it watches must be ones you see. */
  async setRule(
    ctx: HouseholdContext,
    kind: NotificationKind,
    body: SetRule,
  ): Promise<NotificationSettingsView> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [existing] = await tx
        .select({ settings: notificationPreferences.settings })
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.memberId, ctx.memberId),
            eq(notificationPreferences.kind, kind),
          ),
        );
      const merged = { ...ruleSettings(kind, existing?.settings), ...(body.settings ?? {}) };
      const parsed = notificationSettingsSchemas[kind].safeParse(merged);
      if (!parsed.success) {
        throw new Problem(
          422,
          'validation_failed',
          'Some fields are invalid',
          undefined,
          parsed.error.issues.map((i) => ({
            path: ['settings', ...i.path].join('.'),
            code: i.code,
            message: i.message,
          })),
        );
      }
      const settings = parsed.data as Record<string, unknown>;
      if (kind === 'low_balance') {
        const ids = settings.accountIds as string[];
        if (ids.length) {
          const seen = await tx
            .select({ id: accounts.id })
            .from(accounts)
            .where(inArray(accounts.id, ids));
          if (seen.length !== new Set(ids).size) throw problems.notFound();
        }
      }
      const channels = [...new Set(body.channels)];
      await tx
        .insert(notificationPreferences)
        .values({ householdId: ctx.householdId, memberId: ctx.memberId, kind, channels, settings })
        .onConflictDoUpdate({
          target: [notificationPreferences.memberId, notificationPreferences.kind],
          set: { channels, settings, updatedAt: new Date() },
        });
      await activity.record({
        action: 'notification_rule.changed',
        metadata: { kind, channels },
        visibleToHousehold: false,
      });
      return this.#settings(tx, ctx);
    });
  }

  async #secret(ctx: HouseholdContext, row: ChannelRow): Promise<Record<string, string>> {
    return decryptChannelSecret(this.crypto, ctx.householdId, row.id, row.secretEnc!);
  }
}

const required = (path: string, message: string) =>
  new Problem(422, 'validation_failed', 'Some fields are invalid', undefined, [
    { path, code: 'required', message },
  ]);
