// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import {
  activityTransactions,
  auditEvents,
  householdMembers,
  rules,
  transactions,
} from '@fiscus/db';
import type {
  TransactionFieldChange,
  TransactionHistoryActor,
  TransactionHistoryEntry,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

/** The newest entries a history shows: far more than any one transaction has. */
const HISTORY_LIMIT = 200;

type Event = typeof auditEvents.$inferSelect;
type Changes = { before?: Record<string, unknown>; after?: Record<string, unknown> };

/** Recorded as values only here: the field names a single edit may carry (transactions.service). */
const BULK_FIELDS = ['categoryId', 'reviewStatus', 'excluded', 'transferExternal'];

/**
 * A transaction's history (TXN-11, #46): the activity entries linked to it (activity_transactions),
 * newest first. Visible as in the household feed: the link needs the transaction to be visible
 * to you and the entry needs its account to be (row-level security), so a transaction you see
 * only because it's attributed to you shows nothing about the account it was paid from. Private
 * notes are their author's alone (visibleToHousehold false, so only the actor's own). Changes are
 * decrypted only for entries that pass, and only this transaction's part of them is returned.
 */
@Injectable()
export class TransactionHistoryService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
  ) {}

  async list(ctx: HouseholdContext, id: string): Promise<TransactionHistoryEntry[]> {
    return this.scope.run(ctx, async (tx) => {
      const [visible] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)));
      if (!visible) throw problems.notFound();

      const rows = await tx
        .select({ event: auditEvents })
        .from(activityTransactions)
        .innerJoin(
          auditEvents,
          and(
            eq(auditEvents.scopeId, activityTransactions.householdId),
            eq(auditEvents.seq, activityTransactions.seq),
          ),
        )
        .where(
          and(
            eq(activityTransactions.householdId, ctx.householdId),
            eq(activityTransactions.transactionId, id),
            eq(auditEvents.householdId, ctx.householdId),
            or(
              eq(auditEvents.visibleToHousehold, true),
              eq(auditEvents.actorMemberId, ctx.memberId),
            ),
          ),
        )
        .orderBy(desc(activityTransactions.seq))
        .limit(HISTORY_LIMIT);
      const events = rows.map((r) => r.event);

      const memberIds = [
        ...new Set(events.flatMap((e) => (e.actorMemberId ? [e.actorMemberId] : []))),
      ];
      const members = new Map(
        memberIds.length
          ? (
              await tx
                .select({ id: householdMembers.id, name: householdMembers.displayName })
                .from(householdMembers)
                .where(inArray(householdMembers.id, memberIds))
            ).map((m) => [m.id, m.name])
          : [],
      );

      const entries: { event: Event; changes: Changes | null }[] = [];
      for (const event of events) {
        entries.push({ event, changes: await this.#decrypt(ctx, event) });
      }
      const ruleIds = [...new Set(entries.flatMap((e) => this.#ruleIds(e.event, e.changes, id)))];
      const ruleNames = new Map(
        ruleIds.length
          ? (
              await tx
                .select({ id: rules.id, name: rules.name })
                .from(rules)
                .where(inArray(rules.id, ruleIds))
            ).map((r) => [r.id, r.name])
          : [],
      );

      return Promise.all(
        entries.map(async ({ event, changes }) => ({
          id: await this.#entryId(ctx, event.seq!),
          occurredAt: event.occurredAt.toISOString(),
          action: event.action,
          actor: this.#actor(event, changes, id, members, ruleNames),
          changes: this.#fieldChanges(event, changes, id),
          detail: this.#detail(event),
        })),
      );
    });
  }

  async #decrypt(ctx: HouseholdContext, event: Event): Promise<Changes | null> {
    if (!event.changesEnc) return null;
    return JSON.parse(
      await this.crypto.decrypt(
        {
          householdId: ctx.householdId,
          table: 'audit_events',
          column: 'changes_enc',
          rowId: `${ctx.householdId}:${event.seq}`,
        },
        event.changesEnc,
      ),
    ) as Changes;
  }

  /** This transaction's part of a rules event (engine.ts, recordRuleChanges). */
  #ruled(changes: Changes | null, id: string) {
    const byId = changes?.after?.byId as
      Record<string, { rules: string[]; changes: Record<string, [unknown, unknown]> }> | undefined;
    return byId?.[id];
  }

  #ruleIds(event: Event, changes: Changes | null, id: string): string[] {
    if (event.action === 'transaction.rules_applied') return this.#ruled(changes, id)?.rules ?? [];
    const rule = event.metadata.rule;
    return event.metadata.by === 'rule' && typeof rule === 'string' ? [rule] : [];
  }

  #actor(
    event: Event,
    changes: Changes | null,
    id: string,
    members: Map<string, string>,
    ruleNames: Map<string, string | null>,
  ): TransactionHistoryActor {
    const ruleIds = this.#ruleIds(event, changes, id);
    if (ruleIds.length || event.metadata.by === 'rule') {
      const list = ruleIds.map((r) => ({ id: r, name: ruleNames.get(r) ?? null }));
      const names = list.flatMap((r) => (r.name ? [r.name] : []));
      return {
        kind: 'rule',
        rules: list,
        label: names.length ? `Rule: ${names.join(', ')}` : 'A rule',
      };
    }
    if (event.action === 'import.rows_added') return { kind: 'import', label: 'Import' };
    // What sync wrote (#80), recorded as the system's for the connection's owner.
    if (
      event.action.startsWith('sync.') ||
      event.action.startsWith('transaction.provider_') ||
      event.action === 'transaction.posted'
    ) {
      return { kind: 'bank', label: 'Bank' };
    }
    // Linked by transfer detection, not by a person choosing the pair.
    if (event.action === 'transaction.transfer_linked' && event.metadata.automatic === true) {
      return { kind: 'system', label: 'Fiscus' };
    }
    if (!event.actorMemberId) {
      return event.actorKind === 'system'
        ? { kind: 'system', label: 'Fiscus' }
        : { kind: 'member', memberId: null, label: 'Someone' };
    }
    return {
      kind: 'member',
      memberId: event.actorMemberId,
      label: members.get(event.actorMemberId) ?? 'A former member',
    };
  }

  #fieldChanges(event: Event, changes: Changes | null, id: string): TransactionFieldChange[] {
    const before = changes?.before ?? {};
    const after = changes?.after ?? {};
    const tags = (v: unknown) =>
      typeof v === 'string' ? v.split(',').filter(Boolean) : (v ?? undefined);
    switch (event.action) {
      case 'transaction.created':
        return Object.entries(after).map(([field, to]) => ({ field, to }));
      // A posting (#88) shows what the bank changed as it posted, from what it was pending.
      case 'transaction.updated':
      case 'transaction.provider_updated':
      case 'transaction.posted': {
        const fields = (event.metadata.fields as string[] | undefined) ?? Object.keys(after);
        return fields.map((field) =>
          field === 'tagIds'
            ? { field, from: tags(before[field]), to: tags(after[field]) }
            : { field, from: before[field] ?? null, to: after[field] ?? null },
        );
      }
      case 'transaction.bulk_updated': {
        const out: TransactionFieldChange[] = [];
        const names = (side: Record<string, unknown>) =>
          (side.names as Record<string, string> | undefined)?.[id];
        if (event.metadata.via === 'name_cleanup') {
          const to = names(after);
          out.push(
            to === undefined
              ? { field: 'displayName' }
              : { field: 'displayName', from: names(before), to },
          );
        }
        for (const field of BULK_FIELDS) if (field in after) out.push({ field, to: after[field] });
        for (const field of ['addTagIds', 'removeTagIds']) {
          if ((after[field] as unknown[] | undefined)?.length)
            out.push({ field, to: after[field] });
        }
        return out;
      }
      case 'transaction.rules_applied':
        return Object.entries(this.#ruled(changes, id)?.changes ?? {}).map(([field, [from, to]]) =>
          // A rule only adds tags: `from` is what it had, `to` what the rule added.
          field === 'tagIds' ? { field: 'addTagIds', to } : { field, from, to },
        );
      case 'transaction.attribution_changed':
        return [{ field: 'attribution', from: before.attribution, to: after.attribution }];
      default:
        return [];
    }
  }

  #detail(event: Event): TransactionHistoryEntry['detail'] {
    const m = event.metadata;
    const detail: TransactionHistoryEntry['detail'] = {};
    if (event.action.startsWith('import.') && typeof m.format === 'string')
      detail.format = m.format;
    if (event.action === 'transaction.split' && typeof m.parts === 'number') detail.parts = m.parts;
    if (event.action === 'transaction.transfer_unlinked' && typeof m.cause === 'string') {
      detail.cause = m.cause;
    }
    // Into the account the event is about, which you can see; never where it came from.
    if (event.action === 'transaction.moved_in' && event.accountId) {
      detail.accountId = event.accountId;
    }
    if (
      ['transaction.bulk_updated', 'transaction.rules_applied'].includes(event.action) &&
      typeof m.count === 'number' &&
      m.count > 1
    ) {
      detail.bulk = true;
    }
    if (event.action === 'transaction.created' && m.by === 'rule') detail.otherSide = true;
    // The bank no longer has it, and it was yours first (D7): it stays, without the bank's id.
    if (event.action === 'transaction.provider_removed' && m.kept === true) detail.kept = true;
    return detail;
  }

  async #entryId(ctx: HouseholdContext, seq: number): Promise<string> {
    const context = {
      householdId: ctx.householdId,
      table: 'audit_events',
      column: 'history_id',
      rowId: ctx.memberId,
    };
    return (await this.crypto.encrypt(context, String(seq))).toString('base64url');
  }
}
