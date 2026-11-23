// SPDX-License-Identifier: AGPL-3.0-or-later
import { DecryptionError, type FieldCrypto } from '@fiscus/crypto';
import { sql } from 'drizzle-orm';
import type { Executor } from './client.js';
import { plaidKeySetSecretContext, type PlaidKeySet } from './plaid-credentials.js';
import { PLAID_WEBHOOK_OUTCOMES, type PlaidWebhookOutcome } from './schema/connections.js';

// Plaid webhooks (#84) through the definers in migration plaid_webhooks_access: the api has no
// household context for a webhook (no member sent it), so it finds the Item, reads its key set,
// queues work and counts outcomes only through these. The worker moves Items to a new URL and
// relaxes polling with the last two.

/** The connection a webhook's item id names; null when no live Plaid connection has it. */
export async function findPlaidItem(
  db: Executor,
  itemId: string,
): Promise<{ householdId: string; connectionId: string; credentialSetId: string | null } | null> {
  const { rows } = await db.execute<{
    household_id: string;
    connection_id: string;
    credential_set_id: string | null;
  }>(
    sql`SELECT household_id, connection_id, credential_set_id FROM fiscus_find_plaid_item(${itemId})`,
  );
  const [row] = rows;
  return row
    ? {
        householdId: row.household_id,
        connectionId: row.connection_id,
        credentialSetId: row.credential_set_id,
      }
    : null;
}

/**
 * The household key set the Item was made with, decrypted for checking one webhook, then
 * dropped; null when it has none (the server's keys), or it's shredded or unreadable.
 */
export async function plaidWebhookKeySet(
  db: Executor,
  crypto: FieldCrypto,
  itemId: string,
): Promise<(PlaidKeySet & { id: string }) | null> {
  const { rows } = await db.execute<{
    credential_set_id: string;
    household_id: string;
    client_id: string;
    env: string;
    secret_enc: Buffer;
  }>(
    sql`SELECT credential_set_id, household_id, client_id, env, secret_enc
        FROM fiscus_plaid_webhook_key_set(${itemId})`,
  );
  const [row] = rows;
  if (!row || row.secret_enc.length === 0) return null;
  if (row.env !== 'sandbox' && row.env !== 'production') return null;
  try {
    const secret = await crypto.decrypt(
      plaidKeySetSecretContext(row.household_id, row.credential_set_id),
      row.secret_enc,
    );
    return { id: row.credential_set_id, clientId: row.client_id, env: row.env, secret };
  } catch (err) {
    if (err instanceof DecryptionError) return null;
    throw err;
  }
}

/** What a verified webhook asks of the runner; `url` is this server's webhook URL. */
export async function queuePlaidWebhook(
  db: Executor,
  connectionId: string,
  action: 'sync' | 'check' | 'acknowledged',
  url: string,
): Promise<boolean> {
  const { rows } = await db.execute<{ queued: boolean }>(
    sql`SELECT fiscus_queue_plaid_webhook(${connectionId}, ${action}, ${url}) AS queued`,
  );
  return rows[0]?.queued ?? false;
}

/** Counts one request to the receiver. */
export async function recordPlaidWebhook(
  db: Executor,
  credentialSetId: string | null,
  outcome: PlaidWebhookOutcome,
): Promise<void> {
  await db.execute(sql`SELECT fiscus_record_plaid_webhook(${credentialSetId}, ${outcome})`);
}

/** Polling relaxes while a verified webhook came in this long ago at most (#84)... */
export const WEBHOOK_HEALTHY_RECEIVED_MS = 48 * 60 * 60_000;
/** ...and no request was refused in this long. */
export const WEBHOOK_HEALTHY_NO_FAILURES_MS = 24 * 60 * 60_000;

export interface PlaidWebhookHealth {
  lastVerifiedAt: Date | null;
  lastFailureAt: Date | null;
  /** A verified webhook in the last 48 hours, and none refused in the last 24. */
  healthy: boolean;
}

/** The receiver's health, from its counts: what polling relaxes by (#84). */
export async function plaidWebhookHealth(db: Executor): Promise<PlaidWebhookHealth> {
  const { rows } = await db.execute<{
    verified: Date | string | null;
    failed: Date | string | null;
    healthy: boolean;
  }>(
    sql`WITH last AS (
          SELECT max(last_at) FILTER (WHERE outcome IN ('verified', 'unknown_item')) AS verified,
                 max(last_at) FILTER (WHERE outcome NOT IN ('verified', 'unknown_item')) AS failed
          FROM plaid_webhook_stats WHERE hour >= now() - interval '49 hours'
        )
        SELECT verified, failed,
               coalesce(verified >= now() - ${`${WEBHOOK_HEALTHY_RECEIVED_MS} milliseconds`}::interval
                 AND (failed IS NULL
                      OR failed < now() - ${`${WEBHOOK_HEALTHY_NO_FAILURES_MS} milliseconds`}::interval),
                 false) AS healthy
        FROM last`,
  );
  const at = (v: Date | string | null | undefined) => (v ? new Date(v) : null);
  return {
    lastVerifiedAt: at(rows[0]?.verified),
    lastFailureAt: at(rows[0]?.failed),
    healthy: rows[0]?.healthy ?? false,
  };
}

/** A refusal's reason: every outcome but the two verified ones. */
export type PlaidWebhookRefusal = Exclude<PlaidWebhookOutcome, 'verified' | 'unknown_item'>;
export const PLAID_WEBHOOK_REFUSALS = PLAID_WEBHOOK_OUTCOMES.filter(
  (o): o is PlaidWebhookRefusal => o !== 'verified' && o !== 'unknown_item',
);

/** What Server → Bank connections shows of the receiver (#85): times and counts only (D16). */
export interface PlaidWebhookPanel {
  /** The last webhook whose signature checked out, its Item known here or not. */
  lastVerifiedAt: Date | null;
  /** The last verified for an Item here, made with the server's keys, or a household's own. */
  lastVerifiedByKeys: { server: Date | null; household: Date | null };
  /** Refused requests by reason, in the last 24 hours and 7 days. */
  refusals: Record<'last24h' | 'last7d', Record<PlaidWebhookRefusal, number>>;
  /** Verified webhooks for an Item no connection here has. */
  unknownItems: Record<'last24h' | 'last7d', number>;
  /** Live Plaid connections, and those whose Item isn't sending its webhooks to `url`. */
  connections: { plaid: number; withoutWebhook: number };
}

/**
 * The receiver's counts for the admin's panel (#85), and two connection counts through
 * fiscus_admin_plaid_webhook_counts, so it needs an instance admin's context. `url` is this
 * server's webhook URL, null when webhooks are off. Counts are kept by the hour, so "the last 24
 * hours" takes every hour that overlaps them: at most an hour more.
 */
export async function plaidWebhookPanel(
  db: Executor,
  url: string | null,
): Promise<PlaidWebhookPanel> {
  const { rows } = await db.execute<{
    outcome: PlaidWebhookOutcome;
    day: number;
    week: number;
    last_at: Date | string;
    last_server: Date | string | null;
    last_household: Date | string | null;
  }>(
    sql`SELECT outcome,
               coalesce(sum(count) FILTER (WHERE hour > now() - interval '25 hours'), 0)::int AS day,
               coalesce(sum(count) FILTER (WHERE hour > now() - interval '7 days 1 hour'), 0)::int
                 AS week,
               max(last_at) AS last_at,
               max(last_at) FILTER (WHERE credential_set_id IS NULL) AS last_server,
               max(last_at) FILTER (WHERE credential_set_id IS NOT NULL) AS last_household
        FROM plaid_webhook_stats GROUP BY outcome`,
  );
  const at = (v: Date | string | null | undefined) => (v ? new Date(v) : null);
  const latest = (...dates: (Date | null)[]) =>
    dates.reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);
  const by = new Map(rows.map((r) => [r.outcome, r]));
  const refusals = (key: 'day' | 'week') =>
    Object.fromEntries(PLAID_WEBHOOK_REFUSALS.map((o) => [o, by.get(o)?.[key] ?? 0])) as Record<
      PlaidWebhookRefusal,
      number
    >;
  const verified = by.get('verified');
  const unknown = by.get('unknown_item');
  const counts = await db.execute<{ c: { plaid: number; withoutWebhook: number } }>(
    sql`SELECT fiscus_admin_plaid_webhook_counts(${url}) AS c`,
  );
  return {
    lastVerifiedAt: latest(at(verified?.last_at), at(unknown?.last_at)),
    lastVerifiedByKeys: {
      server: at(verified?.last_server),
      household: at(verified?.last_household),
    },
    refusals: { last24h: refusals('day'), last7d: refusals('week') },
    unknownItems: { last24h: unknown?.day ?? 0, last7d: unknown?.week ?? 0 },
    connections: counts.rows[0]!.c,
  };
}

/** Plaid connections whose Item isn't on `url` (null: webhooks off), for the worker to move. */
export async function plaidWebhookMoves(
  db: Executor,
  url: string | null,
  limit: number,
): Promise<{ connectionId: string; householdId: string }[]> {
  const { rows } = await db.execute<{ connection_id: string; household_id: string }>(
    sql`SELECT connection_id, household_id FROM fiscus_plaid_webhook_moves(${url}, ${limit})`,
  );
  return rows.map((r) => ({ connectionId: r.connection_id, householdId: r.household_id }));
}

/** Brings relaxed Plaid connections back to `intervalMs` after their last sync. Returns how many. */
export async function unrelaxPlaidConnections(db: Executor, intervalMs: number): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(
    sql`SELECT fiscus_unrelax_connections(${`${Math.round(intervalMs)} milliseconds`}::interval) AS n`,
  );
  return rows[0]?.n ?? 0;
}
