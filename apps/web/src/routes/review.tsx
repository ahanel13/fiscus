// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BulkUpdateResult, Transaction } from '@fiscus/shared';
import { useInfiniteQuery, useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { CheckCheck, ClipboardCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  accountsQuery,
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
import { MEDIUM, useMediaQuery } from '../lib/media.js';
import { useRangeSelect } from '../lib/range-select.js';
import { type SuggestedRule, suggestMatchText, suggestRule } from '../lib/rules.js';
import { typing } from '../lib/shortcuts.js';
import { categoryIndex } from '../lib/transactions.js';
import { PossibleDuplicatesList } from './possible-duplicates.js';
import { RuleSuggestion, ruleToastAction, useRuleSuggestionContext } from './rules.js';
import { TransferReviewList } from './transfer-review.js';
import {
  CategorySelect,
  TransactionDetails,
  TransactionDrawer,
  TransactionList,
  transferLabel,
  useInvalidateLedger,
} from './transactions.js';

type Data<T> = { data: T };

/** The queue: what needs review, oldest first. The phone's list shares it with the page. */
const QUEUE = { lens: 'all', review: 'needs_review', order: 'oldest' } as const;

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
  const { view: startOn } = useSearch({ strict: false }) as {
    view?: 'transfers' | 'duplicates';
  };
  const [view, setView] = useState<'transactions' | 'transfers' | 'duplicates'>(
    startOn ?? 'transactions',
  );
  const invalidate = useInvalidateLedger(householdId);
  // With a reviewer on some account (#45), the queue is yours: accounts you review, or that
  // nobody in particular does. Everyone's is a switch away.
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const someoneReviews = accounts.some((a) => a.reviewerMemberId);
  const [whose, setWhose] = useState<'yours' | 'everyone'>('yours');
  const filters =
    someoneReviews && whose === 'yours' ? { ...QUEUE, reviewer: 'me' as const } : QUEUE;
  const query = useInfiniteQuery(transactionsQuery(householdId, filters));
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
  const range = useRangeSelect();
  const order = items.map((t) => t.id);
  const [suggestion, setSuggestion] = useState<SuggestedRule | null>(null);
  const [announce, setAnnounce] = useState('');
  const categoryRef = useRef<HTMLDivElement>(null);
  // On a phone, the queue is a list like Transactions: pick a category on a row (which marks it
  // reviewed), tap it for the rest, or mark them all reviewed at once. Wider, one at a time with
  // its details beside the list.
  const wide = useMediaQuery(MEDIUM);
  const [selecting, setSelecting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const ruleContext = useRuleSuggestionContext(householdId);
  // After a category change, offer a rule for it, as Transactions does: below the category, and
  // in the toast.
  const offerRule = (t: Transaction, categoryId: string) => {
    const s = suggestRule(
      {
        originalDescription: t.originalDescription,
        accountId: t.account?.id ?? null,
        amountMinor: t.amountMinor,
      },
      { categoryId },
      ruleContext.rules,
      ruleContext.muted,
      categoryIndex(groups).uncategorized ?? null,
    );
    setSuggestion(s);
    return s;
  };

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
  // The checked ones at once: marked reviewed (which takes them out of the queue), or given a
  // category (they stay checked, so they can be marked reviewed next).
  const bulk = useMutation({
    mutationFn: ({
      changes,
      ids = checked.map((t) => t.id),
    }: {
      changes: { reviewStatus: 'reviewed' } | { categoryId: string };
      ids?: string[];
    }) =>
      api<Data<BulkUpdateResult>>('PATCH', `/api/v1/households/${householdId}/transactions`, {
        body: { ids, changes },
      }),
    onSuccess: async (r, { changes }) => {
      const n = r.data.updated.length;
      const refused = r.data.refused.length;
      if ('reviewStatus' in changes) {
        setSelected(new Set());
        toast(`${n} marked reviewed.`);
      } else {
        const message = `Category set to ${names.get(changes.categoryId)} on ${n} ${n === 1 ? 'transaction' : 'transactions'}.`;
        const done = new Set(r.data.updated);
        const rows = checked.filter((t) => done.has(t.id));
        const oneMerchant =
          rows[0] &&
          rows.every(
            (t) =>
              suggestMatchText(t.originalDescription).toLowerCase() ===
              suggestMatchText(rows[0]!.originalDescription).toLowerCase(),
          );
        const suggested = oneMerchant ? offerRule(rows[0]!, changes.categoryId) : null;
        const rule = !refused && suggested ? ruleToastAction(suggested) : null;
        toast(refused ? `${message} ${refused} couldn’t be changed.` : message, {
          ...(refused ? { tone: 'error' as const } : {}),
          ...(rule ? { description: rule.description, actions: [rule.action] } : {}),
        });
        setAnnounce(message);
      }
      await invalidate();
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
  // Only the checked ones still in the queue (categorizing can mark them reviewed).
  const checked = items.filter((t) => selected.has(t.id));
  // The checked ones' category when they share one, else none shown.
  const checkedCategories = new Set(checked.map((t) => t.categoryId ?? null));
  const mixedCategories = checkedCategories.size > 1;
  const sameCategory = mixedCategories ? null : ([...checkedCategories][0] ?? null);
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
      {counts?.duplicates ? (
        <Button variant="secondary" onPress={() => setView('duplicates')}>
          Check {counts.duplicates} possible {counts.duplicates === 1 ? 'duplicate' : 'duplicates'}
        </Button>
      ) : null}
      {counts?.transfers ? (
        <Button variant="secondary" onPress={() => setView('transfers')}>
          Check {counts.transfers} {counts.transfers === 1 ? 'transfer' : 'transfers'}
        </Button>
      ) : null}
    </EmptyState>
  ) : (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section aria-label="To review" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            isSelected={allSelected}
            isIndeterminate={checked.length > 0 && !allSelected}
            onChange={(on) => setSelected(on ? new Set(items.map((t) => t.id)) : new Set())}
          >
            Select all shown
          </Checkbox>
        </div>
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {items.map((t, i) => (
            <li
              key={t.id}
              className={clsx('flex items-center gap-3 px-3', i === index && 'bg-surface-2')}
            >
              <span className="select-none" {...range.capture}>
                <Checkbox
                  aria-label={`Select ${t.displayName}`}
                  isSelected={selected.has(t.id)}
                  onChange={(on) => setSelected(range.toggle(order, selected, t.id, on))}
                />
              </span>
              <button
                type="button"
                aria-current={i === index ? 'true' : undefined}
                onClick={() => setAt({ id: t.id, index: i })}
                className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.displayName}</span>
                  <span className="block truncate text-xs text-muted">
                    <DateText value={t.date} />
                    {t.account ? ` · ${t.account.name}` : null} ·{' '}
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
              {checked.length ? (
                // With some checked, the category is theirs, all at once.
                <CategorySelect
                  groups={groups}
                  label={`Category for ${checked.length} checked`}
                  value={sameCategory}
                  {...(mixedCategories ? { placeholder: 'Different categories' } : {})}
                  onChange={(categoryId) => bulk.mutate({ changes: { categoryId } })}
                  isDisabled={bulk.isPending}
                />
              ) : (
                <CategorySelect
                  groups={groups}
                  value={current.categoryId}
                  onChange={(categoryId) =>
                    categoryId !== current.categoryId &&
                    patch.mutate(
                      { t: current, body: { categoryId } },
                      {
                        onSuccess: () => {
                          const message = `Category set to ${names.get(categoryId)}.`;
                          setAnnounce(message);
                          const suggested = offerRule(current, categoryId);
                          if (suggested) {
                            const rule = ruleToastAction(suggested);
                            toast(message, {
                              description: rule.description,
                              actions: [rule.action],
                            });
                          }
                        },
                      },
                    )
                  }
                  isDisabled={Boolean(current.transfer) || current.hasSplits}
                />
              )}
            </div>
            {checked.length ? (
              <Button
                onPress={() => bulk.mutate({ changes: { reviewStatus: 'reviewed' } })}
                isPending={bulk.isPending && 'reviewStatus' in (bulk.variables?.changes ?? {})}
              >
                Mark {checked.length} reviewed
              </Button>
            ) : (
              <>
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
              </>
            )}
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

  // "Mark all" covers the ones loaded so far (50 a page), and says so when there are more.
  const loaded = items.slice(0, 500).map((t) => t.id);
  const markingAll = bulk.isPending && bulk.variables?.ids !== undefined;
  const list = (
    <>
      {suggestion ? (
        <RuleSuggestion
          householdId={householdId}
          suggestion={suggestion}
          groups={groups}
          members={members}
          onDone={() => setSuggestion(null)}
        />
      ) : null}
      <TransactionList
        householdId={householdId}
        filters={filters}
        showReview={false}
        members={members}
        groups={groups}
        selectable={selecting}
        selected={selected}
        onSelectedChange={setSelected}
        onOpen={setOpen}
        onLongPress={(id) => {
          setSelecting(true);
          setSelected(new Set(selected).add(id));
        }}
        selectOnTap={selecting}
        onCategorized={offerRule}
      />
      {/* Kept in reach at the bottom while scrolling, as the next thing to do. */}
      <div className="sticky bottom-3 z-10 flex justify-center">
        {checked.length ? (
          <div
            role="toolbar"
            aria-label="Checked transactions"
            className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-2 shadow-lg"
          >
            <span className="px-1 text-sm font-medium">{checked.length} checked</span>
            <div className="min-w-40 flex-1">
              <CategorySelect
                groups={groups}
                hideLabel
                label={`Category for ${checked.length} checked`}
                value={sameCategory}
                {...(mixedCategories ? { placeholder: 'Different categories' } : {})}
                onChange={(categoryId) => bulk.mutate({ changes: { categoryId } })}
                isDisabled={bulk.isPending}
              />
            </div>
            <Button
              className="w-full"
              onPress={() => bulk.mutate({ changes: { reviewStatus: 'reviewed' } })}
              isPending={bulk.isPending && 'reviewStatus' in (bulk.variables?.changes ?? {})}
            >
              Mark {checked.length} reviewed
            </Button>
          </div>
        ) : (
          <Button
            className="shadow-lg"
            onPress={() => bulk.mutate({ changes: { reviewStatus: 'reviewed' }, ids: loaded })}
            isPending={markingAll}
          >
            {query.hasNextPage
              ? `Mark these ${loaded.length} reviewed`
              : `Mark all ${loaded.length} reviewed`}
          </Button>
        )}
      </div>
    </>
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
                // Only with a bank connected, in practice: shown while there's one to decide.
                ...(counts?.duplicates || view === 'duplicates'
                  ? [
                      {
                        value: 'duplicates' as const,
                        label: `Possible duplicates (${counts?.duplicates ?? 0})`,
                      },
                    ]
                  : []),
              ]}
              value={view}
              onChange={setView}
            />
            {view === 'transfers' ? (
              <TransferReviewList householdId={householdId} members={members} groups={groups} />
            ) : null}
            {view === 'duplicates' ? (
              <PossibleDuplicatesList householdId={householdId} groups={groups} />
            ) : null}
            {view === 'transactions' && items.length ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                {someoneReviews ? (
                  <SegmentedControl
                    aria-label="Whose to review"
                    options={[
                      { value: 'yours', label: 'Yours' },
                      { value: 'everyone', label: 'Everyone’s' },
                    ]}
                    value={whose}
                    onChange={setWhose}
                  />
                ) : null}
                <span className="mr-auto">
                  {whose === 'yours' ? (counts?.transactions ?? items.length) : items.length} to
                  review, oldest first.
                </span>
                {wide ? (
                  <span aria-hidden className="flex flex-wrap gap-x-3">
                    {KEYS.map(([key, label]) => (
                      <span key={key}>
                        <Kbd>{key}</Kbd> {label}
                      </span>
                    ))}
                  </span>
                ) : (
                  <Button
                    variant={selecting ? 'primary' : 'secondary'}
                    size="sm"
                    onPress={() => {
                      if (selecting) setSelected(new Set());
                      setSelecting(!selecting);
                    }}
                  >
                    {selecting ? 'Done' : 'Select'}
                  </Button>
                )}
              </div>
            ) : null}
            {view === 'transactions'
              ? wide || query.isPending || query.isError || items.length === 0
                ? body
                : list
              : null}
          </>
        )}
        <p role="status" className="sr-only">
          {announce}
        </p>
      </div>
      {open ? (
        <TransactionDrawer
          householdId={householdId}
          transactionId={open}
          members={members}
          groups={groups}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
