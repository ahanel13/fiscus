// SPDX-License-Identifier: AGPL-3.0-or-later
import { connections, type Database, type Executor, merchantLogos, transactions } from '@fiscus/db';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Arrival } from './match.js';

// Merchants' logos (#423): sync names each transaction's logo, and the worker fetches the image
// once, from the provider's CDN only, so the browser loads it from Fiscus's own origin and the
// provider never learns who looks. Best effort throughout: a logo that can't be fetched is a
// transaction without one.

/** At most this many bytes: a small square logo. */
export const LOGO_MAX_BYTES = 65_536;
/** After this many failed fetches, a logo is left alone. */
export const LOGO_MAX_FAILURES = 3;
/** How many logos one sync fetches, so a first sync of years of history doesn't stall. */
export const LOGOS_PER_SYNC = 25;

/** Only Plaid's own logo hosts, over https: never an address a transaction could point anywhere. */
export function logoUrlAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    /^plaid-[a-z-]+\.plaid\.com$/.test(u.hostname)
  );
}

/** What an image's first bytes say it is: PNG, JPEG or WebP, else nothing. */
export function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/**
 * Names each arriving transaction's logo (in the sync's transaction): a row per merchant, made
 * the first time one is seen, and the transaction pointing at it. A transaction the bank no
 * longer gives a logo keeps the one it had.
 */
export async function linkMerchantLogos(
  tx: Executor,
  connectionId: string,
  arrivals: Iterable<Arrival>,
): Promise<void> {
  const withLogo = [...arrivals].filter((a) => a.t.merchantLogo);
  if (withLogo.length === 0) return;
  const [connection] = await tx
    .select({ provider: connections.provider })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!connection) return;
  const byKey = new Map(withLogo.map((a) => [a.t.merchantLogo!.key, a.t.merchantLogo!.url]));
  await tx
    .insert(merchantLogos)
    .values(
      [...byKey].map(([providerKey, sourceUrl]) => ({
        provider: connection.provider,
        providerKey,
        sourceUrl,
      })),
    )
    .onConflictDoNothing();
  const ids = new Map(
    (
      await tx
        .select({ id: merchantLogos.id, key: merchantLogos.providerKey })
        .from(merchantLogos)
        .where(
          and(
            eq(merchantLogos.provider, connection.provider),
            inArray(merchantLogos.providerKey, [...byKey.keys()]),
          ),
        )
    ).map((r) => [r.key, r.id]),
  );
  for (const [logoId, list] of Map.groupBy(withLogo, (a) => ids.get(a.t.merchantLogo!.key))) {
    if (!logoId) continue;
    for (const [accountId, inAccount] of Map.groupBy(list, (a) => a.accountId)) {
      await tx
        .update(transactions)
        .set({ merchantLogoId: logoId })
        .where(
          and(
            eq(transactions.accountId, accountId),
            inArray(
              transactions.providerTransactionId,
              inAccount.map((a) => a.t.providerTransactionId),
            ),
            sql`${transactions.merchantLogoId} IS DISTINCT FROM ${logoId}`,
          ),
        );
    }
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The image at `url`, if it's an allowed logo of a known type and size; else null. */
export async function fetchLogo(
  url: string,
  fetchImpl: Fetch = fetch,
): Promise<{ image: Buffer; contentType: string } | null> {
  if (!logoUrlAllowed(url)) return null;
  const res = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
    headers: { accept: 'image/png, image/jpeg, image/webp' },
  });
  if (!res.ok) return null;
  if (Number(res.headers.get('content-length') ?? 0) > LOGO_MAX_BYTES) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) return null;
  const contentType = imageType(bytes);
  return contentType ? { image: Buffer.from(bytes), contentType } : null;
}

/**
 * Fetches logos not fetched yet, a few at a time after each sync. Logos are global, outside any
 * household, so this needs no household context. A failure is counted, and after a few the logo
 * is left alone.
 */
export async function fetchMerchantLogos(
  db: Database,
  { fetchImpl = fetch, limit = LOGOS_PER_SYNC, now = new Date() } = {},
): Promise<{ fetched: number; failed: number }> {
  const due = await db
    .select({ id: merchantLogos.id, url: merchantLogos.sourceUrl })
    .from(merchantLogos)
    .where(
      and(
        isNull(merchantLogos.fetchedAt),
        lt(merchantLogos.failures, LOGO_MAX_FAILURES),
        or(
          isNull(merchantLogos.failedAt),
          lt(merchantLogos.failedAt, new Date(now.getTime() - 3_600_000)),
        ),
      ),
    )
    .limit(limit);
  let fetched = 0;
  let failed = 0;
  for (const logo of due) {
    const got = await fetchLogo(logo.url, fetchImpl).catch(() => null);
    if (got) {
      fetched++;
      await db
        .update(merchantLogos)
        .set({ image: got.image, contentType: got.contentType, fetchedAt: now, updatedAt: now })
        .where(eq(merchantLogos.id, logo.id));
    } else {
      failed++;
      await db
        .update(merchantLogos)
        .set({ failures: sql`${merchantLogos.failures} + 1`, failedAt: now, updatedAt: now })
        .where(eq(merchantLogos.id, logo.id));
    }
  }
  return { fetched, failed };
}
