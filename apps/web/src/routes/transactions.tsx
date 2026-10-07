// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  BulkUpdateResult,
  CategoryGroup,
  HouseholdMember,
  Tag,
  Transaction,
} from '@fiscus/shared';
import { MEMBER_COLORS } from '@fiscus/shared';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeftRight, Plus, Search, SplitSquareHorizontal, Upload, Wand2 } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  accountsQuery,
  categoriesQuery,
  householdQuery,
  membersQuery,
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
  Checkbox,
  ConfirmDialog,
  DatePicker,
  DateText,
  Dialog,
  DialogActions,
  DialogTrigger,
  Form,
  LoadingRegion,
  SegmentedControl,
  Select,
  SelectItem,
  SelectSection,
  Skeleton,
  Switch,
  TagPicker,
  TextField,
  toast,
  useToday,
} from '../components/ui.js';
import { categoryIndex, byDay, forLabel, paidByLabel } from '../lib/transactions.js';
import { lensVisible, parseLens } from '../lib/lens.js';
import { rangeParams } from '../lib/ranges.js';
import { RuleEditor, RuleSuggestion, suggestMatchText, useRuleSuggestionContext } from './rules.js';
import { type SuggestedRule, suggestRule } from '../lib/rules.js';
import { useRange } from '../lib/use-range.js';

type Data<T> = { data: T };
const base = (householdId: string) => `/api/v1/households/${householdId}`;
const ALL = '__all__';

function useInvalidateLedger(householdId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      ['transactions', 'accounts', 'net-worth'].map((k) =>
        queryClient.invalidateQueries({ queryKey: ['households', householdId, k] }),
      ),
    );
}

/** A category picker grouped like the household's categories. */
function CategorySelect({
  groups,
  value,
  onChange,
  label = 'Category',
  hideLabel,
  isDisabled,
}: {
  groups: CategoryGroup[];
  value: string | null;
  onChange: (id: string) => void;
  label?: string;
  hideLabel?: boolean;
  isDisabled?: boolean;
}) {
  const { uncategorized } = categoryIndex(groups);
  return (
    <Select
      {...(hideLabel ? { 'aria-label': label } : { label })}
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

// ── List ─────────────────────────────────────────────────────────────────────────────────────

export function TransactionList({
  householdId,
  filters,
  members,
  groups,
  selectable,
  selected,
  onSelectedChange,
  onOpen,
}: {
  householdId: string;
  filters: TransactionFilters;
  members: HouseholdMember[];
  groups: CategoryGroup[];
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
  onOpen: (id: string) => void;
}) {
  const query = useInfiniteQuery(transactionsQuery(householdId, filters));
  const { names } = categoryIndex(groups);
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
      <p className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted">
        No transactions match.
      </p>
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
                  className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{t.displayName}</span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                      <span>
                        {t.categoryId
                          ? (names.get(t.categoryId) ?? 'Uncategorized')
                          : 'Uncategorized'}
                      </span>
                      <span aria-hidden>·</span>
                      <span>{t.account ? t.account.name : paidByLabel(t, members)}</span>
                      {shared ? (
                        <>
                          <span aria-hidden>·</span>
                          <span>{forLabel(t, members)}</span>
                        </>
                      ) : null}
                      {t.reviewStatus === 'needs_review' ? (
                        <Badge tone="accent">Review</Badge>
                      ) : null}
                      {t.excluded ? <Badge>Excluded</Badge> : null}
                      {t.dateEdited ? <Badge>Date moved</Badge> : null}
                    </span>
                  </span>
                  <Amount
                    minor={t.amountMinor}
                    currency={t.currency}
                    className="text-sm font-medium"
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            onPress={() => void query.fetchNextPage()}
            isPending={query.isFetchingNextPage}
          >
            Show more
          </Button>
        </div>
      ) : null}
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
  // ?review=needs_review opens the list on what needs review (the import's "Review" link).
  const [review, setReview] = useState(search.review === 'needs_review');
  const filters: TransactionFilters = {
    lens,
    range: rangeParams(range.selection).toString(),
    ...(q ? { q } : {}),
    ...(account !== ALL ? { accounts: [account] } : {}),
    ...(review ? { review: 'needs_review' as const } : {}),
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const ownsAny = accounts.some((a) => a.yourAccess === 'owner');

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
        range={range}
        showLens={showLens}
        members={members}
        action={
          household.you.role !== 'viewer' ? (
            <div className="flex gap-2">
              <ButtonLink variant="ghost" to="/h/$householdId/rules" params={{ householdId }}>
                <Wand2 aria-hidden className="size-4" /> Rules
              </ButtonLink>
              <ButtonLink variant="secondary" to="/h/$householdId/import" params={{ householdId }}>
                <Upload aria-hidden className="size-4" /> Import
              </ButtonLink>
              {ownsAny ? (
                <Button onPress={() => setAdding(true)}>
                  <Plus aria-hidden className="size-4" /> Add transaction
                </Button>
              ) : null}
            </div>
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
            <div className="flex flex-wrap items-end gap-3">
              <div className="relative min-w-56 flex-1">
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
              <Select
                aria-label="Account"
                value={account}
                onChange={(v) => v && setAccount(String(v))}
                triggerClassName="min-w-48"
              >
                <SelectItem id={ALL}>All accounts</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} id={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </Select>
              <Switch isSelected={review} onChange={setReview}>
                Needs review
              </Switch>
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

// ── Add ──────────────────────────────────────────────────────────────────────────────────────

function AddTransactionDialog({
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
  // Kept here: the details remount after each save (keyed on the version).
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
          key={`${t.id}:${t.version}`}
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

function TransactionDetails({
  householdId,
  t,
  members,
  groups,
  onDeleted,
  onSuggest,
}: {
  householdId: string;
  t: Transaction;
  members: HouseholdMember[];
  groups: CategoryGroup[];
  onDeleted: () => void;
  onSuggest: (s: SuggestedRule | null) => void;
}) {
  const invalidate = useInvalidateLedger(householdId);
  const queryClient = useQueryClient();
  const tags = useQuery(tagsQuery(householdId)).data ?? [];
  const url = `${base(householdId)}/transactions/${t.id}`;
  const manual = t.source === 'manual';
  const [form, setForm] = useState({
    displayName: t.displayName,
    categoryId: t.categoryId,
    date: t.date,
    amountMinor: t.amountMinor,
    reviewed: t.reviewStatus === 'reviewed',
    excluded: t.excluded,
    tagIds: t.tagIds,
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const changes: Record<string, unknown> = {};
  if (form.displayName !== t.displayName) changes.displayName = form.displayName;
  if (form.categoryId !== t.categoryId) changes.categoryId = form.categoryId;
  if (form.date !== t.date) changes.date = form.date;
  if (manual && form.amountMinor !== t.amountMinor) changes.amountMinor = form.amountMinor;
  if (form.reviewed !== (t.reviewStatus === 'reviewed'))
    changes.reviewStatus = form.reviewed ? 'reviewed' : 'needs_review';
  if (form.excluded !== t.excluded) changes.excluded = form.excluded;
  if ([...form.tagIds].sort().join() !== [...t.tagIds].sort().join()) changes.tagIds = form.tagIds;

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
      await invalidate();
      toast('Saved.');
      // Renamed or recategorized: offer to do the same for the others, next time too.
      onSuggest(
        suggestRule(
          {
            originalDescription: t.originalDescription,
            accountId: t.account?.id ?? null,
            amountMinor: t.amountMinor,
          },
          body as { displayName?: string; categoryId?: string | null },
          rules,
          muted,
          categoryIndex(groups).uncategorized ?? null,
        ),
      );
    },
    onError,
  });
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
  return (
    <div className="space-y-5">
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
      </div>

      <Form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(changes);
        }}
      >
        <TextField
          label="Name"
          value={form.displayName}
          onChange={(displayName) => set({ displayName })}
          isReadOnly={!t.can.categorize}
          maxLength={200}
        />
        <CategorySelect
          groups={groups}
          value={form.categoryId}
          onChange={(categoryId) => set({ categoryId })}
          isDisabled={!t.can.categorize}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <DatePicker
              label="Date"
              value={form.date}
              onChange={(d) => d && set({ date: d })}
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
              value={form.amountMinor}
              onChange={(v) => v !== null && set({ amountMinor: v })}
            />
          ) : null}
        </div>
        <TagPicker
          tags={tags}
          value={form.tagIds}
          onChange={(tagIds) => set({ tagIds })}
          onCreate={async (name) => {
            const r = await api<Data<Tag>>('POST', `${base(householdId)}/tags`, {
              body: { name, color: MEMBER_COLORS[tags.length % MEMBER_COLORS.length] },
            });
            await queryClient.invalidateQueries({ queryKey: tagsQuery(householdId).queryKey });
            return r.data;
          }}
          isDisabled={!t.can.categorize}
        />
        <div className="space-y-1">
          <Switch
            isSelected={form.reviewed}
            onChange={(reviewed) => set({ reviewed })}
            isDisabled={!t.can.categorize}
          >
            Reviewed
          </Switch>
          <Switch
            isSelected={form.excluded}
            onChange={(excluded) => set({ excluded })}
            isDisabled={!t.can.edit}
          >
            Leave out of reports and budgets
          </Switch>
        </div>
        {t.can.categorize || t.can.edit ? (
          <div className="flex justify-end">
            <Button
              type="submit"
              isPending={save.isPending}
              isDisabled={Object.keys(changes).length === 0}
            >
              Save changes
            </Button>
          </div>
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
        <SplitEditor householdId={householdId} t={t} groups={groups} />
      ) : null}

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
    { amountMinor: (t.amountMinor - half) as number | null, categoryId: t.categoryId },
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
                onPress={() =>
                  setParts([...parts, { amountMinor: left, categoryId: t.categoryId }])
                }
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
      <Button variant="ghost" size="sm" className="-ml-2.5 mt-1">
        {label}
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
      <Button variant="ghost" size="sm" className="-ml-2.5 mt-1" onPress={() => setOpen(true)}>
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
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
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
