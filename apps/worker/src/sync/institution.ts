// SPDX-License-Identifier: AGPL-3.0-or-later
import { connections, type Database, institutions, systemContext, withContext } from '@fiscus/db';
import type { AggregationProvider } from '@fiscus/domain';
import { eq } from 'drizzle-orm';

/** How long a bank's name, logo and color are kept before they're asked of the provider again. */
export const INSTITUTION_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Keeps a connection's bank as its provider shows it now (#423, GUIDE-017): its name, logo and
 * color, asked again once a month, so banks connected before logos were kept get theirs and a
 * rebrand shows up. Best effort: a provider without display data, or one that fails, changes
 * nothing, and the sync it follows has already succeeded.
 */
export async function refreshInstitution(
  job: { db: Database; householdId: string; connectionId: string },
  provider: AggregationProvider,
  now = new Date(),
): Promise<'refreshed' | 'fresh' | 'skipped'> {
  if (!provider.institution) return 'skipped';
  const [bank] = await withContext(job.db, systemContext(job.householdId), (tx) =>
    tx
      .select({
        id: institutions.id,
        providerInstitutionId: institutions.providerInstitutionId,
        checkedAt: institutions.displayCheckedAt,
      })
      .from(connections)
      .innerJoin(institutions, eq(institutions.id, connections.institutionId))
      .where(eq(connections.id, job.connectionId)),
  );
  if (!bank) return 'skipped';
  if (bank.checkedAt && now.getTime() - bank.checkedAt.getTime() < INSTITUTION_REFRESH_MS) {
    return 'fresh';
  }
  try {
    const shown = await provider.institution(bank.providerInstitutionId);
    await withContext(job.db, systemContext(job.householdId), (tx) =>
      tx
        .update(institutions)
        .set({
          name: shown.name,
          url: shown.url ?? null,
          logoPng: shown.logoPng ? Buffer.from(shown.logoPng) : null,
          color: shown.color ?? null,
          displayCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(institutions.id, bank.id)),
    );
    return 'refreshed';
  } catch {
    return 'skipped';
  }
}
