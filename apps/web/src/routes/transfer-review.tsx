// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BulkUpdateResult,
  CategoryGroup,
  HouseholdMember,
  Transaction,
  TransferReview,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCheck, Info, Link2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { transferReviewQuery } from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DateText,
  LoadingRegion,
  Skeleton,
  toast,
} from '../components/ui.js';
import { likelyOtherSide, withoutTransactions } from '../lib/transfers.js';
import { CategorySelect, TransactionDrawer, useInvalidateLedger } from './transactions.js';

type Data<T> = { data: T };

const accountOf = (t: Transaction) => t.account?.name ?? 'another account';

/** What this check is for: a reconciliation, so nothing falls through the cracks. */
function WhyTransfers() {
  return (
    <details className="group rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-sm">
      <summary className="cursor-pointer font-medium marker:text-muted">
        Why check transfers?
      </summary>
      <div className="mt-2 space-y-1 text-muted">
        <p>
          Money moving between your own accounts isn’t spending or income, so transfers are left out
          of your totals. That only works when each one really is a transfer: every transfer should
          have its other side, the same amount arriving in another of your accounts, or go to an
          account you don’t track here.
        </p>
        <p>
          One with no other side is worth a look: the money may not have arrived, or it may be
          spending filed as a transfer (a payment to a friend, someone else’s card), which quietly
          drops out of what you spent.
        </p>
      </div>
    </details>
  );
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const apart = (from: string, to: string) => {
  const d = daysBetween(from, to);
  if (d === 0) return 'same day';
  const n = Math.abs(d);
  return `${n} ${n === 1 ? 'day' : 'days'} ${d > 0 ? 'later' : 'earlier'}`;
};

type SuggestionData = TransferReview['suggested'][number];

/** Why a pair wasn't linked automatically, in words. */
function reasonText(
  { reason, transaction: out, candidates, rivals }: SuggestionData,
  likely: boolean,
): string {
  const first = candidates[0]!;
  switch (reason) {
    case 'identical':
      return `Identical transfers, like round-ups: any pairing is right, so “Link the clear pairs” takes them.`;
    case 'several':
      return likely
        ? `${candidates.length} possible matches, and the names point to the first. Linking one can settle others.`
        : `${candidates.length} possible matches: link the one that’s really the other side. Linking one can settle others.`;
    case 'rivals': {
      const r = rivals[0]!;
      const more = rivals.length > 1 ? ` and ${rivals.length - 1} more` : '';
      return `The only match, but it could also be the other side of ${accountOf(r)}’s ${r.displayName} (${formatDay(r.date)})${more}.`;
    }
    case 'far_apart':
      return `${Math.abs(daysBetween(out.date, first.date))} days apart, more than the 3 business days Fiscus links on its own.`;
    case 'one_match':
      return 'The only match either way, so “Link the clear pairs” takes it.';
  }
}

const formatDay = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Identical round-ups show once, with how many: same account, amount, day, and name going out,
 * and the same identical candidates. Linking one links one pair; "Link the clear pairs" takes all.
 */
function mergeIdentical(list: SuggestionData[]): { suggestion: SuggestionData; count: number }[] {
  const key = (x: SuggestionData) =>
    x.reason === 'identical'
      ? `${x.transaction.account?.id}|${x.transaction.date}|${x.transaction.amountMinor}|${x.transaction.displayName.toLowerCase()}`
      : x.transaction.id;
  return [...Map.groupBy(list, key).values()].map((group) => ({
    suggestion: group[0]!,
    count: group.length,
  }));
}

/** One side of a pair: which account, how much, and the transaction's name and date. */
function Side({
  t,
  label,
  note,
  badge,
}: {
  t: Transaction;
  label: 'From' | 'To';
  note?: string | undefined;
  badge?: ReactNode;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className="truncate font-medium">{accountOf(t)}</span>
        <Amount minor={t.amountMinor} currency={t.currency} className="ml-auto font-medium" />
      </span>
      <span className="block text-xs text-muted">
        {t.displayName} · <DateText value={t.date} />
        {note ? ` · ${note}` : ''}
      </span>
      {badge ? <span className="mt-1 block">{badge}</span> : null}
    </span>
  );
}

/**
 * A suggested pair: the money going out, each possible other side (identical ones shown once,
 * with how many), and why it wasn't linked automatically.
 */
function Suggestion({
  suggestion,
  count,
  onLink,
  linking,
}: {
  suggestion: SuggestionData;
  /** Identical transfers out shown as this one. */
  count: number;
  onLink: (into: string) => void;
  linking: string | null;
}) {
  const out = suggestion.transaction;
  const same = (c: Transaction) =>
    `${c.account?.id}|${c.date}|${c.amountMinor}|${c.displayName.toLowerCase()}`;
  const likely = likelyOtherSide(out, suggestion.candidates);
  // The likely one first; the rest keep their order (nearest date first).
  const groups = [...Map.groupBy(suggestion.candidates, same).values()].sort(
    (a, b) => Number(b[0]!.id === likely?.id) - Number(a[0]!.id === likely?.id),
  );
  return (
    <li className="space-y-2 rounded-xl border border-border bg-surface p-3">
      <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
        <Side t={out} label="From" note={count > 1 ? `×${count} identical` : undefined} />
      </div>
      <ul aria-label={`Possible other sides of ${out.displayName}`} className="space-y-2">
        {groups.map((group) => {
          const c = group[0]!;
          return (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <ArrowRight aria-hidden className="size-4 shrink-0 text-muted" />
              <Side
                t={c}
                label="To"
                note={`${apart(out.date, c.date)}${group.length > 1 ? ` · ×${group.length} identical` : ''}`}
                badge={
                  c.id === likely?.id ? (
                    <Badge tone="accent">Likely: names {likely.named}</Badge>
                  ) : undefined
                }
              />
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Link ${accountOf(out)} ${out.displayName} ${out.date} to ${accountOf(c)} ${c.displayName} ${c.date}`}
                onPress={() => onLink(c.id)}
                isPending={linking === c.id}
              >
                <Link2 aria-hidden className="size-4" /> Link
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="flex gap-1.5 text-xs text-muted">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {reasonText(suggestion, likely !== null)}
      </p>
    </li>
  );
}

/**
 * The transfer review (docs/design/transfers.md §2): pairs detection didn't link, to confirm, and
 * transfers with no other side, which are money in transit, a payment to an account outside
 * Fiscus, or spending filed as a transfer.
 */
export function TransferReviewList({
  householdId,
  members,
  groups,
}: {
  householdId: string;
  members: HouseholdMember[];
  groups: CategoryGroup[];
}) {
  const query = useQuery(transferReviewQuery(householdId));
  const queryClient = useQueryClient();
  const invalidateLedger = useInvalidateLedger(householdId);
  // Refetches in the background: the list has already changed (`drop`), and the refetch brings in
  // anything the change settled or unblocked.
  const invalidate = () => void invalidateLedger();
  /** Takes transactions off the list at once, without waiting for the review to be worked out. */
  const drop = async (ids: string[]) => {
    const key = transferReviewQuery(householdId).queryKey;
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData(key, (r) => (r ? withoutTransactions(r, new Set(ids)) : r));
  };
  const base = `/api/v1/households/${householdId}/transactions`;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const onError = (e: unknown) => {
    toast((e as ApiError).title, { tone: 'error' });
    invalidate();
  };

  const link = useMutation({
    mutationFn: ({ out, into }: { out: string; into: string }) =>
      api('POST', `${base}/${out}/transfer`, { body: { transactionId: into } }),
    onMutate: ({ out, into }) => drop([out, into]),
    onSuccess: () => {
      invalidate();
      toast('Linked as a transfer.');
    },
    onError,
  });
  const linkAll = useMutation({
    mutationFn: () => api<Data<{ linked: number }>>('POST', `${base}/transfer-review/link-all`),
    onSuccess: (r) => {
      invalidate();
      toast(`${r.data.linked} ${r.data.linked === 1 ? 'transfer' : 'transfers'} linked.`);
    },
    onError,
  });
  const patch = useMutation({
    mutationFn: ({ t, body }: { t: Transaction; body: Record<string, unknown> }) =>
      api('PATCH', `${base}/${t.id}`, { body, headers: { 'if-match': `"v${t.version}"` } }),
    // Outside Fiscus takes it off the list; a new category may too, which the refetch shows.
    onMutate: ({ t, body }) => (body.transferExternal ? drop([t.id]) : undefined),
    onSuccess: invalidate,
    onError,
  });
  const external = useMutation({
    mutationFn: (ids: string[]) =>
      api<Data<BulkUpdateResult>>('PATCH', base, {
        body: { ids, changes: { transferExternal: true } },
      }),
    onMutate: (ids) => drop(ids),
    onSuccess: (r) => {
      setSelected(new Set());
      invalidate();
      toast(`${r.data.updated.length} marked as going outside Fiscus.`);
    },
    onError,
  });

  if (query.isPending) {
    return (
      <LoadingRegion label="Checking transfers">
        <Skeleton className="h-32" />
      </LoadingRegion>
    );
  }
  if (query.isError) return <Alert>Couldn’t check transfers. Try again in a moment.</Alert>;
  const { suggested, unmatched, counts } = query.data;
  if (suggested.length === 0 && unmatched.length === 0) {
    return (
      <div className="space-y-6">
        <WhyTransfers />
        <EmptyState icon={CheckCheck} title="Transfers add up">
          <p>
            Every transfer between your accounts has its other side, or goes to an account outside
            Fiscus.
          </p>
        </EmptyState>
      </div>
    );
  }

  const allSelected = unmatched.length > 0 && unmatched.every((t) => selected.has(t.id));
  return (
    <div className="space-y-8">
      <WhyTransfers />
      {suggested.length ? (
        <section aria-labelledby="suggested-transfers" className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="suggested-transfers" className="mr-auto text-base font-semibold">
              Suggested pairs ({counts.suggested})
            </h2>
            {counts.unique ? (
              <Button
                variant="secondary"
                size="sm"
                onPress={() => linkAll.mutate()}
                isPending={linkAll.isPending}
              >
                Link the {counts.unique} clear {counts.unique === 1 ? 'pair' : 'pairs'}
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted">
            Money out of one account and the same amount into another that Fiscus didn’t link on its
            own. Why is under each.
          </p>
          <ul className="space-y-3">
            {mergeIdentical(suggested).map(({ suggestion: s, count }) => (
              <Suggestion
                key={s.transaction.id}
                suggestion={s}
                count={count}
                onLink={(into) => link.mutate({ out: s.transaction.id, into })}
                linking={link.isPending ? (link.variables?.into ?? null) : null}
              />
            ))}
          </ul>
          {counts.suggested > suggested.length ? (
            <p className="text-sm text-muted">
              Showing the latest {suggested.length}; link these to see more.
            </p>
          ) : null}
        </section>
      ) : null}

      {unmatched.length ? (
        <section aria-labelledby="unmatched-transfers" className="space-y-3">
          <h2 id="unmatched-transfers" className="text-base font-semibold">
            No other side ({counts.unmatched})
          </h2>
          <p className="text-sm text-muted">
            Filed as transfers, over a week old, with nothing coming into (or out of) another of
            your accounts. Either the other account isn’t in Fiscus, or it was really spending,
            which doesn’t count while it’s a transfer.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox
              isSelected={allSelected}
              isIndeterminate={selected.size > 0 && !allSelected}
              onChange={(on) => setSelected(on ? new Set(unmatched.map((t) => t.id)) : new Set())}
            >
              Select all shown
            </Checkbox>
            {selected.size ? (
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                onPress={() => external.mutate([...selected])}
                isPending={external.isPending}
              >
                {selected.size} go to accounts outside Fiscus
              </Button>
            ) : null}
          </div>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
            {unmatched.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <Checkbox
                  aria-label={`Select ${t.displayName}`}
                  isSelected={selected.has(t.id)}
                  onChange={(on) => {
                    const next = new Set(selected);
                    if (on) next.add(t.id);
                    else next.delete(t.id);
                    setSelected(next);
                  }}
                />
                <button
                  type="button"
                  onClick={() => setOpen(t.id)}
                  className="min-w-40 flex-1 text-left text-sm"
                >
                  <span className="font-medium">{t.displayName}</span>
                  <span className="block text-xs text-muted">
                    <DateText value={t.date} /> · {accountOf(t)}
                  </span>
                </button>
                <Amount minor={t.amountMinor} currency={t.currency} className="text-sm" />
                <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
                  <div className="w-48">
                    <CategorySelect
                      groups={groups}
                      label={`Recategorize ${t.displayName}`}
                      hideLabel
                      value={t.categoryId}
                      onChange={(categoryId) =>
                        categoryId !== t.categoryId && patch.mutate({ t, body: { categoryId } })
                      }
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => patch.mutate({ t, body: { transferExternal: true } })}
                  >
                    Outside Fiscus
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {open ? (
        <TransactionDrawer
          householdId={householdId}
          transactionId={open}
          members={members}
          groups={groups}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
