// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, id, timestamps } from '../columns.js';
import { householdMembers, households } from './households.js';

// Bank connections (data model §3.2, docs/design/aggregation.md, #78). Row-level security and the
// worker's claim: migration 0037; finishing a claimed job: the connection_jobs migration (#81).

export const CONNECTION_PROVIDERS = ['plaid', 'simplefin'] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
/** `setup`: linked, owners and visibility not confirmed yet; only its owner sees it (D4). */
export const CONNECTION_STATUSES = [
  'setup',
  'ok',
  'login_required',
  'error',
  'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** Banks as a provider knows them. Global reference data: no household, no row-level security. */
export const institutions = pgTable(
  'institutions',
  {
    id: id(),
    provider: text().notNull(),
    providerInstitutionId: text().notNull(),
    name: text().notNull(),
    url: text(),
    /** The bank's logo, a PNG of at most 64 KB, served from Fiscus's own origin (#423). */
    logoPng: bytea('logo_png'),
    /** The bank's color, `#rrggbb`. */
    color: text(),
    /** When the name, logo and color were last asked of the provider; refreshed monthly. */
    displayCheckedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('institutions_provider_institution').on(t.provider, t.providerInstitutionId),
    check('institutions_provider', sql`${t.provider} IN (${inList(CONNECTION_PROVIDERS)})`),
    check('institutions_color', sql`${t.color} IS NULL OR ${t.color} ~ '^#[0-9a-f]{6}$'`),
    check(
      'institutions_logo_size',
      sql`${t.logoPng} IS NULL OR octet_length(${t.logoPng}) <= 65536`,
    ),
  ],
);

/**
 * A household's own Plaid keys (ADR 0008, #83): the secret encrypted with the household key, and
 * write-only through the api. Schema only for now, so connections can name the set they use.
 */
export const aggregationCredentials = pgTable(
  'aggregation_credentials',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    provider: text().notNull(),
    clientId: text().notNull(),
    secretEnc: bytea('secret_enc').notNull(),
    env: text().notNull(),
    createdByMemberId: uuid(),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('aggregation_credentials_household_id_id').on(t.householdId, t.id),
    foreignKey({
      columns: [t.householdId, t.createdByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    check('aggregation_credentials_provider', sql`${t.provider} = 'plaid'`),
  ],
);

/**
 * One per Plaid Item or SimpleFIN access URL. Its secret is in connection_secrets, readable only
 * by its owner and the worker. Scheduling is in Postgres: the worker claims due connections with
 * fiscus_claim_due_connections(), which leases them (`lease_until`).
 */
export const connections = pgTable(
  'connections',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** The member who linked it: the only one who fixes or disconnects it (ACC-03, D11). */
    ownerMemberId: uuid().notNull(),
    provider: text().notNull(),
    institutionId: uuid().references(() => institutions.id),
    /** Null = the server's own keys. Fixed for the connection's life (ADR 0008). */
    credentialSetId: uuid(),
    providerItemId: text().notNull(),
    /** Plaid's environment (sandbox, production) and client id the Item was made with. */
    providerEnv: text(),
    providerClientId: text(),
    status: text().notNull().default('setup'),
    /** The provider's code for the last failure (never its message, which is untrusted text). */
    lastErrorCode: text(),
    /** When the current run of failures began: after 3 days, the connection says so (D10). */
    firstFailedAt: timestamp({ withTimezone: true }),
    lastSyncedAt: timestamp({ withTimezone: true }),
    /** When its owner last pressed "Refresh now": the next is allowed after the provider's limit (D10). */
    refreshRequestedAt: timestamp({ withTimezone: true }),
    /** When the worker next syncs it; null = never (setup, disconnected). */
    nextSyncAt: timestamp({ withTimezone: true }),
    /** A worker holds it until then. */
    leaseUntil: timestamp({ withTimezone: true }),
    /** Failures in a row, for the worker's backoff (#81); 0 again after a success. */
    consecutiveFailures: integer().notNull().default(0),
    /** The provider says all older history has arrived. */
    historicalComplete: boolean().notNull().default(false),
    webhookEnabled: boolean().notNull().default(false),
    /** The bank offers accounts not tracked yet (Plaid's NEW_ACCOUNTS_AVAILABLE). */
    newAccountsAvailable: boolean().notNull().default(false),
    /** Disconnected, and the worker still has to end it at the provider, then drop its secret. */
    disconnectRequested: boolean().notNull().default(false),
    /** Plaid's /transactions/sync cursor. */
    syncCursor: text(),
    /**
     * The connection this one moves to other Plaid keys (#83, D15): confirming it takes over that
     * one's accounts, and ends it.
     */
    replacesConnectionId: uuid(),
    ...timestamps(),
  },
  (t) => [
    // Target of composite foreign keys (accounts, connection_secrets): they can't cross households.
    unique('connections_household_id_id').on(t.householdId, t.id),
    unique('connections_provider_item').on(t.provider, t.providerItemId),
    foreignKey({
      columns: [t.householdId, t.ownerMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    foreignKey({
      columns: [t.householdId, t.credentialSetId],
      foreignColumns: [aggregationCredentials.householdId, aggregationCredentials.id],
    }),
    foreignKey({
      columns: [t.householdId, t.replacesConnectionId],
      foreignColumns: [t.householdId, t.id],
    }),
    index().on(t.householdId),
    index('connections_due')
      .on(t.nextSyncAt)
      .where(sql`${t.nextSyncAt} IS NOT NULL`),
    check('connections_provider', sql`${t.provider} IN (${inList(CONNECTION_PROVIDERS)})`),
    check('connections_status', sql`${t.status} IN (${inList(CONNECTION_STATUSES)})`),
  ],
);

/**
 * A connection's access token or access URL, encrypted with the household key and bound to its
 * connection (associated data). Readable and writable only by the connection's owner and the
 * worker: other members can't read even the ciphertext. Never returned, logged, or in activity.
 */
export const connectionSecrets = pgTable(
  'connection_secrets',
  {
    connectionId: uuid().primaryKey(),
    householdId: uuid().notNull(),
    secretEnc: bytea('secret_enc').notNull(),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      columns: [t.householdId, t.connectionId],
      foreignColumns: [connections.householdId, connections.id],
    }).onDelete('cascade'),
  ],
);
