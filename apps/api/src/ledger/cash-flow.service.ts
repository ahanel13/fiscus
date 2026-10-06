// SPDX-License-Identifier: AGPL-3.0-or-later
import { households, transactions } from '@fiscus/db';
import {
  averageOf,
  buckets,
  type CashFlow,
  type CashFlowBucket,
  type cashFlowQuerySchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, lte, ne, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import { householdRanges, resolveParams, transactionDate } from '../ranges/household-ranges.js';
import { spendingLensFilter } from '../visibility/visibility-scope.js';

type Query = z.infer<typeof cashFlowQuerySchema>;

/**
 * Income, spending, and net per period, "visible to you" (F3), under the spending lens (ADR 0006
 * §5) and the household's time settings (ADR 0011). Leaves out transfers (they move money, they
 * don't earn or spend it), excluded transactions, and split parents (their parts count instead).
 */
@Injectable()
export class CashFlowService {
  constructor(private readonly scope: HouseholdScope) {}

  async get(ctx: HouseholdContext, q: Query): Promise<CashFlow> {
    return this.scope.run(ctx, async (tx) => {
      const ranges = await householdRanges(tx, ctx.householdId);
      const [h] = await tx
        .select({ currency: households.baseCurrency })
        .from(households)
        .where(eq(households.id, ctx.householdId));
      const date = transactionDate(ranges.dateBasis);
      const lens = await spendingLensFilter(tx, ctx, q.lens);
      const scope: (SQL | undefined)[] = [
        eq(transactions.householdId, ctx.householdId),
        isNull(transactions.deletedAt),
        eq(transactions.hasSplits, false),
        eq(transactions.excluded, false),
        sql`NOT EXISTS (
          SELECT 1 FROM categories c JOIN category_groups g ON g.id = c.group_id
          WHERE c.id = ${transactions.categoryId} AND g.kind = 'transfer')`,
        lens,
      ];

      const [first] = await tx
        .select({ d: sql<string | null>`min(${date})::text` })
        .from(transactions)
        .where(and(...scope));
      const earliest = first?.d ?? undefined;
      const resolved = resolveParams(q, ranges, earliest)!;

      /** Income and spending per day in a range, in the household currency. */
      const daily = async (from: string, to: string) => {
        const rows = await tx
          .select({
            day: sql<string>`${date}::text`,
            income: sql<string>`coalesce(sum(${transactions.amountMinor}) FILTER (WHERE ${transactions.amountMinor} > 0), 0)::text`,
            spending: sql<string>`coalesce(-sum(${transactions.amountMinor}) FILTER (WHERE ${transactions.amountMinor} < 0), 0)::text`,
          })
          .from(transactions)
          .where(
            and(...scope, eq(transactions.currency, h!.currency), gte(date, from), lte(date, to)),
          )
          .groupBy(date);
        return rows.map((r) => ({
          day: r.day,
          income: BigInt(r.income),
          spending: BigInt(r.spending),
        }));
      };
      const totals = (days: { income: bigint; spending: bigint }[]) => {
        const income = days.reduce((s, d) => s + d.income, 0n);
        const spending = days.reduce((s, d) => s + d.spending, 0n);
        return {
          incomeMinor: Number(income),
          spendingMinor: Number(spending),
          netMinor: Number(income - spending),
        };
      };

      const days = await daily(resolved.range.from, resolved.range.to);
      const out: CashFlowBucket[] = buckets(
        resolved.range,
        resolved.granularity,
        ranges.settings,
        ranges.today,
      ).map((b) => {
        // Before the first transaction in view there's no data, which isn't the same as zero.
        if (!earliest || b.end < earliest) {
          return { ...b, incomeMinor: null, spendingMinor: null, netMinor: null };
        }
        return { ...b, ...totals(days.filter((d) => d.day >= b.start && d.day <= b.end)) };
      });

      const [other] = await tx
        .select({ n: sql<number>`count(*)::int`, currency: transactions.currency })
        .from(transactions)
        .where(
          and(
            ...scope,
            ne(transactions.currency, h!.currency),
            gte(date, resolved.range.from),
            lte(date, resolved.range.to),
          ),
        )
        .groupBy(transactions.currency);
      const average = (pick: (b: CashFlowBucket) => number | null) =>
        averageOf(out.map((b) => ({ value: pick(b), partial: b.partial })));

      return {
        currency: h!.currency,
        range: resolved.meta,
        buckets: out,
        totals: totals(days),
        averages: {
          incomeMinor: average((b) => b.incomeMinor),
          spendingMinor: average((b) => b.spendingMinor),
          netMinor: average((b) => b.netMinor),
        },
        comparison: resolved.comparison
          ? totals(await daily(resolved.comparison.from, resolved.comparison.to))
          : null,
        unconverted: other ? [{ currency: other.currency, transactions: other.n }] : [],
      };
    });
  }
}
