// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BulkUpdateResult, CategoryGroup, HouseholdMember, Transaction } from '@fiscus/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { transferReviewQuery } from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import {
  Alert,
  Button,
  Checkbox,
  DateText,
  LoadingRegion,
  Skeleton,
  toast,
} from '../components/ui.js';
import { CategorySelect, TransactionDrawer, useInvalidateLedger } from './transactions.js';

type Data<T> = { data: T };

const accountOf = (t: Transaction) => t.account?.name ?? 'another account';

/** What this check is for: a reconciliation, so nothing falls through the cracks. */
function WhyTransfers() {
  return (
    <section
      aria-labelledby="why-transfers"
      className="space-y-1 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm"
    >
      <h2 id="why-transfers" className="font-semibold">
        Why check transfers?
      </h2>
      <p className="text-muted">
        Money moving between your own accounts isn’t spending or income, so transfers are left out
        of your totals. That only works when each one really is a transfer. This check reconciles
        them: every transfer should have its other side, the same amount arriving in another of your
        accounts, or go to an account you don’t track here.
      </p>
      <p className="text-muted">
        One with no other side is worth a look: the money may not have arrived, or it may be
        spending filed as a transfer (a payment to a friend, someone else’s card), which quietly
        drops out of what you spent.
      </p>
    </section>
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
  const invalidate = useInvalidateLedger(householdId);
  const base = `/api/v1/households/${householdId}/transactions`;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const onError = async (e: unknown) => {
    toast((e as ApiError).title, { tone: 'error' });
    await invalidate();
  };

  const link = useMutation({
    mutationFn: ({ out, into }: { out: string; into: string }) =>
      api('POST', `${base}/${out}/transfer`, { body: { transactionId: into } }),
    onSuccess: async () => {
      await invalidate();
      toast('Linked as a transfer.');
    },
    onError,
  });
  const linkAll = useMutation({
    mutationFn: () => api<Data<{ linked: number }>>('POST', `${base}/transfer-review/link-all`),
    onSuccess: async (r) => {
      await invalidate();
      toast(`${r.data.linked} ${r.data.linked === 1 ? 'transfer' : 'transfers'} linked.`);
    },
    onError,
  });
  const patch = useMutation({
    mutationFn: ({ t, body }: { t: Transaction; body: Record<string, unknown> }) =>
      api('PATCH', `${base}/${t.id}`, { body, headers: { 'if-match': `"v${t.version}"` } }),
    onSuccess: () => invalidate(),
    onError,
  });
  const external = useMutation({
    mutationFn: (ids: string[]) =>
      api<Data<BulkUpdateResult>>('PATCH', base, {
        body: { ids, changes: { transferExternal: true } },
      }),
    onSuccess: async (r) => {
      setSelected(new Set());
      await invalidate();
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
                Link all {counts.unique} with one match
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted">
            Money out of one account and the same amount into another, too far apart or with more
            than one match to link on their own.
          </p>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
            {suggested.map(({ transaction: out, candidates }) => (
              <li key={out.id} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{out.displayName}</span>
                    <span className="block text-xs text-muted">
                      <DateText value={out.date} /> · {accountOf(out)}
                    </span>
                  </span>
                  <Amount minor={out.amountMinor} currency={out.currency} />
                </div>
                <ul aria-label={`Possible other sides of ${out.displayName}`} className="space-y-1">
                  {candidates.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center gap-x-3 rounded-lg bg-surface-2 px-3 py-1.5 text-sm"
                    >
                      <ArrowRight aria-hidden className="size-4 text-muted" />
                      <span className="min-w-0 flex-1">
                        {accountOf(c)}
                        <span className="text-muted">
                          {' '}
                          · <DateText value={c.date} /> · {c.displayName}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Link ${out.displayName} to ${accountOf(c)} on ${c.date}`}
                        onPress={() => link.mutate({ out: out.id, into: c.id })}
                        isPending={link.isPending && link.variables?.into === c.id}
                      >
                        Link
                      </Button>
                    </li>
                  ))}
                </ul>
              </li>
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
