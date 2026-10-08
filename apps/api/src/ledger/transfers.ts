// SPDX-License-Identifier: AGPL-3.0-or-later
import { categories, categoryGroups, type Executor, transactions } from '@fiscus/db';
import type { AccessLevel } from '@fiscus/shared';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { HouseholdActivity } from '../households/household-scope.js';

// Transfers between your own accounts (#40, docs/design/imports.md §5). Two transactions linked by
// `transfer_group_id`, both in a transfer category, so cash flow leaves them out. Linking needs
// ownership of both legs (TXN-08); unlinking puts each leg's previous category back.

type Row = typeof transactions.$inferSelect;

/** How far apart the two legs' dates may be for detection to pair them. */
export const TRANSFER_WINDOW_DAYS = 3;

export interface TransferCategories {
  /** The system Transfer category: what a linked leg gets unless it's in a transfer kind already. */
  transfer: string;
  uncategorized: string | null;
  /** Categories in groups of kind `transfer` (Transfer, Credit Card Payment, …). */
  transferKind: Set<string>;
}

export async function transferCategories(tx: Executor): Promise<TransferCategories> {
  const rows = await tx
    .select({ id: categories.id, systemKey: categories.systemKey, kind: categoryGroups.kind })
    .from(categories)
    .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId));
  return {
    transfer: rows.find((r) => r.systemKey === 'transfer')!.id,
    uncategorized: rows.find((r) => r.systemKey === 'uncategorized')?.id ?? null,
    transferKind: new Set(rows.filter((r) => r.kind === 'transfer').map((r) => r.id)),
  };
}

/**
 * Whether a transaction can be one leg of a transfer at all. Detection also needs it to be
 * uncategorized or in a transfer category: a purchase someone filed under Groceries is not a
 * transfer just because a refund of the same amount landed elsewhere.
 */
export const linkable = (r: Row) =>
  !r.deletedAt && !r.hasSplits && !r.parentId && !r.pending && !r.transferGroupId;

const detectable = (r: Row, cats: TransferCategories) =>
  linkable(r) &&
  (r.categoryId === null ||
    r.categoryId === cats.uncategorized ||
    cats.transferKind.has(r.categoryId));

/** One side of a possible transfer: a transaction, or a file row not imported yet (preview). */
export type Leg = Pick<Row, 'id' | 'accountId' | 'amountMinor' | 'currency' | 'effectiveDate'>;

const DAY_MS = 86_400_000;
const shiftDays = (date: string, days: number) =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

/** The opposite amount, the same currency, another account, within the window. */
const legsMatch = (a: Leg, b: Leg) =>
  a.id !== b.id &&
  a.amountMinor === -b.amountMinor &&
  a.currency === b.currency &&
  a.accountId !== b.accountId &&
  Math.abs(Date.parse(a.effectiveDate) - Date.parse(b.effectiveDate)) <=
    TRANSFER_WINDOW_DAYS * DAY_MS;

/** Pairs of legs matching each other, from two lists, grouped by amount to stay linear. */
function pairsBetween(from: Leg[], to: Leg[]): [string, string][] {
  const byAmount = Map.groupBy(to, (o) => o.amountMinor);
  return from.flatMap((n) =>
    (byAmount.get(-n.amountMinor) ?? [])
      .filter((o) => legsMatch(n, o))
      .map((o): [string, string] => [n.id, o.id]),
  );
}

/**
 * Transactions the caller can see that could be the other leg of any of `legs`: the opposite
 * amount within the window, not linked, uncategorized or a transfer. One query by amount, paired
 * in code: a self-join in SQL grows with the whole ledger.
 */
async function ledgerCandidates(
  tx: Executor,
  legs: Leg[],
  cats: TransferCategories,
): Promise<Leg[]> {
  if (legs.length === 0) return [];
  const eligible = [...cats.transferKind, ...(cats.uncategorized ? [cats.uncategorized] : [])];
  const dates = legs.map((l) => l.effectiveDate).sort();
  return tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      effectiveDate: transactions.effectiveDate,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.amountMinor, [...new Set(legs.map((l) => -l.amountMinor))]),
        gte(transactions.effectiveDate, shiftDays(dates[0]!, -TRANSFER_WINDOW_DAYS)),
        lte(transactions.effectiveDate, shiftDays(dates.at(-1)!, TRANSFER_WINDOW_DAYS)),
        isNull(transactions.transferGroupId),
        isNull(transactions.deletedAt),
        isNull(transactions.parentId),
        eq(transactions.hasSplits, false),
        eq(transactions.pending, false),
        or(isNull(transactions.categoryId), inArray(transactions.categoryId, eligible)),
      ),
    );
}

/**
 * The unambiguous transfers for `legs` (already eligible: unlinked, uncategorized or a transfer):
 * each side has exactly one possible other side, among `legs` and the ledger, and the caller owns
 * both accounts (TXN-08). `legs` may be transactions or, for a preview, file rows not stored yet.
 * Returns the pairs, each with a leg from `legs` first, and the ledger legs involved.
 */
export async function findTransfers(
  tx: Executor,
  legs: Leg[],
  cats: TransferCategories,
  owns: (accountId: string) => boolean,
): Promise<{ pairs: [Leg, Leg][]; ledger: Leg[] }> {
  const mine = new Set(legs.map((l) => l.id));
  const fromLedger = (await ledgerCandidates(tx, legs, cats)).filter((o) => !mine.has(o.id));
  const first = [...pairsBetween(legs, legs), ...pairsBetween(legs, fromLedger)];
  if (first.length === 0) return { pairs: [], ledger: [] };
  // Every possible leg of every ledger leg involved, so "exactly one" holds from both sides.
  const paired = new Set(first.map(([, b]) => b));
  const ledger = fromLedger.filter((o) => paired.has(o.id));
  const second = pairsBetween(ledger, await ledgerCandidates(tx, ledger, cats));
  const candidates = new Map<string, Set<string>>();
  const add = (a: string, b: string) => candidates.set(a, (candidates.get(a) ?? new Set()).add(b));
  for (const [a, b] of [...first, ...second]) {
    add(a, b);
    add(b, a);
  }
  const byId = new Map<string, Leg>([...ledger, ...legs].map((l) => [l.id, l]));
  const pairs: [Leg, Leg][] = [];
  const taken = new Set<string>();
  for (const a of legs) {
    const options = candidates.get(a.id);
    if (options?.size !== 1) continue;
    const b = byId.get([...options][0]!);
    if (!b || candidates.get(b.id)?.size !== 1 || taken.has(a.id) || taken.has(b.id)) continue;
    if (!owns(a.accountId) || !owns(b.accountId)) continue;
    taken.add(a.id).add(b.id);
    pairs.push([a, b]);
  }
  return { pairs, ledger };
}

/**
 * Links the transfers among `ids` that are unambiguous (findTransfers). Anything else is left as
 * it is. Runs on import and on manual entry. Returns how many pairs it linked.
 */
export async function detectTransfers(
  tx: Executor,
  activity: HouseholdActivity,
  ids: string[],
  levels: Map<string, AccessLevel>,
): Promise<number> {
  if (ids.length === 0) return 0;
  const cats = await transferCategories(tx);
  const rows = (
    await tx
      .select()
      .from(transactions)
      .where(and(inArray(transactions.id, ids), isNull(transactions.deletedAt)))
  ).filter((r) => detectable(r, cats));
  const { pairs } = await findTransfers(
    tx,
    rows,
    cats,
    (accountId) => levels.get(accountId) === 'owner',
  );
  await linkTransfers(tx, activity, pairs, cats, true);
  return pairs.length;
}

/**
 * Links pairs of transactions as transfers. Each leg remembers its category and moves to Transfer,
 * unless it's in a transfer category already (Credit Card Payment stays Credit Card Payment).
 */
export async function linkTransfers(
  tx: Executor,
  activity: HouseholdActivity,
  pairs: [Pick<Row, 'id' | 'accountId'>, Pick<Row, 'id' | 'accountId'>][],
  cats: TransferCategories,
  automatic: boolean,
): Promise<void> {
  if (pairs.length === 0) return;
  const legs = pairs.flatMap(([a, b]) => {
    const group = uuidv7();
    return [
      { row: a, group },
      { row: b, group },
    ];
  });
  for (let i = 0; i < legs.length; i += 2000) {
    const part = legs.slice(i, i + 2000);
    await tx.execute(sql`
      UPDATE transactions t
      SET transfer_group_id = v.g,
          transfer_previous_category_id = t.category_id,
          category_id = CASE WHEN t.category_id = ANY(${sql.param([...cats.transferKind])}::uuid[])
                             THEN t.category_id ELSE ${cats.transfer}::uuid END,
          version = t.version + 1
      FROM unnest(${sql.param(part.map((l) => l.row.id))}::uuid[],
                  ${sql.param(part.map((l) => l.group))}::uuid[]) AS v(id, g)
      WHERE t.id = v.id`);
  }
  await recordByAccount(
    activity,
    'transaction.transfer_linked',
    legs.map((l) => l.row),
    { automatic },
  );
}

/**
 * Unlinks the transfers in `groups`: every live leg leaves the group, and a leg still in the
 * Transfer category goes back to the category it had (Uncategorized if that's gone). A leg someone
 * recategorized since keeps their choice. Used when a person unlinks, and when one leg is
 * deleted, undone with its import, or moved into the other leg's account.
 */
export async function unlinkTransfers(
  tx: Executor,
  activity: HouseholdActivity,
  groups: string[],
  cause: 'unlinked' | 'deleted' | 'reverted' | 'moved',
): Promise<void> {
  if (groups.length === 0) return;
  const cats = await transferCategories(tx);
  const { rows } = await tx.execute<{ id: string; account_id: string }>(sql`
    UPDATE transactions t
    SET category_id = CASE
          WHEN t.category_id IS DISTINCT FROM ${cats.transfer}::uuid THEN t.category_id
          WHEN EXISTS (SELECT 1 FROM categories c WHERE c.id = t.transfer_previous_category_id
                       AND c.archived_at IS NULL) THEN t.transfer_previous_category_id
          ELSE NULL END,
        transfer_group_id = NULL,
        transfer_previous_category_id = NULL,
        version = t.version + 1
    WHERE t.transfer_group_id = ANY(${sql.param(groups)}::uuid[]) AND t.deleted_at IS NULL
    RETURNING t.id, t.account_id`);
  await recordByAccount(
    activity,
    'transaction.transfer_unlinked',
    rows.map((r) => ({ id: r.id, accountId: r.account_id })),
    { cause },
  );
}

/** One event per account, so each is visible only to members who can see that account. */
async function recordByAccount(
  activity: HouseholdActivity,
  action: string,
  legs: { id: string; accountId: string }[],
  metadata: Record<string, unknown>,
) {
  for (const [accountId, list] of Map.groupBy(legs, (l) => l.accountId)) {
    await activity.record({
      action,
      targetType: 'account',
      targetId: accountId,
      accountId,
      metadata: { ...metadata, count: list.length },
      changes: { after: { ids: list.map((l) => l.id) } },
    });
  }
}
