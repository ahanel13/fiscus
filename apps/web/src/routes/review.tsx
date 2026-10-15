// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BulkUpdateResult, Transaction } from '@fiscus/shared';
import { useInfiniteQuery, useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { CheckCheck, ClipboardCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  categoriesQuery,
  householdQuery,
  membersQuery,
  reviewCountQuery,
  transactionsQuery,
} from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import {
  Alert,
  Button,
  ButtonLink,
  Checkbox,
  DateText,
  Kbd,
  LoadingRegion,
  SegmentedControl,
  Skeleton,
  toast,
} from '../components/ui.js';
import { type SuggestedRule } from '../lib/rules.js';
import { typing } from '../lib/shortcuts.js';
import { categoryIndex } from '../lib/transactions.js';
import { RuleSuggestion } from './rules.js';
import { TransferReviewList } from './transfer-review.js';
import {
  CategorySelect,
  TransactionDetails,
  transferLabel,
  useInvalidateLedger,
} from './transactions.js';

type Data<T> = { data: T };

const KEYS: [string, string][] = [
  ['j', 'Next'],
  ['k', 'Previous'],
  ['c', 'Category'],
  ['r', 'Mark reviewed'],
  ['e', 'Exclude'],
];

/**
 * The review queue (#44, imports.md §4): what needs review, oldest first. One at a time with its
 * details open beside the list, or several at once with "Mark reviewed". Only transactions you
 * can categorize are here; the count on Transactions is the same set.
 */
export function ReviewPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const groups = useQuery(categoriesQuery(householdId)).data ?? [];
  const counts = useQuery(reviewCountQuery(householdId)).data;
  const { view: startOn } = useSearch({ strict: false }) as { view?: 'transfers' };
  const [view, setView] = useState<'transactions' | 'transfers'>(startOn ?? 'transactions');
  const invalidate = useInvalidateLedger(householdId);
  const query = useInfiniteQuery(
    transactionsQuery(householdId, { lens: 'all', review: 'needs_review', order: 'oldest' }),
  );
  const items = useMemo(
    () => (query.data?.pages.flatMap((p) => p.data) ?? []).filter((t) => t.can.categorize),
    [query.data],
  );
  const { names } = categoryIndex(groups);

  // The current one. When it leaves the queue (reviewed), the one after it takes its place.
  const [at, setAt] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const found = items.findIndex((t) => t.id === at.id);
  const index = found >= 0 ? found : Math.min(at.index, items.length - 1);
  const current = index >= 0 ? items[index] : undefined;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [suggestion, setSuggestion] = useState<SuggestedRule | null>(null);
  const [announce, setAnnounce] = useState('');
  const categoryRef = useRef<HTMLDivElement>(null);

  const patch = useMutation({
    mutationFn: ({ t, body }: { t: Transaction; body: Record<string, unknown> }) =>
      api<Data<Transaction>>('PATCH', `/api/v1/households/${householdId}/transactions/${t.id}`, {
        body,
        headers: { 'if-match': `"v${t.version}"` },
      }),
    onSuccess: () => invalidate(),
    onError: async (e) => {
      const err = e as ApiError;
      toast(err.code === 'edit_conflict' ? 'Someone else changed this first' : err.title, {
        tone: 'error',
      });
      await invalidate();
    },
  });
  const bulk = useMutation({
    mutationFn: (ids: string[]) =>
      api<Data<BulkUpdateResult>>('PATCH', `/api/v1/households/${householdId}/transactions`, {
        body: { ids, changes: { reviewStatus: 'reviewed' } },
      }),
    onSuccess: async (r) => {
      setSelected(new Set());
      await invalidate();
      toast(`${r.data.updated.length} marked reviewed.`);
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });

  const move = (by: number) => {
    const next = items[index + by];
    if (next) setAt({ id: next.id, index: index + by });
  };
  const markReviewed = (t: Transaction) => {
    // The next one takes its place, or the one before when it was the last.
    setAt({ id: items[index + 1]?.id ?? null, index });
    patch.mutate(
      { t, body: { reviewStatus: 'reviewed' } },
      { onSuccess: () => setAnnounce(`${t.displayName} marked reviewed.`) },
    );
  };
  const toggleExcluded = (t: Transaction) =>
    patch.mutate(
      { t, body: { excluded: !t.excluded } },
      {
        onSuccess: () =>
          setAnnounce(
            t.excluded ? 'Counted in reports again.' : 'Left out of reports and budgets.',
          ),
      },
    );

  // j / k / c / r / e, while the page has focus: not while typing, or in a dialog, menu, or list
  // box (those render outside <main>). Toasts don't take focus, so they don't get in the way.
  // Caught before the page's controls see them: a focused category select would otherwise take
  // "r" as type-to-select ("Restaurants").
  const keys = useRef({ move, markReviewed, toggleExcluded, current, view });
  useEffect(() => {
    keys.current = { move, markReviewed, toggleExcluded, current, view };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const onPage =
        e.target === document.body ||
        (e.target instanceof Node && document.getElementById('main')?.contains(e.target));
      if (!onPage) return;
      const k = keys.current;
      if (k.view !== 'transactions') return;
      const t = k.current;
      if (e.key === 'j') k.move(1);
      else if (e.key === 'k') k.move(-1);
      else if (e.key === 'c' && t) {
        // Focus first, so the list opens from it and Escape returns there.
        const trigger = categoryRef.current?.querySelector('button');
        trigger?.focus();
        trigger?.click();
      } else if (e.key === 'r' && t) k.markReviewed(t);
      else if (e.key === 'e' && t?.can.edit) k.toggleExcluded(t);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const allSelected = items.length > 0 && items.every((t) => selected.has(t.id));
  const body = query.isPending ? (
    <LoadingRegion label="Loading the review queue">
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    </LoadingRegion>
  ) : query.isError ? (
    <Alert>Couldn’t load the review queue. Try again in a moment.</Alert>
  ) : items.length === 0 ? (
    <EmptyState icon={CheckCheck} title="All caught up">
      <p>
        Nothing needs review. New transactions from imports land here, so you can check their
        category before they count.
      </p>
      {counts?.transfers ? (
        <Button variant="secondary" onPress={() => setView('transfers')}>
          Check {counts.transfers} {counts.transfers === 1 ? 'transfer' : 'transfers'}
        </Button>
      ) : null}
    </EmptyState>
  ) : (
    <div className="grid gap-6 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section aria-label="To review" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            isSelected={allSelected}
            isIndeterminate={selected.size > 0 && !allSelected}
            onChange={(on) => setSelected(on ? new Set(items.map((t) => t.id)) : new Set())}
          >
            Select all shown
          </Checkbox>
          {selected.size ? (
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              onPress={() => bulk.mutate([...selected])}
              isPending={bulk.isPending}
            >
              Mark {selected.size} reviewed
            </Button>
          ) : null}
        </div>
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {items.map((t, i) => (
            <li
              key={t.id}
              className={clsx('flex items-center gap-3 px-3', i === index && 'bg-surface-2')}
            >
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
                aria-current={i === index ? 'true' : undefined}
                onClick={() => setAt({ id: t.id, index: i })}
                className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.displayName}</span>
                  <span className="block truncate text-xs text-muted">
                    <DateText value={t.date} /> ·{' '}
                    {t.transfer
                      ? transferLabel(t, members)
                      : t.categoryId
                        ? (names.get(t.categoryId) ?? 'Uncategorized')
                        : 'Uncategorized'}
                  </span>
                </span>
                <Amount minor={t.amountMinor} currency={t.currency} className="text-sm" />
              </button>
            </li>
          ))}
        </ul>
        {query.hasNextPage ? (
          <Button
            variant="secondary"
            onPress={() => void query.fetchNextPage()}
            isPending={query.isFetchingNextPage}
          >
            Show more
          </Button>
        ) : null}
      </section>

      {current ? (
        <section
          aria-label={`Reviewing ${current.displayName}`}
          className="order-first space-y-4 md:order-none"
        >
          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3">
            <div ref={categoryRef} className="min-w-48 flex-1">
              <CategorySelect
                groups={groups}
                value={current.categoryId}
                onChange={(categoryId) =>
                  categoryId !== current.categoryId &&
                  patch.mutate(
                    { t: current, body: { categoryId } },
                    { onSuccess: () => setAnnounce(`Category set to ${names.get(categoryId)}.`) },
                  )
                }
                isDisabled={Boolean(current.transfer) || current.hasSplits}
              />
            </div>
            {current.can.edit ? (
              <Button
                variant="secondary"
                onPress={() => toggleExcluded(current)}
                isPending={patch.isPending && patch.variables?.body.excluded !== undefined}
              >
                {current.excluded ? 'Count it again' : 'Exclude'}
              </Button>
            ) : null}
            <Button
              onPress={() => markReviewed(current)}
              isPending={patch.isPending && patch.variables?.body.reviewStatus !== undefined}
            >
              Mark reviewed
            </Button>
          </div>
          {suggestion ? (
            <RuleSuggestion
              householdId={householdId}
              suggestion={suggestion}
              groups={groups}
              members={members}
              onDone={() => setSuggestion(null)}
            />
          ) : null}
          <div className="rounded-xl border border-border bg-surface p-4">
            <TransactionDetails
              key={current.id}
              householdId={householdId}
              t={current}
              members={members}
              groups={groups}
              onDeleted={() => undefined}
              onSuggest={setSuggestion}
              hideCategory
            />
          </div>
        </section>
      ) : null}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Review"
        showLens={false}
        members={members}
        action={
          <ButtonLink variant="ghost" to="/h/$householdId/transactions" params={{ householdId }}>
            All transactions
          </ButtonLink>
        }
      />
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 md:px-8">
        {household.you.role === 'viewer' ? (
          <EmptyState icon={ClipboardCheck} title="Nothing to review">
            <p>Viewers can see transactions but not review them.</p>
          </EmptyState>
        ) : (
          <>
            <SegmentedControl
              aria-label="What to review"
              options={[
                { value: 'transactions', label: `Transactions (${counts?.transactions ?? 0})` },
                { value: 'transfers', label: `Transfers (${counts?.transfers ?? 0})` },
              ]}
              value={view}
              onChange={setView}
            />
            {view === 'transfers' ? (
              <TransferReviewList householdId={householdId} members={members} groups={groups} />
            ) : null}
            {view === 'transactions' && items.length ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                <span className="mr-auto">
                  {counts?.transactions ?? items.length} to review, oldest first.
                </span>
                <span aria-hidden className="hidden flex-wrap gap-x-3 md:flex">
                  {KEYS.map(([key, label]) => (
                    <span key={key}>
                      <Kbd>{key}</Kbd> {label}
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
            {view === 'transactions' ? body : null}
          </>
        )}
        <p role="status" className="sr-only">
          {announce}
        </p>
      </div>
    </>
  );
}
