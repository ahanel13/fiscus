// SPDX-License-Identifier: AGPL-3.0-or-later
import { transactions } from '@fiscus/db';
import { and, eq, type SQL, sql } from 'drizzle-orm';

/**
 * Waiting in the review queue: needing review, and, when the household reviews only what's
 * uncategorized (#508), without a category. Worked out when asked, so switching the setting or
 * clearing a category takes effect at once. The queue, its badge, the reminder and the recap agree.
 */
export function waitingForReview(): SQL {
  return and(
    eq(transactions.reviewStatus, 'needs_review'),
    sql`(${transactions.categoryId} IS NULL
      OR ${transactions.categoryId} IN (SELECT c.id FROM categories c WHERE c.system_key = 'uncategorized')
      OR NOT EXISTS (SELECT 1 FROM households h
                     WHERE h.id = ${transactions.householdId} AND h.review_scope = 'uncategorized'))`,
  )!;
}
