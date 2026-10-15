// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  BulkUpdateResult,
  CategoryGroup,
  HouseholdMember,
  Tag,
  Transaction,
  TransactionSort,
} from '@fiscus/shared';
import { MEMBER_COLORS } from '@fiscus/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeftRight,
  ClipboardCheck,
  Landmark,
  Link2,
  Plus,
  Rows3,
  Rows4,
  Search,
  SlidersHorizontal,
  SplitSquareHorizontal,
  Unlink,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Key, SortDescriptor } from 'react-aria-components';
import { api, type ApiError } from '../api/client.js';
import {
  accountsQuery,
  categoriesQuery,
  householdQuery,
  membersQuery,
  reviewCountQuery,
  tagsQuery,
  type TransactionFilters,
  transactionQuery,
  transactionsQuery,
} from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import {
  Alert,
  AmountInput,
  Badge,
  Button,
  ButtonLink,
  Cell,
  Checkbox,
  Column,
  ConfirmDialog,
  DatePicker,
  DateText,
  Dialog,
  DialogActions,
  DialogTrigger,
  Form,
  LoadingRegion,
  Menu,
  MenuItem,
  MenuTrigger,
  Radio,
  RadioGroup,
  Row,
  SegmentedControl,
  Select,
  SelectItem,
  SelectSection,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableHeader,
  TagPicker,
  TextField,
  toast,
  useToday,
} from '../components/ui.js';
import { categoryIndex, byDay, forLabel, paidByLabel } from '../lib/transactions.js';
import { lensVisible, parseLens } from '../lib/lens.js';
import { RangeSelect } from '../components/RangeControls.js';
import { rangeParams, selectionLabel } from '../lib/ranges.js';
import { RuleEditor, RuleSuggestion, suggestMatchText, useRuleSuggestionContext } from './rules.js';
import { type SuggestedRule, suggestRule } from '../lib/rules.js';
import { applyDensity, type Density, storedDensity } from '../lib/density.js';
import { useMediaQuery, WIDE } from '../lib/media.js';
import { useRange } from '../lib/use-range.js';

type Data<T> = { data: T };
const base = (householdId: string) => `/api/v1/households/${householdId}`;
const ALL = '__all__';

export function useInvalidateLedger(householdId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      ['transactions', 'accounts', 'net-worth'].map((k) =>
        queryClient.invalidateQueries({ queryKey: ['households', householdId, k] }),
      ),
    );
}

/** A category picker grouped like the household's categories. */
export function CategorySelect({
  groups,
  value,
  onChange,
  label = 'Category',
  hideLabel,
  isDisabled,
  appearance,
}: {
  groups: CategoryGroup[];
  value: string | null;
  onChange: (id: string) => void;
  label?: string;
  hideLabel?: boolean;
  isDisabled?: boolean;
  appearance?: 'field' | 'chip';
}) {
  const { uncategorized } = categoryIndex(groups);
  return (
    <Select
      {...(hideLabel ? { 'aria-label': label } : { label })}
      {...(appearance ? { appearance } : {})}
      value={value ?? uncategorized ?? null}
      onChange={(v) => v && onChange(String(v))}
      isDisabled={isDisabled}
    >
      {groups.map((g) => (
        <SelectSection key={g.id} title={g.name}>
          {g.categories
            .filter((c) => !c.archived || c.id === value)
            .map((c) => (
              <SelectItem key={c.id} id={c.id}>
                {c.name}
              </SelectItem>
            ))}
        </SelectSection>
      ))}
    </Select>
  );
}

/**
 * Sets a transaction's category from its row, without opening it (the walkthrough's F12). The
 * toast offers Undo; setting a category may also have marked it reviewed (F14), which Undo
 * puts back too.
 */
function useRowCategory(
  householdId: string,
  groups: CategoryGroup[],
  onCategorized?: (t: Transaction, categoryId: string) => void,
) {
  const invalidate = useInvalidateLedger(householdId);
  const { names } = categoryIndex(groups);
  const patch = (id: string, version: number, body: Record<string, unknown>) =>
    api<Data<Transaction>>('PATCH', `${base(householdId)}/transactions/${id}`, {
      body,
      headers: { 'if-match': `"v${version}"` },
    });
  const fail = async (e: unknown) => {
    const err = e as ApiError;
    toast(err.code === 'edit_conflict' ? 'Someone else changed this first' : err.title, {
      tone: 'error',
    });
    await invalidate();
  };
  return (t: Transaction, categoryId: string) => {
    void patch(t.id, t.version, { categoryId })
      .then(async (r) => {
        await invalidate();
        onCategorized?.(t, categoryId);
        const before = {
          categoryId: t.categoryId,
          ...(r.data.reviewStatus !== t.reviewStatus ? { reviewStatus: t.reviewStatus } : {}),
        };
        toast(`${t.displayName}: ${names.get(categoryId) ?? 'Uncategorized'}.`, {
          actions: [
            {
              label: 'Undo',
              onAction: () =>
                void patch(t.id, r.data.version, before)
                  .then(() => invalidate())
                  .catch(fail),
            },
          ],
        });
      })
      .catch(fail);
  };
}

// ── List ─────────────────────────────────────────────────────────────────────────────────────

/** Newest first: the list's order, and the table's until a column is chosen. */
const BY_DATE: SortDescriptor = { column: 'date', direction: 'descending' };

/** The table's sort as query parameters; newest first needs none. */
function sortParams(sort: SortDescriptor): Pick<TransactionFilters, 'sort' | 'direction'> {
  if (sort.column === BY_DATE.column && sort.direction === BY_DATE.direction) return {};
  return {
    sort: sort.column as TransactionSort,
    direction: sort.direction === 'ascending' ? 'asc' : 'desc',
  };
}

/**
 * Transactions, newest first. A list grouped by day; from `xl` up, a dense table
 * sortable by each column (the walkthrough's F11).
 */
export function TransactionList({
  householdId,
  filters,
  members,
  groups,
  selectable,
  selected,
  onSelectedChange,
  onOpen,
  onCategorized,
  showAccount = true,
  empty,
}: {
  householdId: string;
  filters: TransactionFilters;
  members: HouseholdMember[];
  groups: CategoryGroup[];
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
  onOpen: (id: string) => void;
  /** After a row's category changes, e.g. to suggest a rule. */
  onCategorized?: (t: Transaction, categoryId: string) => void;
  /** The table's Account column; an account's own page leaves it out. */
  showAccount?: boolean;
  /** Shown when there's nothing at all, rather than nothing matching the filters. */
  empty?: ReactNode;
}) {
  const wide = useMediaQuery(WIDE);
  const [sort, setSort] = useState<SortDescriptor>(BY_DATE);
  const query = useInfiniteQuery({
    // The list groups by day, so only the table sorts otherwise.
    ...transactionsQuery(householdId, wide ? { ...filters, ...sortParams(sort) } : filters),
    // Re-sorting keeps the rows in place until the new order arrives.
    ...(wide ? { placeholderData: keepPreviousData } : {}),
  });
  const { names } = categoryIndex(groups);
  const categorize = useRowCategory(householdId, groups, onCategorized);
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.data) ?? [], [query.data]);
  const shared = members.length > 1;

  if (query.isPending) {
    return (
      <LoadingRegion label="Loading transactions">
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </LoadingRegion>
    );
  }
  if (query.isError) return <Alert>Couldn’t load transactions. Try again in a moment.</Alert>;
  if (items.length === 0) {
    return (
      empty ?? (
        <p className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted">
          No transactions match.
        </p>
      )
    );
  }

  const category = (t: Transaction) =>
    t.can.categorize && !t.hasSplits ? (
      <CategorySelect
        groups={groups}
        value={t.categoryId}
        label={`Category of ${t.displayName}`}
        hideLabel
        appearance="chip"
        onChange={(categoryId) => categoryId !== t.categoryId && categorize(t, categoryId)}
      />
    ) : (
      <span className="truncate text-xs text-muted">
        {t.categoryId ? (names.get(t.categoryId) ?? 'Uncategorized') : 'Uncategorized'}
      </span>
    );
  const badges = (t: Transaction) => (
    <>
      {t.reviewStatus === 'needs_review' ? <Badge tone="accent">Review</Badge> : null}
      {t.transfer ? (
        // Long account names ("MyLowe's® Rewards Credit Card (...4444)") truncate.
        <Badge className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{transferLabel(t, members)}</span>
        </Badge>
      ) : null}
      {t.excluded ? <Badge>Excluded</Badge> : null}
      {t.dateEdited ? <Badge>Date moved</Badge> : null}
    </>
  );
  const more = query.hasNextPage ? (
    <div className="flex justify-center">
      <Button
        variant="secondary"
        onPress={() => void query.fetchNextPage()}
        isPending={query.isFetchingNextPage}
      >
        Show more
      </Button>
    </div>
  ) : null;

  if (wide) {
    const editable = items.filter((t) => t.can.categorize).map((t) => t.id);
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-border bg-surface">
          <Table
            aria-label="Transactions"
            className="table-fixed"
            sortDescriptor={sort}
            onSortChange={setSort}
            onRowAction={(id) => onOpen(String(id))}
            {...(selectable
              ? {
                  selectionMode: 'multiple' as const,
                  selectedKeys: selected ?? new Set<string>(),
                  // Rows you can't change can still be opened, but not selected.
                  disabledKeys: items.filter((t) => !t.can.categorize).map((t) => t.id),
                  disabledBehavior: 'selection' as const,
                  onSelectionChange: (keys: 'all' | Set<Key>) =>
                    onSelectedChange?.(new Set(keys === 'all' ? editable : [...keys].map(String))),
                }
              : {})}
          >
            <TableHeader>
              <Column id="date" allowsSorting className="w-32">
                Date
              </Column>
              <Column id="name" allowsSorting isRowHeader>
                Name
              </Column>
              <Column id="category" allowsSorting className="w-44">
                Category
              </Column>
              {showAccount ? (
                <Column id="account" allowsSorting className="w-52">
                  Account
                </Column>
              ) : null}
              <Column id="amount" allowsSorting align="end" className="w-32">
                Amount
              </Column>
            </TableHeader>
            <TableBody items={items} dependencies={[groups, members, showAccount]}>
              {(t) => (
                <Row id={t.id} className="cursor-default">
                  <Cell className="whitespace-nowrap text-muted">
                    <DateText value={t.date} format="date" />
                  </Cell>
                  <Cell>
                    <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                      <span className="max-w-full shrink-0 truncate font-medium">
                        {t.displayName}
                      </span>
                      {/* Badges give way before the name does. */}
                      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
                        {badges(t)}
                      </span>
                    </span>
                  </Cell>
                  <Cell>
                    <span className="flex max-w-full">{category(t)}</span>
                  </Cell>
                  {showAccount ? (
                    <Cell>
                      {/* The account name gives way, so whose it is stays in view. */}
                      <span className="flex min-w-0 gap-1 whitespace-nowrap text-muted">
                        <span className="min-w-0 truncate">
                          {t.account ? t.account.name : paidByLabel(t, members)}
                        </span>
                        {shared ? <span className="shrink-0">· {forLabel(t, members)}</span> : null}
                      </span>
                    </Cell>
                  ) : null}
                  <Cell align="end">
                    <Amount minor={t.amountMinor} currency={t.currency} className="font-medium" />
                  </Cell>
                </Row>
              )}
            </TableBody>
          </Table>
        </div>
        {more}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {byDay(items).map(([day, rows]) => (
        <section key={day} aria-label={day}>
          <h3 className="mb-1 px-1 text-xs font-semibold tracking-wide text-muted uppercase">
            <DateText value={day} format="date" />
          </h3>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
            {rows.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3"
                style={{ minHeight: 'var(--row-h)', paddingInline: 'var(--cell-px)' }}
              >
                {selectable ? (
                  <Checkbox
                    aria-label={`Select ${t.displayName}`}
                    isSelected={selected?.has(t.id) ?? false}
                    isDisabled={!t.can.categorize}
                    onChange={(on) => {
                      const next = new Set(selected);
                      if (on) next.add(t.id);
                      else next.delete(t.id);
                      onSelectedChange?.(next);
                    }}
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => onOpen(t.id)}
                  className="min-w-0 flex-1 py-2 text-left"
                >
                  <span className="block truncate text-sm font-medium">{t.displayName}</span>
                  {/* One line: the account name gives way, so a row stays two lines on a phone. */}
                  <span className="flex min-w-0 items-center gap-x-2 overflow-hidden text-xs whitespace-nowrap text-muted">
                    <span className="min-w-0 truncate">
                      {t.account ? t.account.name : paidByLabel(t, members)}
                    </span>
                    {shared ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>{forLabel(t, members)}</span>
                      </>
                    ) : null}
                    {badges(t)}
                  </span>
                </button>
                {/* Category and amount: one above the other on a phone, side by side wider. */}
                <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-1 py-2 md:max-w-none md:flex-row md:items-center md:gap-4">
                  <Amount
                    minor={t.amountMinor}
                    currency={t.currency}
                    className="text-sm font-medium md:order-last md:w-28 md:text-right"
                  />
                  <span className="flex max-w-full md:w-44 md:justify-end">{category(t)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────────────────────

export function TransactionsPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const groups = useQuery(categoriesQuery(householdId)).data ?? [];
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const search = useSearch({ strict: false }) as { lens?: string; review?: string };
  const showLens = lensVisible(household, members.length);
  const lens = showLens ? parseLens(search.lens) : 'all';
  const invalidate = useInvalidateLedger(householdId);
  const range = useRange(household, 'transactions', 'all_time');

  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const [account, setAccount] = useState<string>(ALL);
  // ?review=needs_review opens the list on what needs review.
  const [review, setReview] = useState(search.review === 'needs_review');
  const filters: TransactionFilters = {
    lens,
    range: rangeParams(range.selection).toString(),
    ...(q ? { q } : {}),
    ...(account !== ALL ? { accounts: [account] } : {}),
    ...(review ? { review: 'needs_review' as const } : {}),
  };
  const activeFilters =
    Number(range.selection.range !== 'all_time') + Number(account !== ALL) + Number(review);
  const clearFilters = () => {
    range.setRange('all_time');
    setAccount(ALL);
    setReview(false);
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const ownsAny = accounts.some((a) => a.yourAccess === 'owner');
  const toReview =
    useQuery({ ...reviewCountQuery(householdId), enabled: household.you.role !== 'viewer' }).data
      ?.count ?? 0;

  const bulk = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      api<Data<BulkUpdateResult>>('PATCH', `${base(householdId)}/transactions`, {
        body: { ids: [...selected], changes },
      }),
    onSuccess: async (r, changes) => {
      setSelected(new Set());
      await invalidate();
      const { updated, refused } = r.data;
      toast(`${updated.length} updated.`, {
        ...(refused.length ? { description: `${refused.length} couldn’t be changed by you.` } : {}),
      });
      // Categorized several from one merchant: offer a rule for the rest and for next time.
      if (typeof changes.categoryId === 'string' && updated.length) {
        const rows = await Promise.all(
          updated
            .slice(0, 20)
            .map(
              async (id) =>
                (await api<Data<Transaction>>('GET', `${base(householdId)}/transactions/${id}`))
                  .data,
            ),
        );
        const texts = new Set(
          rows.map((t) => suggestMatchText(t.originalDescription).toLowerCase()),
        );
        if (texts.size === 1 && rows[0]?.can.categorize) {
          setSuggestion(
            suggestRule(
              {
                originalDescription: rows[0].originalDescription,
                accountId: rows[0].account?.id ?? null,
                amountMinor: rows[0].amountMinor,
              },
              { categoryId: changes.categoryId },
              ruleContext.rules,
              ruleContext.muted,
              categoryIndex(groups).uncategorized ?? null,
            ),
          );
        }
      }
    },
  });
  const ruleContext = useRuleSuggestionContext(householdId);
  const [suggestion, setSuggestion] = useState<SuggestedRule | null>(null);

  return (
    <>
      <PageHeader
        title="Transactions"
        showLens={showLens}
        members={members}
        action={
          household.you.role !== 'viewer' ? (
            // Icons on phones, labels from small screens up.
            <>
              <ButtonLink
                variant="ghost"
                to="/h/$householdId/review"
                params={{ householdId }}
                className="px-2.5 sm:px-3.5"
              >
                <ClipboardCheck aria-hidden className="size-4" />
                <span className="sr-only sm:not-sr-only">Review</span>
                {toReview ? (
                  <Badge tone="accent">
                    {toReview}
                    <span className="sr-only"> to review</span>
                  </Badge>
                ) : null}
              </ButtonLink>
              <ButtonLink
                variant="ghost"
                to="/h/$householdId/rules"
                params={{ householdId }}
                className="px-2.5 sm:px-3.5"
              >
                <Wand2 aria-hidden className="size-4" />
                <span className="sr-only sm:not-sr-only">Rules</span>
              </ButtonLink>
              <MenuTrigger>
                <Button className="px-2.5 sm:px-3.5">
                  <Plus aria-hidden className="size-4" />
                  <span className="sr-only sm:not-sr-only">Add</span>
                </Button>
                <Menu placement="bottom end" aria-label="Add transactions">
                  {ownsAny ? (
                    <MenuItem onAction={() => setAdding(true)}>
                      <Plus aria-hidden /> Enter a transaction
                    </MenuItem>
                  ) : null}
                  <MenuItem href={`/h/${householdId}/import`}>
                    <Upload aria-hidden /> Import from Monarch or a bank file
                  </MenuItem>
                </Menu>
              </MenuTrigger>
            </>
          ) : undefined
        }
      />
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 md:px-8">
        {accounts.length === 0 ? (
          <EmptyState icon={ArrowLeftRight} title="No transactions yet">
            <p>
              Add an account and record transactions in it, or import your history from Monarch or a
              bank’s CSV file.
            </p>
          </EmptyState>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                  />
                  <TextField
                    aria-label="Search transactions"
                    placeholder="Search"
                    value={text}
                    onChange={setText}
                    inputClassName="pl-9"
                  />
                </div>
                <DialogTrigger>
                  <Button variant="secondary" className="shrink-0 px-2.5 sm:px-3.5">
                    <SlidersHorizontal aria-hidden className="size-4" />
                    <span className="sr-only sm:not-sr-only">Filters</span>
                    {activeFilters ? (
                      <Badge tone="accent">
                        {activeFilters}
                        <span className="sr-only"> on</span>
                      </Badge>
                    ) : null}
                  </Button>
                  <Dialog title="Filters" size="sm">
                    {(close) => (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <span className="block text-sm font-medium">Time range</span>
                          <RangeSelect state={range} align="start" />
                        </div>
                        <Select
                          label="Account"
                          value={account}
                          onChange={(v) => v && setAccount(String(v))}
                        >
                          <SelectItem id={ALL}>All accounts</SelectItem>
                          {accounts.map((a) => (
                            <SelectItem key={a.id} id={a.id}>
                              {a.name}
                            </SelectItem>
                          ))}
                        </Select>
                        <Switch isSelected={review} onChange={setReview}>
                          Only what needs review
                        </Switch>
                        <DialogActions>
                          {activeFilters ? (
                            <Button variant="ghost" onPress={clearFilters}>
                              Clear all
                            </Button>
                          ) : null}
                          <Button onPress={close}>Done</Button>
                        </DialogActions>
                      </div>
                    )}
                  </Dialog>
                </DialogTrigger>
                <DensityChoice />
              </div>
              {activeFilters ? (
                <div role="group" aria-label="Filters on" className="flex flex-wrap gap-2">
                  {range.selection.range !== 'all_time' ? (
                    <FilterChip
                      label={selectionLabel(range.selection)}
                      onRemove={() => range.setRange('all_time')}
                    />
                  ) : null}
                  {account !== ALL ? (
                    <FilterChip
                      label={accounts.find((a) => a.id === account)?.name ?? 'Account'}
                      onRemove={() => setAccount(ALL)}
                    />
                  ) : null}
                  {review ? (
                    <FilterChip label="Needs review" onRemove={() => setReview(false)} />
                  ) : null}
                </div>
              ) : null}
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
            {selected.size > 0 ? (
              <div
                role="toolbar"
                aria-label="Selected transactions"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-2"
              >
                <span className="px-2 text-sm font-medium">{selected.size} selected</span>
                <div className="w-56">
                  <CategorySelect
                    groups={groups}
                    value={null}
                    hideLabel
                    label="Set category"
                    onChange={(categoryId) => bulk.mutate({ categoryId })}
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => bulk.mutate({ reviewStatus: 'reviewed' })}
                  isPending={bulk.isPending}
                >
                  Mark reviewed
                </Button>
                {ownsAny ? (
                  <MoveToAccount
                    householdId={householdId}
                    ids={[...selected]}
                    trigger="select"
                    onMoved={() => setSelected(new Set())}
                  />
                ) : null}
                <Button variant="ghost" size="sm" onPress={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            ) : null}

            <TransactionList
              householdId={householdId}
              filters={filters}
              members={members}
              groups={groups}
              selectable
              selected={selected}
              onSelectedChange={setSelected}
              onOpen={setOpen}
              onCategorized={(t, categoryId) =>
                setSuggestion(
                  suggestRule(
                    {
                      originalDescription: t.originalDescription,
                      accountId: t.account?.id ?? null,
                      amountMinor: t.amountMinor,
                    },
                    { categoryId },
                    ruleContext.rules,
                    ruleContext.muted,
                    categoryIndex(groups).uncategorized ?? null,
                  ),
                )
              }
            />
          </>
        )}
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
      {ownsAny ? (
        <AddTransactionDialog
          householdId={householdId}
          isOpen={adding}
          onOpenChange={setAdding}
          accounts={accounts.filter((a) => a.yourAccess === 'owner' && !a.closedAt)}
          groups={groups}
        />
      ) : null}
    </>
  );
}

/** Comfortable or compact rows, here on the list rather than in settings (F11). */
function DensityChoice() {
  const [density, setDensity] = useState<Density>(storedDensity);
  const option = (value: Density, label: string, Icon: typeof Rows3) => ({
    value,
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Icon aria-hidden className="size-4" />
        <span className="sr-only xl:not-sr-only">{label}</span>
      </span>
    ),
  });
  return (
    <SegmentedControl
      aria-label="Density"
      className="shrink-0"
      options={[option('comfortable', 'Comfortable', Rows3), option('compact', 'Compact', Rows4)]}
      value={density}
      onChange={(d) => (setDensity(d), applyDensity(d))}
    />
  );
}

/** An active filter, with a button to turn it off. */
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface py-0.5 pr-0.5 pl-3 text-sm">
      <span className="min-w-0 truncate">{label}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Remove filter: ${label}`}
        onPress={onRemove}
        className="size-7 min-h-0 rounded-full"
      >
        <X aria-hidden className="size-3.5" />
      </Button>
    </span>
  );
}

// ── Add ──────────────────────────────────────────────────────────────────────────────────────

export function AddTransactionDialog({
  householdId,
  isOpen,
  onOpenChange,
  accounts,
  groups,
}: {
  householdId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Account[];
  groups: CategoryGroup[];
}) {
  const today = useToday();
  const invalidate = useInvalidateLedger(householdId);
  const [accountId, setAccountId] = useState<string | null>(accounts[0]?.id ?? null);
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(today);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === accountId);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Data<Transaction>>('POST', `${base(householdId)}/transactions`, { body }),
    onSuccess: async () => {
      await invalidate();
      toast('Transaction added.');
      onOpenChange(false);
      setAmount(null);
    },
  });
  const err = create.error as ApiError | null;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // The required fields block an empty submit; this is a backstop. The submit button stays
    // enabled because the amount commits when its field loses focus, which clicking it does.
    if (!accountId || amount === null) return;
    create.mutate({
      accountId,
      date,
      amountMinor: direction === 'out' ? -amount : amount,
      displayName: new FormData(e.currentTarget).get('displayName'),
      ...(categoryId ? { categoryId } : {}),
    });
  };
  return (
    <Dialog title="Add transaction" isOpen={isOpen} onOpenChange={onOpenChange}>
      {(close) => (
        <Form onSubmit={onSubmit} validationErrors={err?.fieldErrors()}>
          {err?.formError ? <Alert>{err.formError}</Alert> : null}
          <Select
            label="Account"
            value={accountId}
            onChange={(v) => setAccountId(v ? String(v) : null)}
            isRequired
          >
            {accounts.map((a) => (
              <SelectItem key={a.id} id={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </Select>
          <TextField
            label="Description"
            name="displayName"
            isRequired
            maxLength={200}
            placeholder="Trader Joe’s"
            autoFocus
          />
          <SegmentedControl
            aria-label="Direction"
            options={[
              { value: 'out', label: 'Money out' },
              { value: 'in', label: 'Money in' },
            ]}
            value={direction}
            onChange={setDirection}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <AmountInput
              label="Amount"
              currency={account?.currency ?? 'USD'}
              value={amount}
              onChange={setAmount}
              isRequired
            />
            <DatePicker label="Date" value={date} onChange={(d) => d && setDate(d)} />
          </div>
          <CategorySelect groups={groups} value={categoryId} onChange={setCategoryId} />
          <DialogActions>
            <Button variant="secondary" onPress={close}>
              Cancel
            </Button>
            <Button type="submit" isPending={create.isPending}>
              Add transaction
            </Button>
          </DialogActions>
        </Form>
      )}
    </Dialog>
  );
}

// ── Drawer ───────────────────────────────────────────────────────────────────────────────────

export function TransactionDrawer({
  householdId,
  transactionId,
  members,
  groups,
  onClose,
}: {
  householdId: string;
  transactionId: string;
  members: HouseholdMember[];
  groups: CategoryGroup[];
  onClose: () => void;
}) {
  const query = useQuery(transactionQuery(householdId, transactionId));
  const t = query.data;
  // Kept here, so it outlives the details when another transaction opens.
  const [suggestion, setSuggestion] = useState<SuggestedRule | null>(null);
  return (
    <Dialog
      title={t?.displayName ?? 'Transaction'}
      variant="drawer"
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {t && suggestion && t.can.categorize ? (
        <div className="mb-4">
          <RuleSuggestion
            householdId={householdId}
            suggestion={suggestion}
            groups={groups}
            members={members}
            onDone={() => setSuggestion(null)}
          />
        </div>
      ) : null}
      {t ? (
        <TransactionDetails
          key={t.id}
          householdId={householdId}
          t={t}
          members={members}
          groups={groups}
          onDeleted={onClose}
          onSuggest={setSuggestion}
        />
      ) : (
        <LoadingRegion label="Loading transaction">
          <Skeleton className="h-40" />
        </LoadingRegion>
      )}
    </Dialog>
  );
}

export function TransactionDetails({
  householdId,
  t,
  members,
  groups,
  onDeleted,
  onSuggest,
  hideCategory,
}: {
  householdId: string;
  t: Transaction;
  members: HouseholdMember[];
  groups: CategoryGroup[];
  onDeleted: () => void;
  onSuggest: (s: SuggestedRule | null) => void;
  /** The review queue has its own category picker above these details. */
  hideCategory?: boolean;
}) {
  const invalidate = useInvalidateLedger(householdId);
  const queryClient = useQueryClient();
  const tags = useQuery(tagsQuery(householdId)).data ?? [];
  const url = `${base(householdId)}/transactions/${t.id}`;
  const manual = t.source === 'manual';
  // Each field saves as it changes (the walkthrough's F13); text fields when you leave them.
  const [name, setName] = useState(t.displayName);
  const [saved, setSaved] = useState('');
  // Kept in step when the transaction changes underneath (a save, or someone else's).
  const [shownName, setShownName] = useState(t.displayName);
  if (t.displayName !== shownName) {
    setShownName(t.displayName);
    setName(t.displayName);
  }

  const onError = async (e: unknown) => {
    const err = e as ApiError;
    toast(err.code === 'edit_conflict' ? 'Someone else changed this first' : err.title, {
      tone: 'error',
      ...(err.code === 'edit_conflict' ? { description: 'Their changes are loaded now.' } : {}),
    });
    await invalidate();
  };
  const { rules, muted } = useRuleSuggestionContext(householdId);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Data<Transaction>>('PATCH', url, { body, headers: { 'if-match': `"v${t.version}"` } }),
    onSuccess: async (_r, body) => {
      setSaved('Saved');
      await invalidate();
      // Renamed or recategorized: offer to do the same for the others, next time too.
      onSuggest(
        suggestRule(
          {
            originalDescription: t.originalDescription,
            accountId: t.account?.id ?? null,
            amountMinor: t.amountMinor,
          },
          {
            ...(body as { displayName?: string; categoryId?: string | null }),
            addedTagIds: Array.isArray(body.tagIds)
              ? (body.tagIds as string[]).filter((id) => !t.tagIds.includes(id))
              : [],
          },
          rules,
          muted,
          categoryIndex(groups).uncategorized ?? null,
        ),
      );
    },
    onError,
  });
  const change = (body: Record<string, unknown>) => save.mutate(body);
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== t.displayName) change({ displayName: trimmed });
    else setName(t.displayName);
  };
  const resetDate = useMutation({
    mutationFn: () =>
      api('PATCH', url, { body: { date: null }, headers: { 'if-match': `"v${t.version}"` } }),
    onSuccess: async () => {
      await invalidate();
      toast('Back to the bank’s date.');
    },
    onError,
  });
  const attribution = useMutation({
    mutationFn: (memberIds: string[]) =>
      api('PUT', `${url}/attribution`, {
        body: { attribution: memberIds.map((memberId) => ({ memberId })) },
      }),
    onSuccess: async () => {
      await invalidate();
      toast('Updated who it’s for.');
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', url),
    onSuccess: async () => {
      await invalidate();
      toast('Transaction deleted.');
      onDeleted();
    },
  });

  const forIds = t.attribution.map((a) => a.memberId);
  const [linking, setLinking] = useState(false);
  // When these details mount, keep focus in them rather than letting it fall to the page, where
  // Escape and the keyboard stop reaching the drawer.
  const root = useRef<HTMLDivElement>(null);
  // The same after a change: the control you used can go with it (a picker closes, a section
  // re-renders), and focus would fall to the page.
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) root.current?.focus();
  }, [t.version]);
  return (
    <div ref={root} tabIndex={-1} className="space-y-5 outline-none">
      <div>
        <Amount
          minor={t.amountMinor}
          currency={t.currency}
          className="text-3xl font-semibold tracking-tight"
        />
        <p className="text-sm text-muted">
          <DateText value={t.date} />
          {t.dateEdited ? (
            <>
              {' '}
              · Bank date: <DateText value={t.reportedDate} />
            </>
          ) : null}
          {' · '}
          {t.account ? t.account.name : paidByLabel(t, members)}
        </p>
        {t.originalDescription !== t.displayName ? (
          <p className="mt-1 text-xs text-muted">Original: {t.originalDescription}</p>
        ) : null}
        <div role="group" aria-label="Actions" className="mt-3 flex flex-wrap gap-2">
          {t.can.categorize && !t.parentId ? (
            <MakeRule householdId={householdId} t={t} groups={groups} members={members} />
          ) : null}
          {t.account && t.can.edit && t.source !== 'provider' ? (
            // A part of a split moves with its whole purchase.
            <MoveToAccount
              householdId={householdId}
              ids={[t.parentId ?? t.id]}
              from={t.account.id}
              currency={t.currency}
              trigger="button"
              label={t.parentId ? 'Move this purchase to another account' : undefined}
            />
          ) : null}
          {t.can.edit && !t.parentId ? (
            <SplitEditor householdId={householdId} t={t} groups={groups} />
          ) : null}
          {canLinkTransfer(t) ? (
            // Toggles the picker below; it stays put, so focus has somewhere to stay.
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={linking}
              onPress={() => setLinking(!linking)}
            >
              <Link2 aria-hidden className="size-4" /> Link as a transfer
            </Button>
          ) : null}
        </div>
      </div>

      <TransferSection
        householdId={householdId}
        t={t}
        members={members}
        linking={linking}
        onLinkingChange={setLinking}
      />

      <Form
        onSubmit={(e) => {
          e.preventDefault(); // Enter in a text field saves it
          commitName();
        }}
      >
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          onBlur={commitName}
          isReadOnly={!t.can.categorize}
          maxLength={200}
        />
        {hideCategory ? null : (
          <CategorySelect
            groups={groups}
            value={t.categoryId}
            onChange={(categoryId) => categoryId !== t.categoryId && change({ categoryId })}
            isDisabled={!t.can.categorize}
          />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <DatePicker
              label="Date"
              value={t.date}
              onChange={(d) => d && d !== t.date && change({ date: d })}
              isDisabled={!t.can.edit || Boolean(t.parentId)}
            />
            {t.dateEdited && t.can.edit && !manual ? (
              <Button
                variant="ghost"
                size="sm"
                onPress={() => resetDate.mutate()}
                isPending={resetDate.isPending}
              >
                Reset to bank date
              </Button>
            ) : null}
          </div>
          {manual && t.can.edit && !t.parentId ? (
            <AmountInput
              label="Amount"
              currency={t.currency}
              allowNegative
              value={t.amountMinor}
              // Number fields report a change when you leave them, not per keystroke.
              onChange={(v) => v && v !== t.amountMinor && change({ amountMinor: v })}
            />
          ) : null}
        </div>
        <TagPicker
          tags={tags}
          value={t.tagIds}
          onChange={(tagIds) => change({ tagIds })}
          onCreate={async (tagName) => {
            const r = await api<Data<Tag>>('POST', `${base(householdId)}/tags`, {
              body: { name: tagName, color: MEMBER_COLORS[tags.length % MEMBER_COLORS.length] },
            });
            await queryClient.invalidateQueries({ queryKey: tagsQuery(householdId).queryKey });
            return r.data;
          }}
          isDisabled={!t.can.categorize}
        />
        <div className="space-y-1">
          <Switch
            isSelected={t.reviewStatus === 'reviewed'}
            onChange={(on) => change({ reviewStatus: on ? 'reviewed' : 'needs_review' })}
            isDisabled={!t.can.categorize}
          >
            Reviewed
          </Switch>
          <Switch
            isSelected={t.excluded}
            onChange={(excluded) => change({ excluded })}
            isDisabled={!t.can.edit}
          >
            Leave out of reports and budgets
          </Switch>
        </div>
        {t.can.categorize || t.can.edit ? (
          <p role="status" className="min-h-5 text-xs text-muted">
            {save.isPending ? 'Saving…' : saved}
          </p>
        ) : (
          <p className="text-xs text-muted">You can see this transaction but not change it.</p>
        )}
      </Form>

      {members.length > 1 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Who it’s for</h3>
          <p className="text-sm">
            {forLabel(t, members)}
            {t.attributionInherited ? (
              <span className="text-muted"> (the account’s owners)</span>
            ) : null}
          </p>
          {t.can.attribute && !t.hasSplits ? (
            <ForPicker
              members={members}
              selected={forIds}
              onSave={(ids) => attribution.mutate(ids)}
              isPending={attribution.isPending}
            />
          ) : null}
        </section>
      ) : null}

      <Notes householdId={householdId} t={t} />

      {t.can.edit && !t.parentId ? (
        <div className="border-t border-border pt-4">
          <DialogTrigger>
            <Button variant="danger" size="sm">
              Delete transaction
            </Button>
            <ConfirmDialog
              title="Delete this transaction?"
              confirmLabel="Delete"
              destructive
              onConfirm={() => remove.mutateAsync()}
            >
              {manual ? 'You can’t undo this.' : 'The bank won’t add it back on the next sync.'}
            </ConfirmDialog>
          </DialogTrigger>
        </div>
      ) : null}
    </div>
  );
}

function ForPicker({
  members,
  selected,
  onSave,
  isPending,
}: {
  members: HouseholdMember[];
  selected: string[];
  onSave: (ids: string[]) => void;
  isPending: boolean;
}) {
  const [ids, setIds] = useState(selected);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4">
        {members.map((m) => (
          <Checkbox
            key={m.id}
            isSelected={ids.includes(m.id)}
            onChange={(on) => setIds(on ? [...ids, m.id] : ids.filter((x) => x !== m.id))}
          >
            {m.isYou ? 'Me' : m.displayName}
          </Checkbox>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          isDisabled={ids.length === 0}
          isPending={isPending}
          onPress={() => onSave(ids)}
        >
          Save who it’s for
        </Button>
        <Button variant="ghost" size="sm" onPress={() => onSave([])}>
          Same as the account
        </Button>
      </div>
      <p className="text-xs text-muted">
        Split equally. People you add see this purchase, but not the account it’s from.
      </p>
    </div>
  );
}

function Notes({ householdId, t }: { householdId: string; t: Transaction }) {
  const invalidate = useInvalidateLedger(householdId);
  const [shared, setShared] = useState(t.sharedNote ?? '');
  const [mine, setMine] = useState(t.myNote ?? '');
  const save = useMutation({
    mutationFn: ({ kind, body }: { kind: 'shared' | 'mine'; body: string }) =>
      body.trim()
        ? api('PUT', `${base(householdId)}/transactions/${t.id}/notes/${kind}`, { body: { body } })
        : api('DELETE', `${base(householdId)}/transactions/${t.id}/notes/${kind}`),
    onSuccess: async () => {
      await invalidate();
      toast('Note saved.');
    },
  });
  return (
    <section className="space-y-3">
      <TextField
        label="Shared note"
        multiline
        value={shared}
        onChange={setShared}
        isReadOnly={!t.can.writeSharedNote}
        description="Everyone who can see this transaction sees this note."
        maxLength={5000}
      />
      {t.can.writeSharedNote && shared !== (t.sharedNote ?? '') ? (
        <Button
          variant="secondary"
          size="sm"
          onPress={() => save.mutate({ kind: 'shared', body: shared })}
        >
          Save shared note
        </Button>
      ) : null}
      <TextField
        label="My note"
        multiline
        value={mine}
        onChange={setMine}
        description="Only you see this."
        maxLength={5000}
      />
      {mine !== (t.myNote ?? '') ? (
        <Button
          variant="secondary"
          size="sm"
          onPress={() => save.mutate({ kind: 'mine', body: mine })}
        >
          Save my note
        </Button>
      ) : null}
    </section>
  );
}

function SplitEditor({
  householdId,
  t,
  groups,
}: {
  householdId: string;
  t: Transaction;
  groups: CategoryGroup[];
}) {
  const invalidate = useInvalidateLedger(householdId);
  const half = Math.trunc(t.amountMinor / 2);
  const [parts, setParts] = useState([
    { amountMinor: half as number | null, categoryId: t.categoryId },
    // The second part is the rest, waiting for its own category.
    { amountMinor: (t.amountMinor - half) as number | null, categoryId: null as string | null },
  ]);
  const total = parts.reduce((s, p) => s + (p.amountMinor ?? 0), 0);
  const left = t.amountMinor - total;
  const zeroPart = parts.some((p) => !p.amountMinor);
  const split = useMutation({
    mutationFn: () =>
      api('PUT', `${base(householdId)}/transactions/${t.id}/splits`, {
        body: {
          parts: parts.map((p) => ({ amountMinor: p.amountMinor ?? 0, categoryId: p.categoryId })),
        },
      }),
    onSuccess: async () => {
      await invalidate();
      toast('Split saved.');
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const unsplit = useMutation({
    mutationFn: () => api('DELETE', `${base(householdId)}/transactions/${t.id}/splits`),
    onSuccess: async () => {
      await invalidate();
      toast('Split removed.');
    },
  });
  if (t.hasSplits) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onPress={() => unsplit.mutate()}
        isPending={unsplit.isPending}
      >
        Remove split
      </Button>
    );
  }
  return (
    <DialogTrigger>
      <Button variant="secondary" size="sm">
        <SplitSquareHorizontal aria-hidden className="size-4" /> Split
      </Button>
      <Dialog title={`Split ${t.displayName}`} size="lg">
        {(close) => (
          <div className="space-y-4">
            {parts.map((p, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                <AmountInput
                  label={`Part ${i + 1}`}
                  currency={t.currency}
                  allowNegative
                  value={p.amountMinor}
                  onChange={(v) =>
                    setParts(parts.map((x, j) => (j === i ? { ...x, amountMinor: v } : x)))
                  }
                />
                <CategorySelect
                  groups={groups}
                  label={`Part ${i + 1} category`}
                  value={p.categoryId}
                  onChange={(c) =>
                    setParts(parts.map((x, j) => (j === i ? { ...x, categoryId: c } : x)))
                  }
                />
              </div>
            ))}
            <div className="flex items-center justify-between text-sm">
              <Button
                variant="ghost"
                size="sm"
                onPress={() => setParts([...parts, { amountMinor: left, categoryId: null }])}
              >
                <Plus aria-hidden className="size-4" /> Add part
              </Button>
              <span className={left === 0 && !zeroPart ? 'text-muted' : 'text-danger'}>
                {zeroPart ? (
                  'Every part needs an amount'
                ) : left === 0 ? (
                  'Adds up'
                ) : (
                  <>
                    Left to assign: <Amount minor={left} currency={t.currency} kind="balance" />
                  </>
                )}
              </span>
            </div>
            <DialogActions>
              <Button variant="secondary" onPress={close}>
                Cancel
              </Button>
              <Button
                isDisabled={left !== 0 || zeroPart}
                isPending={split.isPending}
                onPress={() => split.mutate(undefined, { onSuccess: close })}
              >
                Save split
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

/**
 * Moves transactions to another account you own (TXN-12): a button and dialog in the drawer, or a
 * select in the bulk bar. Each transaction is moved or refused on its own, and the toast says why.
 */
function MoveToAccount({
  householdId,
  ids,
  from,
  currency,
  trigger,
  label = 'Move to another account',
  onMoved,
}: {
  householdId: string;
  ids: string[];
  from?: string;
  currency?: string;
  trigger: 'button' | 'select';
  label?: string | undefined;
  onMoved?: () => void;
}) {
  const invalidate = useInvalidateLedger(householdId);
  const accounts = (useQuery(accountsQuery(householdId, 'all')).data ?? []).filter(
    (a) => a.yourAccess === 'owner' && a.id !== from && (!currency || a.currency === currency),
  );
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: (accountId: string) =>
      api<Data<BulkUpdateResult>>('POST', `${base(householdId)}/transactions/move`, {
        body: { ids, accountId },
      }),
    onSuccess: async (r, accountId) => {
      await invalidate();
      const name = accounts.find((a) => a.id === accountId)?.name ?? 'the account';
      const { updated, refused } = r.data;
      const why = refused.map((x) => MOVE_REFUSALS[x.code]);
      toast(
        updated.length === 1 && ids.length === 1
          ? `Moved to ${name}.`
          : `${updated.length} moved to ${name}.`,
        {
          ...(refused.length
            ? { description: `${refused.length} not moved: ${[...new Set(why)].join('; ')}.` }
            : {}),
        },
      );
      setOpen(false);
      onMoved?.();
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  if (accounts.length === 0) return null;

  const picker = (
    <Select
      aria-label="Move to account"
      placeholder="Move to account"
      value={trigger === 'select' ? null : target}
      onChange={(v) => {
        if (!v) return;
        if (trigger === 'select') move.mutate(String(v));
        else setTarget(String(v));
      }}
      triggerClassName={trigger === 'select' ? 'min-w-44' : undefined}
    >
      {accounts.map((a) => (
        <SelectItem key={a.id} id={a.id}>
          {a.name}
        </SelectItem>
      ))}
    </Select>
  );
  if (trigger === 'select') return picker;
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button variant="secondary" size="sm">
        <Landmark aria-hidden className="size-4" /> {label}
      </Button>
      <Dialog title={label} size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            For a bank that reported it under the wrong account. Both balances update; a split moves
            with all its parts.
          </p>
          {picker}
          <DialogActions>
            <Button variant="secondary" onPress={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              isDisabled={!target}
              isPending={move.isPending}
              onPress={() => target && move.mutate(target)}
            >
              Move
            </Button>
          </DialogActions>
        </div>
      </Dialog>
    </DialogTrigger>
  );
}

const MOVE_REFUSALS: Record<BulkUpdateResult['refused'][number]['code'], string> = {
  not_found: 'no longer there',
  forbidden: 'not in an account you own',
  not_editable: 'part of a split (move the whole purchase), or from a bank feed',
  different_currency: 'in another currency',
  already_there: 'already imported into that account',
};

/** "Transfer to Savings", or "Transfer from Bea" when you can't see the account (F1). */
export function transferLabel(t: Transaction, members: HouseholdMember[]): string {
  const other =
    t.transfer?.account?.name ??
    (t.transfer?.ownerIds ?? [])
      .map((id) => {
        const m = members.find((x) => x.id === id);
        return m?.isYou ? 'you' : (m?.displayName ?? 'someone');
      })
      .join(' and ');
  return `Transfer ${t.amountMinor < 0 ? 'to' : 'from'} ${other || 'another account'}`;
}

/**
 * The transfer this transaction is one side of, with Unlink; or "Link as a transfer", choosing the
 * other side among transactions of the opposite amount in your other accounts (TXN-08).
 */
/** Whether "Link as a transfer" applies: you own it, it's whole, posted, and not linked. */
const canLinkTransfer = (t: Transaction) =>
  t.can.transfer && !t.transfer && !t.transferExternal && !t.hasSplits && !t.parentId && !t.pending;

function TransferSection({
  householdId,
  t,
  members,
  linking: open,
  onLinkingChange: setOpen,
}: {
  householdId: string;
  t: Transaction;
  members: HouseholdMember[];
  /** The picker is open (its toggle is in the drawer's actions). */
  linking: boolean;
  onLinkingChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateLedger(householdId);
  const [choice, setChoice] = useState<string | null>(null);
  const url = `${base(householdId)}/transactions/${t.id}`;
  const candidates = useQuery({
    queryKey: ['households', householdId, 'transactions', 'transfer-candidates', t.id],
    queryFn: async () => (await api<Data<Transaction[]>>('GET', `${url}/transfer-candidates`)).data,
    enabled: open,
  });
  const link = useMutation({
    mutationFn: (transactionId: string) =>
      api('POST', `${url}/transfer`, { body: { transactionId } }),
    onSuccess: async () => {
      await invalidate();
      toast('Linked as a transfer.', {
        description: 'Both sides are in Transfers now, so they don’t count as spending or income.',
      });
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const external = useMutation({
    mutationFn: (transferExternal: boolean) =>
      api('PATCH', url, {
        body: { transferExternal },
        headers: { 'if-match': `"v${t.version}"` },
      }),
    onSuccess: () => invalidate(),
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const unlink = useMutation({
    mutationFn: () => api('DELETE', `${url}/transfer`),
    onSuccess: async () => {
      await invalidate();
      toast('Transfer unlinked.', { description: 'Each side has its earlier category back.' });
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });

  if (t.transfer) {
    return (
      <section className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
        <ArrowLeftRight aria-hidden className="size-4 text-muted" />
        <p className="mr-auto text-sm">
          {transferLabel(t, members)}
          {t.transfer.account?.mask ? (
            <span className="text-muted"> ··{t.transfer.account.mask}</span>
          ) : null}
        </p>
        {t.can.transfer && t.transfer.account ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => unlink.mutate()}
            isPending={unlink.isPending}
          >
            <Unlink aria-hidden className="size-4" /> Unlink
          </Button>
        ) : null}
      </section>
    );
  }
  if (t.transferExternal) {
    return (
      <section className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
        <ArrowLeftRight aria-hidden className="size-4 text-muted" />
        <p className="mr-auto text-sm">Transfer with an account outside Fiscus</p>
        {t.can.categorize ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => external.mutate(false)}
            isPending={external.isPending}
          >
            It isn’t
          </Button>
        ) : null}
      </section>
    );
  }
  if (!canLinkTransfer(t)) return null;
  const list = candidates.data ?? [];
  // Inline rather than a nested dialog, under the drawer's actions.
  return (
    <div className="space-y-2">
      {open ? (
        <section
          aria-label="Link as a transfer"
          className="space-y-3 rounded-lg border border-border p-3"
        >
          <p className="text-sm text-muted">
            Money moved between your own accounts isn’t spending or income. Pick the other side:
          </p>
          {candidates.isPending ? (
            <LoadingRegion label="Finding the other side">
              <Skeleton className="h-24" />
            </LoadingRegion>
          ) : list.length === 0 ? (
            <Alert tone="info">
              Nothing matches. The other side is the same amount{' '}
              {t.amountMinor < 0 ? 'coming into' : 'going out of'} another account you own, within
              about a week.
            </Alert>
          ) : (
            <RadioGroup
              aria-label="The other side"
              value={choice}
              onChange={setChoice}
              className="gap-0 divide-y divide-border rounded-lg border border-border"
            >
              {list.map((c) => (
                <Radio key={c.id} value={c.id} className="px-3 py-2">
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {c.account?.name ?? c.displayName}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        <DateText value={c.date} /> · {c.displayName}
                      </span>
                    </span>
                    <Amount minor={c.amountMinor} currency={c.currency} className="text-sm" />
                  </span>
                </Radio>
              ))}
            </RadioGroup>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onPress={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              isDisabled={!choice || !list.some((c) => c.id === choice)}
              isPending={link.isPending}
              onPress={() => choice && link.mutate(choice)}
            >
              Link
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** "Make a rule" from a transaction: a new rule matching its description, doing what it has. */
function MakeRule({
  householdId,
  t,
  groups,
  members,
}: {
  householdId: string;
  t: Transaction;
  groups: CategoryGroup[];
  members: HouseholdMember[];
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const tags = useQuery(tagsQuery(householdId)).data ?? [];
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const household = useQuery(householdQuery(householdId)).data;
  const { uncategorized } = categoryIndex(groups);
  return (
    <>
      <Button variant="secondary" size="sm" onPress={() => setOpen(true)}>
        <Wand2 aria-hidden className="size-4" /> Make a rule
      </Button>
      {open ? (
        <RuleEditor
          householdId={householdId}
          rule={null}
          initial={{
            conditions: {
              description: { op: 'contains', value: suggestMatchText(t.originalDescription) },
            },
            actions: {
              ...(t.displayName !== t.originalDescription ? { rename: t.displayName } : {}),
              ...(t.categoryId && t.categoryId !== uncategorized
                ? { categoryId: t.categoryId }
                : {}),
              ...(t.tagIds.length ? { addTagIds: t.tagIds } : {}),
            },
          }}
          groups={groups}
          tags={tags}
          members={members}
          accounts={accounts}
          currency={household?.baseCurrency ?? t.currency}
          onClose={() => setOpen(false)}
          onSaved={() =>
            void queryClient.invalidateQueries({ queryKey: ['households', householdId] })
          }
        />
      ) : null}
    </>
  );
}
