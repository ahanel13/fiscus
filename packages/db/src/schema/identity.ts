// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { bytea, id, timestamps } from '../columns.js';

// Identity tables (data model §3.1). Not household-scoped, so no row-level security.

export const users = pgTable(
  'users',
  {
    id: id(),
    /** Stored normalized (trimmed, lowercase). */
    email: text().notNull(),
    emailVerifiedAt: timestamp({ withTimezone: true }),
    displayName: text().notNull(),
    /** argon2id PHC string. Null for SSO-only users. */
    passwordHash: text(),
    totpSecretEnc: bytea('totp_secret_enc'),
    isInstanceAdmin: boolean().notNull().default(false),
    disabledAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie token; the token itself is never stored. */
    tokenHash: bytea('token_hash').notNull(),
    activeHouseholdId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    reauthenticatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ip: inet(),
    userAgent: text(),
  },
  (t) => [uniqueIndex('sessions_token_hash_key').on(t.tokenHash), index().on(t.userId)],
);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: id(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: bytea('token_hash').notNull().unique(),
  createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** One-time first-run setup token (single row, removed once setup completes). */
export const instanceSetup = pgTable(
  'instance_setup',
  {
    id: smallint().primaryKey().default(1),
    tokenHash: bytea('token_hash').notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('instance_setup_single_row', sql`${t.id} = 1`)],
);

export const auditActorKind = pgEnum('audit_actor_kind', [
  'user',
  'instance_admin',
  'system',
  'assistant',
  'pat',
  'anonymous',
]);

/** Append-only (UPDATE/DELETE revoked from fiscus_app). Metadata never holds financial plaintext. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    actorKind: auditActorKind().notNull(),
    actorUserId: uuid(),
    actorMemberId: uuid(),
    householdId: uuid(),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    visibleToHousehold: boolean().notNull().default(false),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ip: inet(),
    /** Chain scope: the household, or the nil UUID for instance-level events (ADR 0013). */
    scopeId: uuid()
      .notNull()
      .generatedAlwaysAs(sql`coalesce(household_id, '00000000-0000-0000-0000-000000000000'::uuid)`),
    /** Position in the scope's hash chain (null only for events recorded before chaining). */
    seq: bigint({ mode: 'number' }),
    /** SHA-256(previous entry hash ‖ canonical entry). */
    entryHash: bytea('entry_hash'),
    /** Before/after values, encrypted with the household key (ADR 0013 §1). */
    changesEnc: bytea('changes_enc'),
  },
  (t) => [
    index().on(t.householdId, t.occurredAt),
    index().on(t.targetType, t.targetId),
    index().on(t.actorUserId, t.occurredAt),
    uniqueIndex('audit_events_scope_seq')
      .on(t.scopeId, t.seq)
      .where(sql`${t.seq} IS NOT NULL`),
  ],
);

/** Current head of each activity chain; appends lock this row, so a chain never forks. */
export const auditChainHeads = pgTable('audit_chain_heads', {
  scopeId: uuid().primaryKey(),
  seq: bigint({ mode: 'number' }).notNull(),
  headHash: bytea('head_hash').notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
