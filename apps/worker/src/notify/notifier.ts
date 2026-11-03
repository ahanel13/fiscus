// SPDX-License-Identifier: AGPL-3.0-or-later
import { DecryptionError, type FieldCrypto } from '@fiscus/crypto';
import {
  type Database,
  decryptChannelSecret,
  householdMembers,
  notificationChannels,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  systemContext,
  users,
  withContext,
} from '@fiscus/db';
import { describeError } from '@fiscus/env';
import {
  ChannelError,
  type EmailChannel,
  type GotifyChannel,
  type NtfyChannel,
  renderMessage,
  type WebhookChannel,
} from '@fiscus/notify';
import {
  type DetailLevel,
  type ExternalChannelKind,
  NOTIFICATION_KINDS,
  type NotificationChannelKind,
  type NotificationKind,
  type NotificationRowKind,
  ruleChannels,
} from '@fiscus/shared';
import { Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

// Delivering notifications (#125, #126, #130). Whatever writes a notification (the api, or a
// worker job such as a connection needing its owner) only writes it into the outbox. Each pass
// here then:
// 1. routes new ones: to the bell, and to each channel the recipient chose for its kind and has
//    set up, one delivery per channel;
// 2. sends the deliveries that are due, leased so two workers never send one at once, and records
//    how each went: sent, or a code, retried with backoff until it gives up.
// A sent delivery is never sent again, and a notification is written once per occurrence and
// rule (its dedupe key), so a restart sends nothing twice, short of one cut off mid-send.

export interface NotifierChannels {
  /** Null when the server has no mail settings (SMTP_URL, MAIL_FROM). */
  email: EmailChannel | null;
  ntfy: NtfyChannel;
  gotify: GotifyChannel;
  webhook: WebhookChannel;
}

export interface NotifierOptions {
  pollMs: number;
  /** Notifications routed, and deliveries sent, per pass. */
  batch: number;
  /** How long a claim holds a delivery: longer than a send can take. */
  leaseMs: number;
  /** After the 1st, 2nd, … failure; one more failure than there are steps gives up. */
  backoffMs: number[];
  /** The server's address, for absolute links (PUBLIC_URL). */
  publicUrl: string | null;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const MINUTE = 60_000;

export const DEFAULT_NOTIFIER_OPTIONS: NotifierOptions = {
  pollMs: 5_000,
  batch: 20,
  leaseMs: 2 * MINUTE,
  // 1 and 5 minutes, half an hour, 2 and 6 hours: then it's given up, a little over 8 hours on.
  backoffMs: [1, 5, 30, 120, 360].map((m) => m * MINUTE),
  publicUrl: null,
};

export interface NotifierDeps {
  db: Database;
  crypto: FieldCrypto;
  channels: NotifierChannels;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

const isRuleKind = (kind: string): kind is NotificationKind =>
  (NOTIFICATION_KINDS as string[]).includes(kind);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

/** The outcome of one delivery attempt, as recorded. */
export type DeliveryOutcome =
  | { status: 'sent' }
  | { status: 'pending'; code: string; retryInMs: number }
  | { status: 'failed'; code: string };

export class Notifier {
  readonly #deps: NotifierDeps;
  readonly #options: NotifierOptions;
  readonly #logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  readonly #abort = new AbortController();
  #loop: Promise<void> | undefined;

  constructor(deps: NotifierDeps, options: Partial<NotifierOptions> = {}) {
    this.#deps = deps;
    this.#options = { ...DEFAULT_NOTIFIER_OPTIONS, ...options };
    this.#logger = deps.logger ?? new Logger('Notifier');
  }

  start(): void {
    if (this.#loop || this.#abort.signal.aborted) return;
    const wait = this.#options.sleep ?? sleep;
    this.#loop = (async () => {
      while (!this.#abort.signal.aborted) {
        try {
          await this.pass();
        } catch (error) {
          this.#logger.error(`Notification pass failed: ${describeError(error)}`);
        }
        if (!this.#abort.signal.aborted) await wait(this.#options.pollMs, this.#abort.signal);
      }
    })();
  }

  /** Stops after the current pass; a delivery cut off is sent again once its lease runs out. */
  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
  }

  /** Routes what's new, then sends what's due. One failing never stops the others. */
  async pass(): Promise<void> {
    const { db } = this.#deps;
    const { rows: unrouted } = await db.execute<{ notification_id: string; household_id: string }>(
      sql`SELECT notification_id, household_id FROM fiscus_unrouted_notifications(${this.#options.batch})`,
    );
    for (const r of unrouted) {
      try {
        await this.route(r.household_id, r.notification_id);
      } catch (error) {
        this.#logger.error(`Routing ${r.notification_id} failed: ${describeError(error)}`);
      }
    }
    const lease = `${Math.round(this.#options.leaseMs)} milliseconds`;
    const { rows: due } = await db.execute<{ delivery_id: string; household_id: string }>(
      sql`SELECT delivery_id, household_id
          FROM fiscus_claim_notification_deliveries(${this.#options.batch}, ${lease}::interval)`,
    );
    await Promise.all(
      due.map(async (d) => {
        try {
          await this.deliver(d.household_id, d.delivery_id);
        } catch (error) {
          // The lease runs out, and it's tried again then.
          this.#logger.error(`Delivery ${d.delivery_id} failed: ${describeError(error)}`);
        }
      }),
    );
  }

  /**
   * A notification's deliveries: the channels its recipient ticked for its kind (or D18's
   * defaults), that are set up and available here. In Fiscus shows it in the bell. A test goes to
   * its channel only, set up or not, so its result says what's wrong. A recipient who has left
   * the household gets nothing.
   */
  async route(householdId: string, notificationId: string): Promise<void> {
    const { db, channels: available } = this.#deps;
    await withContext(db, systemContext(householdId), async (tx) => {
      const [n] = await tx
        .select({
          memberId: notifications.memberId,
          kind: notifications.kind,
          testChannel: notifications.testChannel,
          routedAt: notifications.routedAt,
          leftAt: householdMembers.leftAt,
        })
        .from(notifications)
        .innerJoin(householdMembers, eq(householdMembers.id, notifications.memberId))
        .where(eq(notifications.id, notificationId))
        .for('update', { of: notifications });
      if (!n || n.routedAt) return;

      let chosen: NotificationChannelKind[] = [];
      if (n.leftAt) {
        // Nothing: they've left.
      } else if (n.kind === 'test') {
        chosen = [n.testChannel as ExternalChannelKind];
      } else {
        const setUp = (
          await tx
            .select({ kind: notificationChannels.kind, secret: notificationChannels.secretEnc })
            .from(notificationChannels)
            .where(eq(notificationChannels.memberId, n.memberId))
        )
          .filter((c) => c.kind === 'email' || c.secret !== null)
          .map((c) => c.kind as ExternalChannelKind);
        const [pref] = isRuleKind(n.kind)
          ? await tx
              .select({ channels: notificationPreferences.channels })
              .from(notificationPreferences)
              .where(
                and(
                  eq(notificationPreferences.memberId, n.memberId),
                  eq(notificationPreferences.kind, n.kind),
                ),
              )
          : [];
        const ticked = isRuleKind(n.kind)
          ? ruleChannels(n.kind, pref?.channels as NotificationChannelKind[] | null, setUp)
          : (['in_app'] as NotificationChannelKind[]);
        chosen = ticked.filter(
          (c) =>
            c === 'in_app' ||
            (c === 'email' ? available.email !== null : (setUp as string[]).includes(c)),
        );
      }

      const external = chosen.filter((c): c is ExternalChannelKind => c !== 'in_app');
      if (external.length) {
        await tx
          .insert(notificationDeliveries)
          .values(external.map((channel) => ({ householdId, notificationId, channel })))
          .onConflictDoNothing();
      }
      await tx
        .update(notifications)
        .set({ routedAt: new Date(), inApp: chosen.includes('in_app') })
        .where(eq(notifications.id, notificationId));
    });
  }

  /** Sends one claimed delivery, and records how it went. */
  async deliver(householdId: string, deliveryId: string): Promise<DeliveryOutcome | null> {
    const { db } = this.#deps;
    const target = await withContext(db, systemContext(householdId), async (tx) => {
      const [d] = await tx
        .select({
          channel: notificationDeliveries.channel,
          status: notificationDeliveries.status,
          attempts: notificationDeliveries.attempts,
          id: notifications.id,
          memberId: notifications.memberId,
          kind: notifications.kind,
          title: notifications.title,
          body: notifications.body,
          summary: notifications.summary,
          link: notifications.link,
          createdAt: notifications.createdAt,
          email: users.email,
        })
        .from(notificationDeliveries)
        .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
        .innerJoin(householdMembers, eq(householdMembers.id, notifications.memberId))
        .leftJoin(users, eq(users.id, householdMembers.userId))
        .where(eq(notificationDeliveries.id, deliveryId));
      if (!d || d.status !== 'pending') return null;
      const [channel] = await tx
        .select()
        .from(notificationChannels)
        .where(
          and(
            eq(notificationChannels.memberId, d.memberId),
            eq(notificationChannels.kind, d.channel),
          ),
        );
      return { ...d, config: channel ?? null };
    });
    if (!target) return null;

    let outcome: DeliveryOutcome;
    try {
      const detail = (target.config?.detail ?? 'full') as DetailLevel;
      const message = renderMessage(
        { ...target, kind: target.kind as NotificationRowKind },
        detail,
        this.#options.publicUrl,
        `/h/${householdId}/settings/notifications`,
      );
      await this.#send(householdId, target.channel as ExternalChannelKind, target, message);
      outcome = { status: 'sent' };
    } catch (error) {
      const failure =
        error instanceof ChannelError
          ? error
          : error instanceof DecryptionError
            ? new ChannelError('secret_unreadable', true)
            : new ChannelError('internal');
      if (!(error instanceof ChannelError)) {
        this.#logger.error(`Delivery ${deliveryId}: ${describeError(error)}`);
      }
      const attempt = target.attempts + 1;
      const step = this.#options.backoffMs[attempt - 1];
      outcome =
        failure.permanent || step === undefined
          ? { status: 'failed', code: failure.code }
          : { status: 'pending', code: failure.code, retryInMs: step };
    }

    await withContext(db, systemContext(householdId), (tx) =>
      tx
        .update(notificationDeliveries)
        .set({
          status: outcome.status,
          attempts: sql`${notificationDeliveries.attempts} + 1`,
          leaseUntil: null,
          lastErrorCode: outcome.status === 'sent' ? null : outcome.code,
          sentAt: outcome.status === 'sent' ? new Date() : null,
          nextAttemptAt:
            outcome.status === 'pending'
              ? sql`now() + ${`${outcome.retryInMs} milliseconds`}::interval`
              : sql`${notificationDeliveries.nextAttemptAt}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(notificationDeliveries.id, deliveryId),
            eq(notificationDeliveries.status, 'pending'),
          ),
        ),
    );
    // Ids and codes only: never what it said, or where it went.
    if (outcome.status === 'sent') this.#logger.log(`${target.channel} ${deliveryId}: sent`);
    else {
      this.#logger.warn(
        `${target.channel} ${deliveryId}: ${outcome.code}${
          outcome.status === 'pending'
            ? `, retry in ${Math.round(outcome.retryInMs / 60_000)} min`
            : ', gave up'
        }`,
      );
    }
    return outcome;
  }

  async #send(
    householdId: string,
    kind: ExternalChannelKind,
    target: {
      email: string | null;
      config: typeof notificationChannels.$inferSelect | null;
    },
    message: Parameters<EmailChannel['send']>[0],
  ): Promise<void> {
    const { channels, crypto } = this.#deps;
    if (kind === 'email') {
      if (!channels.email) throw new ChannelError('email_unavailable', true);
      if (!target.email) throw new ChannelError('no_address', true);
      return channels.email.send(message, { to: target.email });
    }
    const config = target.config;
    if (!config?.secretEnc) throw new ChannelError('not_configured', true);
    const secret = await decryptChannelSecret(crypto, householdId, config.id, config.secretEnc);
    const server = config.settings.server ?? '';
    switch (kind) {
      case 'ntfy':
        return channels.ntfy.send(message, {
          server,
          topic: secret.topic ?? '',
          token: secret.token || undefined,
        });
      case 'gotify':
        return channels.gotify.send(message, { server, token: secret.token ?? '' });
      case 'webhook':
        return channels.webhook.send(message, {
          url: secret.url ?? '',
          secret: secret.secret || undefined,
        });
    }
  }
}
