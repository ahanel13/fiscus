// SPDX-License-Identifier: AGPL-3.0-or-later
import { transactions, transactionTags } from '@fiscus/db';
import {
  CORRECTED_FIELDS,
  type CorrectedField,
  type correctionsQuerySchema,
  type TransactionCorrection,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import { decodeCursor, encodeCursor } from './transactions.service.js';

/**
 * What people and files chose for transactions (#528): those you can see whose name, category or
 * tags a person or a file set (`field_versions`, which rules and sync never write), each with the
 * bank's text beside it. What an assistant reads to suggest rules. Visible as on Transactions
 * (row-level security); split parents are represented by their parts, as there.
 */
@Injectable()
export class CorrectionsService {
  constructor(private readonly scope: HouseholdScope) {}

  async list(
    ctx: HouseholdContext,
    q: z.infer<typeof correctionsQuerySchema>,
  ): Promise<{ data: TransactionCorrection[]; nextCursor: string | null }> {
    return this.scope.run(ctx, async (tx) => {
      const where: (SQL | undefined)[] = [
        eq(transactions.householdId, ctx.householdId),
        isNull(transactions.deletedAt),
        eq(transactions.hasSplits, false),
        sql`jsonb_exists_any(${transactions.fieldVersions}, ${sql.param([...CORRECTED_FIELDS])}::text[])`,
        q.since ? gte(transactions.effectiveDate, q.since) : undefined,
      ];
      if (q.cursor) {
        const [date, id] = decodeCursor(q.cursor);
        where.push(
          sql`(${transactions.effectiveDate}, ${transactions.id}) < (${date}::date, ${id}::uuid)`,
        );
      }
      const rows = await tx
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          date: transactions.effectiveDate,
          amountMinor: transactions.amountMinor,
          currency: transactions.currency,
          originalDescription: transactions.originalDescription,
          displayName: transactions.displayName,
          categoryId: transactions.categoryId,
          fieldVersions: transactions.fieldVersions,
          source: transactions.source,
        })
        .from(transactions)
        .where(and(...where))
        .orderBy(desc(transactions.effectiveDate), desc(transactions.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);

      const tags = new Map<string, string[]>();
      if (page.length) {
        for (const t of await tx
          .select()
          .from(transactionTags)
          .where(
            inArray(
              transactionTags.transactionId,
              page.map((r) => r.id),
            ),
          )) {
          tags.set(t.transactionId, [...(tags.get(t.transactionId) ?? []), t.tagId]);
        }
      }

      const last = page.at(-1);
      return {
        data: page.map(({ fieldVersions, ...r }) => ({
          ...r,
          tagIds: tags.get(r.id) ?? [],
          set: CORRECTED_FIELDS.filter((f): f is CorrectedField => Object.hasOwn(fieldVersions, f)),
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.date, last.id) : null,
      };
    });
  }
}
