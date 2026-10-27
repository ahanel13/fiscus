// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import {
  accountGroups,
  accountLiabilities,
  accountPlacements,
  accountOwners,
  accounts,
  balanceSnapshots,
  type Executor,
  householdMembers,
  households,
} from '@fiscus/db';
import { accessLevels, householdRanges, recomputeBalances, replaceOwners } from '@fiscus/ledger';
import { planVersionedPatch } from '@fiscus/domain';
import { buckets, ownersFromDefault } from '@fiscus/shared';
import type {
  AccessLevel,
  Account,
  AccountType,
  AccountVisibility,
  BalanceMode,
  BalancePoint,
  createAccountSchema,
  FinanceStyle,
  Lens,
  NetWorth,
  OwnersFrom,
  OwnersInput,
  setBalanceSchema,
  updateAccountSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { addDays, daysBetween, todayIn } from '../common/dates.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { type HouseholdActivity, HouseholdScope } from '../households/household-scope.js';
import { moneyScope } from '../visibility/visibility-scope.js';
import { type RangeParams, resolveParams } from '../ranges/household-ranges.js';

type WindowParams = RangeParams;

/** One bucket per day, for requests without a range. */
const dayBuckets = (from: string, to: string) => {
  const out: { start: string; end: string; partial: boolean }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ start: d, end: d, partial: false });
  return out;
};

type AccountRow = typeof accounts.$inferSelect;
type CreateInput = z.infer<typeof createAccountSchema>;
type UpdateInput = z.infer<typeof updateAccountSchema>;
type BalanceInput = z.infer<typeof setBalanceSchema>;

/** Bank-style accounts follow their transactions; assets are valued by hand (design §5). */
const DEFAULT_BALANCE_MODE: Record<AccountType, BalanceMode> = {
  depository: 'transactions',
  credit: 'transactions',
  loan: 'transactions',
  investment: 'value',
  property: 'value',
  vehicle: 'value',
  crypto: 'value',
  other: 'value',
};

/** New-account visibility per finance style (ADR 0006 §8). */
export const STYLE_VISIBILITY: Record<string, AccountVisibility> = {
  combined: 'full',
  hybrid: 'full',
  separate: 'view_only',
  roommates: 'private',
};

const MAX_WINDOW_DAYS = 3660;

/** Equal shares in basis points; the first owner takes the remainder (3 → 3334/3333/3333). */
export function equalShares(count: number): number[] {
  const base = Math.floor(10000 / count);
  return Array.from({ length: count }, (_, i) => (i === 0 ? 10000 - base * (count - 1) : base));
}

const notVisibleOrForbidden = (level: AccessLevel | undefined) =>
  level ? problems.forbidden('Only the account’s owners can do this.') : problems.notFound();

const privateJointDisallowed = () =>
  new Problem(
    422,
    'private_joint_disallowed',
    'A joint account can’t be private in a two-person household',
    'Both of you own it, so there is no one to hide it from. Choose who else can see it instead.',
  );

const futureDate = () => new Problem(422, 'future_date', 'Balances can’t be set for a future date');

interface HouseholdInfo {
  baseCurrency: string;
  timezone: string;
  financeStyle: FinanceStyle;
  /** Active members who may own accounts (not viewers). */
  owners: Set<string>;
  activeMembers: number;
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
  ) {}

  /** With a window (a range, or from/to), each account also carries its change over it (#353). */
  async list(
    ctx: HouseholdContext,
    lens: Lens,
    include: 'open' | 'closed',
    window?: WindowParams,
  ): Promise<Account[]> {
    return this.scope.run(ctx, async (tx) => {
      const scoped = await moneyScope(tx, ctx, lens);
      if (scoped.size === 0) return [];
      // In the caller's own order (#48): their groups, then what they placed in a type's section,
      // then the household's order. Row-level security joins only their own placements.
      const rows = await tx
        .select(getTableColumns(accounts))
        .from(accounts)
        .leftJoin(accountPlacements, eq(accountPlacements.accountId, accounts.id))
        .leftJoin(accountGroups, eq(accountGroups.id, accountPlacements.groupId))
        .where(
          and(
            inArray(accounts.id, [...scoped.keys()]),
            include === 'open' ? isNull(accounts.closedAt) : undefined,
          ),
        )
        .orderBy(
          sql`${accountGroups.sortOrder} ASC NULLS LAST`,
          sql`${accountPlacements.sortOrder} ASC NULLS LAST`,
          asc(accounts.sortOrder),
          asc(accounts.name),
        );
      const levels = new Map([...scoped].map(([id, s]) => [id, s.level]));
      const list = await this.#present(tx, ctx, rows, levels);
      if (!window) return list;
      const changes = await this.#changes(
        tx,
        ctx,
        window,
        rows.map((r) => r.id),
      );
      return list.map((a) => ({ ...a, change: changes.get(a.id) ?? null }));
    });
  }

  /**
   * Each account's change over the window: its balance at the end, less the one in effect at the
   * start (or its first balance inside the window, for an account that began during it).
   */
  async #changes(tx: Executor, ctx: HouseholdContext, window: WindowParams, ids: string[]) {
    const out = new Map<string, { amountMinor: number; from: string; to: string }>();
    if (ids.length === 0) return out;
    const { from, to } = await this.#window(tx, ctx, window);
    const { rows } = await tx.execute<{
      id: string;
      end_minor: string;
      start_minor: string;
      start_date: string;
    }>(sql`
      SELECT a.id, e.balance_minor AS end_minor,
             coalesce(o.balance_minor, f.balance_minor) AS start_minor,
             CASE WHEN o.balance_minor IS NOT NULL THEN ${from}::date ELSE f.as_of END::text AS start_date
      FROM unnest(${sql.param(ids)}::uuid[]) AS a(id)
      JOIN LATERAL (
        SELECT b.balance_minor FROM balance_snapshots b
        WHERE b.account_id = a.id AND b.as_of <= ${to}::date ORDER BY b.as_of DESC LIMIT 1
      ) e ON true
      LEFT JOIN LATERAL (
        SELECT b.balance_minor FROM balance_snapshots b
        WHERE b.account_id = a.id AND b.as_of <= ${from}::date ORDER BY b.as_of DESC LIMIT 1
      ) o ON true
      LEFT JOIN LATERAL (
        SELECT b.balance_minor, b.as_of FROM balance_snapshots b
        WHERE b.account_id = a.id AND b.as_of > ${from}::date AND b.as_of <= ${to}::date
        ORDER BY b.as_of ASC LIMIT 1
      ) f ON true`);
    for (const r of rows) {
      out.set(r.id, {
        amountMinor: Number(r.end_minor) - Number(r.start_minor),
        from: r.start_date,
        to,
      });
    }
    return out;
  }

  async get(ctx: HouseholdContext, accountId: string): Promise<Account> {
    return this.scope.run(ctx, async (tx) => {
      const levels = await accessLevels(tx);
      if (!levels.has(accountId)) throw problems.notFound();
      const rows = await tx.select().from(accounts).where(eq(accounts.id, accountId));
      const [account] = await this.#present(tx, ctx, rows, levels);
      if (!account) throw problems.notFound();
      // Card details are for owners and full access (#86): below that, not even whether there are
      // any (row-level security hides the row too).
      if (account.yourAccess === 'owner' || account.yourAccess === 'full') {
        const [l] = await tx
          .select()
          .from(accountLiabilities)
          .where(eq(accountLiabilities.accountId, accountId));
        account.liabilities = l
          ? {
              aprBps: l.aprBps,
              minimumPaymentMinor: l.minimumPaymentMinor,
              nextDueDate: l.nextDueDate,
              lastStatementBalanceMinor: l.lastStatementBalanceMinor,
              lastStatementDate: l.lastStatementDate,
              updatedAt: l.updatedAt.toISOString(),
            }
          : null;
      }
      return account;
    });
  }

  async create(ctx: HouseholdContext, input: CreateInput): Promise<Account> {
    return this.scope.run(ctx, async (tx, activity) => {
      const id = await this.createWithin(tx, activity, ctx, input);
      const levels = await accessLevels(tx);
      const rows = await tx.select().from(accounts).where(eq(accounts.id, id));
      return (await this.#present(tx, ctx, rows, levels))[0]!;
    });
  }

  /** Adds an account inside the caller's transaction (also used by imports). Returns its id. */
  async createWithin(
    tx: Executor,
    activity: HouseholdActivity,
    ctx: HouseholdContext,
    input: CreateInput,
  ): Promise<string> {
    const id = uuidv7();
    const hh = await this.#household(tx, ctx);
    const owners = this.#resolveOwners(
      input.owners ??
        (hh.financeStyle === 'combined'
          ? [...hh.owners].map((memberId) => ({ memberId }))
          : [{ memberId: ctx.memberId }]),
      hh,
    );
    if (!owners.some((o) => o.memberId === ctx.memberId)) {
      throw new Problem(
        422,
        'must_own',
        'You can only add accounts you own or co-own',
        'Include yourself as an owner.',
      );
    }
    const visibility = input.visibility ?? STYLE_VISIBILITY[hh.financeStyle] ?? 'full';
    if (visibility === 'private' && owners.length >= 2 && hh.activeMembers === 2) {
      throw privateJointDisallowed();
    }
    const today = todayIn(hh.timezone);
    if (input.openingBalance?.asOf && input.openingBalance.asOf > today) throw futureDate();

    // No RETURNING: the account isn't visible until its owners exist (RLS, migration 0010).
    await tx.insert(accounts).values({
      id,
      householdId: ctx.householdId,
      name: input.name,
      type: input.type,
      subtype: input.subtype ?? null,
      currency: input.currency ?? hh.baseCurrency,
      maskLast4: input.mask ?? null,
      visibility,
      balanceMode: input.balanceMode ?? DEFAULT_BALANCE_MODE[input.type],
      includeInNetWorth: input.includeInNetWorth ?? true,
      isBusiness: input.isBusiness ?? false,
      notesEnc: input.notes ? await this.#encryptNotes(ctx, id, input.notes) : null,
    });
    await tx
      .insert(accountOwners)
      .values(owners.map((o) => ({ accountId: id, householdId: ctx.householdId, ...o })));
    if (input.openingBalance) {
      await tx.insert(balanceSnapshots).values({
        accountId: id,
        householdId: ctx.householdId,
        asOf: input.openingBalance.asOf ?? today,
        balanceMinor: input.openingBalance.amountMinor,
        source: 'manual',
      });
    }
    await activity.record({
      action: 'account.created',
      targetType: 'account',
      targetId: id,
      accountId: id,
      metadata: { type: input.type, visibility, owners: owners.map((o) => o.memberId) },
      changes: { after: { name: input.name } },
    });
    return id;
  }

  /** ACC-06/07/11: owners edit, field-level first save wins (API conventions §8). */
  async update(
    ctx: HouseholdContext,
    accountId: string,
    baseVersion: number,
    patch: UpdateInput,
  ): Promise<Account> {
    return this.scope.run(ctx, async (tx, activity) => {
      const levels = await accessLevels(tx);
      const level = levels.get(accountId);
      if (level !== 'owner') throw notVisibleOrForbidden(level);
      const [row] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .for('update');
      if (!row) throw problems.notFound();

      const current: Record<keyof UpdateInput, unknown> = {
        name: row.name,
        subtype: row.subtype,
        visibility: row.visibility,
        balanceMode: row.balanceMode,
        includeInNetWorth: row.includeInNetWorth,
        isBusiness: row.isBusiness,
        sortOrder: row.sortOrder,
        mask: row.maskLast4,
        notes: row.notesEnc ? await this.#decryptNotes(ctx, row.id, row.notesEnc) : null,
      };
      const plan = planVersionedPatch(
        current,
        { version: row.version, fieldVersions: row.fieldVersions },
        baseVersion,
        patch,
      );
      if (!plan.ok) {
        const [present] = await this.#present(tx, ctx, [row], levels);
        throw new Problem(
          409,
          'edit_conflict',
          'Someone else changed this first',
          'Reload to see their changes, then apply yours again if still needed.',
          undefined,
          {},
          { conflicts: plan.conflicts, current: present },
        );
      }
      const changes = plan.changes as Partial<UpdateInput>;
      const changed = Object.keys(changes);
      if (changed.length === 0) return (await this.#present(tx, ctx, [row], levels))[0]!;

      if (changes.visibility === 'private') {
        const hh = await this.#household(tx, ctx);
        const ownerCount = (await this.#owners(tx, [accountId])).get(accountId)?.length ?? 0;
        if (ownerCount >= 2 && hh.activeMembers === 2) throw privateJointDisallowed();
      }

      const { mask, notes, ...columns } = changes;
      await tx
        .update(accounts)
        .set({
          ...columns,
          ...(mask !== undefined ? { maskLast4: mask } : {}),
          ...(notes !== undefined
            ? { notesEnc: notes ? await this.#encryptNotes(ctx, accountId, notes) : null }
            : {}),
          version: plan.next.version,
          fieldVersions: plan.next.fieldVersions,
        })
        .where(and(eq(accounts.id, accountId), eq(accounts.version, row.version)));
      if (changes.balanceMode !== undefined) await recomputeBalances(tx, accountId);
      await activity.record({
        action: 'account.updated',
        targetType: 'account',
        targetId: accountId,
        accountId,
        metadata: { fields: changed },
        changes: {
          before: Object.fromEntries(changed.map((k) => [k, current[k as keyof typeof current]])),
          after: changes,
        },
      });
      const [updated] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
      return (await this.#present(tx, ctx, [updated!], await accessLevels(tx)))[0]!;
    });
  }

  /**
   * ACC-08: owners change who owns an account and in what shares. You can remove yourself, never
   * another co-owner (ADR 0012), and at least one owner remains.
   */
  async setOwners(
    ctx: HouseholdContext,
    accountId: string,
    input: OwnersInput,
    from?: OwnersFrom,
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const level = (await accessLevels(tx)).get(accountId);
      if (level !== 'owner') throw notVisibleOrForbidden(level);
      const [row] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .for('update');
      if (!row) throw problems.notFound();
      const hh = await this.#household(tx, ctx);
      const before = (await this.#owners(tx, [accountId])).get(accountId) ?? [];
      const after = this.#resolveOwners(input, hh);

      const removed = before.filter((o) => !after.some((a) => a.memberId === o.memberId));
      if (removed.some((o) => o.memberId !== ctx.memberId)) {
        throw new Problem(
          403,
          'remove_other_owner',
          'You can only remove yourself as an owner',
          'Co-owners leave an account themselves (or through the departure flow).',
        );
      }
      if (row.visibility === 'private' && after.length >= 2 && hh.activeMembers === 2) {
        throw privateJointDisallowed();
      }

      const effective = from ?? ownersFromDefault(hh.financeStyle);
      await replaceOwners(tx, {
        householdId: ctx.householdId,
        accountId,
        before,
        after,
        from: effective,
        today: todayIn(hh.timezone),
      });
      await activity.record({
        action: 'account.owners_changed',
        targetType: 'account',
        targetId: accountId,
        accountId,
        metadata: {
          added: after
            .filter((a) => !before.some((b) => b.memberId === a.memberId))
            .map((a) => a.memberId),
          removed: removed.map((o) => o.memberId),
          from: effective,
        },
        changes: { before: { owners: before }, after: { owners: after } },
      });
    });
  }

  /**
   * "Make all accounts joint" (ADR 0006 §8, #225): every account you own becomes owned by every
   * member who can own accounts, in equal shares, with full visibility. Only yours (ACC-08):
   * others make theirs joint themselves. Accounts already like that are left alone.
   */
  async makeJoint(ctx: HouseholdContext, from?: OwnersFrom): Promise<{ changed: number }> {
    return this.scope.run(ctx, async (tx, activity) => {
      if (ctx.role === 'viewer') throw problems.forbidden('Viewers don’t own accounts.');
      // First: a household you can't see is "not found", never "nothing to change".
      const hh = await this.#household(tx, ctx);
      const mine = [...(await accessLevels(tx))]
        .filter(([, level]) => level === 'owner')
        .map(([id]) => id);
      if (mine.length === 0) return { changed: 0 };
      const everyone = this.#resolveOwners(
        [...hh.owners].map((memberId) => ({ memberId })),
        hh,
      );
      const rows = await tx
        .select({ id: accounts.id, visibility: accounts.visibility })
        .from(accounts)
        .where(inArray(accounts.id, mine))
        .for('update');
      const owners = await this.#owners(tx, mine);
      let changed = 0;
      for (const row of rows) {
        const before = owners.get(row.id) ?? [];
        const joint =
          before.length === everyone.length &&
          everyone.every((e) => before.some((b) => b.memberId === e.memberId));
        if (joint && row.visibility === 'full') continue;
        if (!joint) {
          await replaceOwners(tx, {
            householdId: ctx.householdId,
            accountId: row.id,
            before,
            after: everyone,
            from: from ?? ownersFromDefault(hh.financeStyle),
            today: todayIn(hh.timezone),
          });
        }
        if (row.visibility !== 'full') {
          await tx
            .update(accounts)
            .set({ visibility: 'full', version: sql`${accounts.version} + 1` })
            .where(eq(accounts.id, row.id));
        }
        await activity.record({
          action: 'account.made_joint',
          targetType: 'account',
          targetId: row.id,
          accountId: row.id,
          metadata: {
            added: everyone
              .filter((e) => !before.some((b) => b.memberId === e.memberId))
              .map((e) => e.memberId),
            visibility: row.visibility === 'full' ? null : 'full',
            from: joint ? null : (from ?? ownersFromDefault(hh.financeStyle)),
          },
          changes: {
            before: { owners: before, visibility: row.visibility },
            after: { owners: everyone, visibility: 'full' },
          },
        });
        changed++;
      }
      return { changed };
    });
  }

  /** ACC-09: close (history kept) or reopen. */
  async setClosed(ctx: HouseholdContext, accountId: string, closed: boolean): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const level = (await accessLevels(tx)).get(accountId);
      if (level !== 'owner') throw notVisibleOrForbidden(level);
      const [row] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
      if (!row || (row.closedAt !== null) === closed) return; // already in that state
      await tx
        .update(accounts)
        .set({ closedAt: closed ? new Date() : null, version: row.version + 1 })
        .where(eq(accounts.id, accountId));
      await activity.record({
        action: closed ? 'account.closed' : 'account.reopened',
        targetType: 'account',
        targetId: accountId,
        accountId,
      });
    });
  }

  /** Balances in the window; with `opening`, led by the one in effect when it opens (#353). */
  async balances(
    ctx: HouseholdContext,
    accountId: string,
    window: WindowParams & { opening?: 'true' | 'false' },
  ): Promise<BalancePoint[]> {
    return this.scope.run(ctx, async (tx) => {
      if (!(await accessLevels(tx)).has(accountId)) throw problems.notFound();
      const { from, to } = await this.#window(tx, ctx, window);
      const rows = await tx
        .select()
        .from(balanceSnapshots)
        .where(
          and(
            eq(balanceSnapshots.accountId, accountId),
            gte(balanceSnapshots.asOf, from),
            lte(balanceSnapshots.asOf, to),
          ),
        )
        .orderBy(asc(balanceSnapshots.asOf));
      if (window.opening === 'true' && rows[0]?.asOf !== from) {
        const [before] = await tx
          .select()
          .from(balanceSnapshots)
          .where(and(eq(balanceSnapshots.accountId, accountId), lt(balanceSnapshots.asOf, from)))
          .orderBy(desc(balanceSnapshots.asOf))
          .limit(1);
        if (before) rows.unshift({ ...before, asOf: from });
      }
      return rows.map((r) => ({
        asOf: r.asOf,
        amountMinor: r.balanceMinor,
        availableMinor: r.availableMinor,
        creditLimitMinor: r.creditLimitMinor,
        source: r.source,
      }));
    });
  }

  /** Owners set the balance for a day; setting the same day again replaces it. */
  async setBalance(
    ctx: HouseholdContext,
    accountId: string,
    asOf: string,
    input: BalanceInput,
  ): Promise<BalancePoint> {
    return this.scope.run(ctx, async (tx, activity) => {
      const level = (await accessLevels(tx)).get(accountId);
      if (level !== 'owner') throw notVisibleOrForbidden(level);
      const hh = await this.#household(tx, ctx);
      if (asOf > todayIn(hh.timezone)) throw futureDate();
      const [previous] = await tx
        .select()
        .from(balanceSnapshots)
        .where(and(eq(balanceSnapshots.accountId, accountId), eq(balanceSnapshots.asOf, asOf)));
      const values = {
        balanceMinor: input.amountMinor,
        availableMinor: input.availableMinor ?? null,
        creditLimitMinor: input.creditLimitMinor ?? null,
        source: 'manual' as const,
      };
      await tx
        .insert(balanceSnapshots)
        .values({ accountId, householdId: ctx.householdId, asOf, ...values })
        .onConflictDoUpdate({
          target: [balanceSnapshots.accountId, balanceSnapshots.asOf],
          set: { ...values, updatedAt: new Date() },
        });
      // An entered balance is an anchor: days around it are recomputed (transactions design §2).
      await recomputeBalances(tx, accountId);
      await activity.record({
        action: 'account.balance_set',
        targetType: 'account',
        targetId: accountId,
        accountId,
        metadata: { asOf },
        changes: {
          before: previous ? { amountMinor: previous.balanceMinor } : {},
          after: { amountMinor: input.amountMinor },
        },
      });
      return {
        asOf,
        amountMinor: values.balanceMinor,
        availableMinor: values.availableMinor,
        creditLimitMinor: values.creditLimitMinor,
        source: 'manual',
      };
    });
  }

  /**
   * Net worth "visible to you" (F3) under a lens: current assets and liabilities, plus a daily
   * series that carries each account's last balance forward (ADR 0011). Accounts in other
   * currencies are reported, not converted, until #43.
   */
  async netWorth(ctx: HouseholdContext, lens: Lens, window: WindowParams): Promise<NetWorth> {
    return this.scope.run(ctx, async (tx) => {
      const hh = await this.#household(tx, ctx);
      const { from, to, resolved, ranges } = await this.#window(tx, ctx, window);
      const scoped = await moneyScope(tx, ctx, lens);
      const rows =
        scoped.size === 0
          ? []
          : await tx
              .select({ id: accounts.id, currency: accounts.currency })
              .from(accounts)
              .where(
                and(inArray(accounts.id, [...scoped.keys()]), eq(accounts.includeInNetWorth, true)),
              );

      const unconverted = new Map<string, number>();
      const counted: { id: string; bps: number }[] = [];
      for (const r of rows) {
        if (r.currency === hh.baseCurrency)
          counted.push({ id: r.id, bps: scoped.get(r.id)!.weightBps });
        else unconverted.set(r.currency, (unconverted.get(r.currency) ?? 0) + 1);
      }

      const ids = counted.map((c) => c.id);
      const bps = counted.map((c) => c.bps);
      const today = todayIn(hh.timezone);

      // Each account's weighted balance on `day`, carried forward from its last snapshot. Closed
      // accounts stop counting from the day they were closed.
      const weighted = (day: string) => sql`
        SELECT w.account_id,
               round(s.balance_minor::numeric * w.bps / 10000)::bigint AS amount
        FROM unnest(${sql.param(ids)}::uuid[], ${sql.param(bps)}::int[]) AS w(account_id, bps)
        JOIN accounts a ON a.id = w.account_id
        JOIN LATERAL (
          SELECT b.balance_minor FROM balance_snapshots b
          WHERE b.account_id = w.account_id AND b.as_of <= ${day}::date
          ORDER BY b.as_of DESC LIMIT 1
        ) s ON true
        WHERE a.closed_at IS NULL OR ${day}::date < (a.closed_at AT TIME ZONE ${hh.timezone})::date`;

      let assets = 0n;
      let liabilities = 0n;
      if (ids.length) {
        const { rows: current } = await tx.execute<{ amount: string }>(weighted(today));
        for (const r of current) {
          const amount = BigInt(r.amount);
          if (amount >= 0n) assets += amount;
          else liabilities -= amount;
        }
      }

      // One point per bucket, valued at the bucket's end (ADR 0011 §3: the last snapshot per bucket).
      const bucketsFor = (r: { from: string; to: string; periodEnd: string }) =>
        resolved
          ? buckets(r, resolved.granularity, ranges.settings, ranges.today)
          : dayBuckets(r.from, r.to);
      const valueAt = async (ends: string[]) => {
        const out = new Map<string, bigint>(ends.map((e) => [e, 0n]));
        if (!ids.length || !ends.length) return out;
        const { rows: points } = await tx.execute<{ day: string; net: string }>(sql`
          SELECT d.day::text AS day,
                 coalesce(sum(round(s.balance_minor::numeric * w.bps / 10000)), 0)::bigint AS net
          FROM unnest(${sql.param(ends)}::date[]) AS d(day)
          CROSS JOIN unnest(${sql.param(ids)}::uuid[], ${sql.param(bps)}::int[]) AS w(account_id, bps)
          JOIN accounts a ON a.id = w.account_id
          JOIN LATERAL (
            SELECT b.balance_minor FROM balance_snapshots b
            WHERE b.account_id = w.account_id AND b.as_of <= d.day
            ORDER BY b.as_of DESC LIMIT 1
          ) s ON true
          WHERE a.closed_at IS NULL OR d.day < (a.closed_at AT TIME ZONE ${hh.timezone})::date
          GROUP BY d.day`);
        for (const p of points) out.set(p.day, BigInt(p.net));
        return out;
      };
      const seriesFor = async (r: { from: string; to: string; periodEnd: string }) => {
        const bs = bucketsFor(r);
        const values = await valueAt(bs.map((b) => b.end));
        return bs.map((b) => ({
          start: b.start,
          end: b.end,
          partial: b.partial,
          net: values.get(b.end)!,
        }));
      };
      const series = await seriesFor({ from, to, periodEnd: resolved?.range.periodEnd ?? to });
      const comparisonSeries = resolved?.comparison
        ? await seriesFor(resolved.comparison)
        : undefined;

      const safe = (n: bigint) => {
        if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Problem(422, 'amount_too_large', 'Total is too large to report');
        }
        return Number(n);
      };
      return {
        currency: hh.baseCurrency,
        assetsMinor: safe(assets),
        liabilitiesMinor: safe(liabilities),
        netWorthMinor: safe(assets - liabilities),
        series: series.map((p) => ({
          date: p.end,
          start: p.start,
          netWorthMinor: safe(p.net),
          partial: p.partial,
        })),
        ...(comparisonSeries
          ? {
              comparisonSeries: comparisonSeries.map((p) => ({
                date: p.end,
                start: p.start,
                netWorthMinor: safe(p.net),
                partial: p.partial,
              })),
            }
          : {}),
        range: resolved?.meta ?? { from, to, periodEnd: to, partial: false, granularity: 'day' },
        unconverted: [...unconverted].map(([currency, count]) => ({ currency, accounts: count })),
      };
    });
  }

  /**
   * The dates a request covers: a `range` (preset or custom) resolved for the household (ADR
   * 0011), or plain `from`/`to` (default: the last 365 days).
   */
  async #window(tx: Executor, ctx: HouseholdContext, window: WindowParams) {
    const ranges = await householdRanges(tx, ctx.householdId);
    const earliest = window.range === 'all_time' ? await this.#earliestBalance(tx) : undefined;
    const resolved = resolveParams(window, ranges, earliest);
    if (resolved) return { from: resolved.range.from, to: resolved.range.to, resolved, ranges };
    const to = window.to ?? ranges.today;
    const from = window.from ?? addDays(to, -364);
    if (daysBetween(from, to) > MAX_WINDOW_DAYS) {
      throw new Problem(422, 'window_too_long', 'Choose a period of 10 years or less');
    }
    return { from, to, resolved: null, ranges };
  }

  async #earliestBalance(tx: Executor): Promise<string | undefined> {
    const { rows } = await tx.execute<{ d: string | null }>(
      sql`SELECT min(as_of)::text AS d FROM balance_snapshots`,
    );
    return rows[0]?.d ?? undefined;
  }

  #householdCache = new WeakMap<Executor, Promise<HouseholdInfo>>();

  #household(tx: Executor, ctx: HouseholdContext): Promise<HouseholdInfo> {
    let info = this.#householdCache.get(tx);
    if (!info) {
      info = (async () => {
        const [h] = await tx
          .select({
            baseCurrency: households.baseCurrency,
            timezone: households.timezone,
            financeStyle: households.financeStyle,
          })
          .from(households)
          .where(eq(households.id, ctx.householdId));
        if (!h) throw problems.notFound();
        const members = await tx
          .select({ id: householdMembers.id, role: householdMembers.role })
          .from(householdMembers)
          .where(
            and(eq(householdMembers.householdId, ctx.householdId), isNull(householdMembers.leftAt)),
          );
        return {
          ...h,
          owners: new Set(members.filter((m) => m.role !== 'viewer').map((m) => m.id)),
          activeMembers: members.length,
        };
      })();
      this.#householdCache.set(tx, info);
    }
    return info;
  }

  /** Validates owners (active, non-viewer members) and fills in equal shares if none given. */
  #resolveOwners(input: OwnersInput, hh: HouseholdInfo): { memberId: string; shareBps: number }[] {
    const invalid = input.filter((o) => !hh.owners.has(o.memberId));
    if (invalid.length) {
      throw new Problem(
        422,
        'invalid_owner',
        'Owners must be current members who aren’t viewers',
        undefined,
        invalid.map((o) => ({ path: 'owners', code: 'invalid_owner', message: o.memberId })),
      );
    }
    const shares = input[0]?.shareBps === undefined ? equalShares(input.length) : undefined;
    return input.map((o, i) => ({
      memberId: o.memberId,
      shareBps: shares ? shares[i]! : o.shareBps!,
    }));
  }

  async #owners(tx: Executor, ids: string[]) {
    const out = new Map<string, { memberId: string; shareBps: number }[]>();
    if (ids.length === 0) return out;
    for (const o of await tx
      .select()
      .from(accountOwners)
      .where(inArray(accountOwners.accountId, ids))
      .orderBy(desc(accountOwners.shareBps), asc(accountOwners.memberId))) {
      const list = out.get(o.accountId) ?? [];
      list.push({ memberId: o.memberId, shareBps: o.shareBps });
      out.set(o.accountId, list);
    }
    return out;
  }

  async #present(
    tx: Executor,
    ctx: HouseholdContext,
    rows: AccountRow[],
    levels: Map<string, AccessLevel>,
  ): Promise<Account[]> {
    const ids = rows.map((r) => r.id);
    const owners = await this.#owners(tx, ids);
    // The latest balance; for a bank-connected account, the bank's last reported one, so a broken
    // connection shows its date rather than a fresh-looking balance (D12, #86).
    const latest = new Map<string, { amountMinor: number; asOf: string }>();
    if (ids.length) {
      const { rows: balances } = await tx.execute<{
        account_id: string;
        as_of: string;
        balance_minor: string;
      }>(sql`
        SELECT DISTINCT ON (b.account_id) b.account_id, b.as_of::text AS as_of, b.balance_minor
        FROM balance_snapshots b JOIN accounts a ON a.id = b.account_id
        WHERE b.account_id = ANY(${sql.param(ids)}::uuid[])
          AND (a.connection_id IS NULL OR b.source = 'provider' OR NOT EXISTS (
            SELECT 1 FROM balance_snapshots p
            WHERE p.account_id = b.account_id AND p.source = 'provider'))
        ORDER BY b.account_id, b.as_of DESC`);
      for (const b of balances) {
        latest.set(b.account_id, { amountMinor: Number(b.balance_minor), asOf: b.as_of });
      }
    }
    return Promise.all(
      rows.map(async (r): Promise<Account> => {
        const level = levels.get(r.id)!;
        return {
          id: r.id,
          name: r.name,
          type: r.type,
          subtype: r.subtype,
          currency: r.currency,
          mask: r.maskLast4,
          visibility: r.visibility,
          balanceMode: r.balanceMode,
          includeInNetWorth: r.includeInNetWorth,
          isBusiness: r.isBusiness,
          sortOrder: r.sortOrder,
          closedAt: r.closedAt?.toISOString() ?? null,
          owners: owners.get(r.id) ?? [],
          yourAccess: level,
          balance: latest.get(r.id) ?? null,
          // Account notes need view_only or above (permissions §3).
          ...(level !== 'balance_only'
            ? { notes: r.notesEnc ? await this.#decryptNotes(ctx, r.id, r.notesEnc) : null }
            : {}),
          version: r.version,
        };
      }),
    );
  }

  #notesContext(ctx: HouseholdContext, accountId: string) {
    return {
      householdId: ctx.householdId,
      table: 'accounts',
      column: 'notes_enc',
      rowId: accountId,
    };
  }

  #encryptNotes(ctx: HouseholdContext, accountId: string, notes: string) {
    return this.crypto.encrypt(this.#notesContext(ctx, accountId), notes);
  }

  #decryptNotes(ctx: HouseholdContext, accountId: string, notes: Buffer) {
    return this.crypto.decrypt(this.#notesContext(ctx, accountId), notes);
  }
}
