// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, id, timestamps } from '../columns.js';
import { householdMembers } from './households.js';

// Notifications (bills walkthrough §7, D15–D20; #125, #126, #130). Everything here is one
// member's own: only they read or change it, and the worker reads it to deliver (row-level
// security: migration 0079). The kinds, their settings and defaults are in @fiscus/shared
// (api/notifications.ts).

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const NOTIFICATION_CHANNEL_KINDS = ['email', 'ntfy', 'gotify', 'webhook'] as const;
export const NOTIFICATION_DETAIL_LEVELS = ['full', 'summary', 'minimal'] as const;
export const NOTIFICATION_DELIVERY_STATUSES = ['pending', 'sent', 'failed'] as const;
/** Every channel a rule can tick, In Fiscus included. */
const RULE_CHANNELS = ['in_app', ...NOTIFICATION_CHANNEL_KINDS] as const;
const KIND = '^[a-z][a-z_]{0,39}$';

/**
 * Where a member's notifications go outside Fiscus, at most one of each kind (D16). Its secrets
 * (an ntfy topic and token, a Gotify token, a webhook's address and signing secret) are in
 * `secret_enc`, encrypted with the household key and bound to the row; `settings` holds only what
 * Settings shows: a server's address and a hint. Email needs no row until its detail changes: it
 * goes to the member's sign-in address.
 */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: id(),
    householdId: uuid().notNull(),
    memberId: uuid().notNull(),
    kind: text().notNull(),
    detail: text().notNull().default('full'),
    settings: jsonb()
      .$type<{ server?: string; hint?: string; signed?: boolean }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    secretEnc: bytea('secret_enc'),
    ...timestamps(),
  },
  (t) => [
    unique('notification_channels_member_kind').on(t.memberId, t.kind),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    index().on(t.householdId),
    check('notification_channels_kind', sql`${t.kind} IN (${inList(NOTIFICATION_CHANNEL_KINDS)})`),
    check(
      'notification_channels_detail',
      sql`${t.detail} IN (${inList(NOTIFICATION_DETAIL_LEVELS)})`,
    ),
  ],
);

/**
 * A member's choice for one kind of notification (D18): the channels ticked, and its timing.
 * No row: D18's defaults. `channels` null: the default channels, with any push channel set up.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    householdId: uuid().notNull(),
    memberId: uuid().notNull(),
    kind: text().notNull(),
    channels: text().array(),
    settings: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.kind] }),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    index().on(t.householdId),
    check('notification_preferences_kind', sql`${t.kind} ~ ${sql.raw(`'${KIND}'`)}`),
    check(
      'notification_preferences_channels',
      sql`${t.channels} IS NULL OR ${t.channels} <@ ARRAY[${inList(RULE_CHANNELS)}]::text[]`,
    ),
  ],
);

/**
 * One notification for one member: the outbox the api or the worker writes into, and what the
 * bell lists (#130). `dedupe_key` makes it once per occurrence and rule, even across restarts
 * (D20): writing it again does nothing. The worker routes it (`routed_at`) to the member's
 * channels as `notification_deliveries`, and shows it in the bell (`in_app`) if they chose to.
 * A test (`kind` 'test') goes to `test_channel` only.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    householdId: uuid().notNull(),
    memberId: uuid().notNull(),
    kind: text().notNull(),
    dedupeKey: text().notNull(),
    /** Full detail (D17). */
    title: text().notNull(),
    body: text().notNull(),
    /** Summary detail: no amounts, names or places. */
    summary: text().notNull(),
    /** Where it's about, as an app path. */
    link: text(),
    testChannel: text(),
    inApp: boolean().notNull().default(false),
    routedAt: timestamp({ withTimezone: true }),
    readAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('notifications_household_id_id').on(t.householdId, t.id),
    unique('notifications_dedupe').on(t.memberId, t.dedupeKey),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    index('notifications_member_recent').on(t.memberId, t.createdAt),
    index('notifications_unrouted')
      .on(t.createdAt)
      .where(sql`${t.routedAt} IS NULL`),
    index().on(t.householdId),
    check('notifications_kind', sql`${t.kind} ~ ${sql.raw(`'${KIND}'`)}`),
    check('notifications_dedupe_key', sql`length(${t.dedupeKey}) BETWEEN 1 AND 200`),
    check('notifications_title', sql`length(${t.title}) BETWEEN 1 AND 200`),
    check('notifications_body', sql`length(${t.body}) <= 2000`),
    check('notifications_summary', sql`length(${t.summary}) BETWEEN 1 AND 500`),
    check('notifications_link', sql`${t.link} IS NULL OR ${t.link} ~ '^/[^/]'`),
    check(
      'notifications_test_channel',
      sql`(${t.kind} = 'test') = (${t.testChannel} IS NOT NULL) AND (${t.testChannel} IS NULL OR ${t.testChannel} IN (${inList(NOTIFICATION_CHANNEL_KINDS)}))`,
    ),
  ],
);

/**
 * One notification sent through one channel: the worker claims those due, sends them, and backs
 * off and retries a failure until it gives up. Sent once: a sent delivery is never sent again.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: id(),
    householdId: uuid().notNull(),
    notificationId: uuid().notNull(),
    channel: text().notNull(),
    status: text().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** A worker holds it until then. */
    leaseUntil: timestamp({ withTimezone: true }),
    /** Why the last attempt failed, as a code (`http_401`, `timeout`): never a message. */
    lastErrorCode: text(),
    sentAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('notification_deliveries_channel').on(t.notificationId, t.channel),
    foreignKey({
      columns: [t.householdId, t.notificationId],
      foreignColumns: [notifications.householdId, notifications.id],
    }).onDelete('cascade'),
    index('notification_deliveries_due')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index().on(t.householdId),
    check(
      'notification_deliveries_channel_kind',
      sql`${t.channel} IN (${inList(NOTIFICATION_CHANNEL_KINDS)})`,
    ),
    check(
      'notification_deliveries_status',
      sql`${t.status} IN (${inList(NOTIFICATION_DELIVERY_STATUSES)})`,
    ),
    check(
      'notification_deliveries_error_code',
      sql`${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ '^[A-Za-z0-9_.:-]{1,64}$'`,
    ),
  ],
);
