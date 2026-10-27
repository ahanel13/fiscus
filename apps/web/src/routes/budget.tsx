// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BudgetMonth,
  BudgetSummary,
  CategoryGroup,
  CategoryLimitRow,
  Household,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, PiggyBank } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  budgetMonthQuery,
  budgetsQuery,
  budgetSuggestionQuery,
  categoriesQuery,
  householdQuery,
  membersQuery,
} from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import {
  Alert,
  AmountInput,
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  LoadingRegion,
  SegmentedControl,
  Skeleton,
  Switch,
  toast,
} from '../components/ui.js';

// Budget (#103, budgeting walkthrough §2–§3.1): the one-step start, then a month of category
// limits. One budget shows no scope at all (D21); with two, an Ours · Mine switch (D16).

const base = (householdId: string) => `/api/v1/households/${householdId}`;

/** `YYYY-MM`, `n` months from `month`. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** How far through `month` today is, 0–1; null for any other month. */
export function monthProgress(month: string, today = new Date()): number | null {
  const current = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  if (month !== current) return null;
  const days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  return today.getDate() / days;
}

export function BudgetPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const search = useSearch({ strict: false }) as { month?: string; scope?: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const list = useQuery(budgetsQuery(householdId));
  const month = /^\d{4}-\d{2}$/.test(search.month ?? '') ? search.month! : thisMonth();

  if (list.isPending) {
    return (
      <>
        <PageHeader title="Budget" showLens={false} members={members} />
        <LoadingRegion label="Loading the budget">
          <div className="mx-auto max-w-5xl space-y-3 p-4 md:p-8">
            <Skeleton className="h-20" />
            <Skeleton className="h-64" />
          </div>
        </LoadingRegion>
      </>
    );
  }
  if (list.isError) {
    return (
      <>
        <PageHeader title="Budget" showLens={false} members={members} />
        <div className="mx-auto max-w-5xl p-4 md:p-8">
          <Alert>Couldn’t load the budget. Try again in a moment.</Alert>
        </div>
      </>
    );
  }
  const budgets = list.data;
  const chosen =
    budgets.find((b) => b.scope === search.scope) ??
    budgets.find((b) => b.scope === 'mine') ??
    budgets[0];

  return (
    <>
      <PageHeader
        title="Budget"
        showLens={false}
        members={members}
        action={budgets.length > 1 ? <ScopeSwitch budgets={budgets} chosen={chosen!} /> : null}
      />
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 md:px-8">
        {chosen ? (
          <MonthView household={household} budget={chosen} month={month} />
        ) : (
          <SetUp household={household} memberCount={members.length} />
        )}
      </div>
    </>
  );
}

/** Ours · Mine, only once there are two budgets to tell apart (D16). */
function ScopeSwitch({ budgets, chosen }: { budgets: BudgetSummary[]; chosen: BudgetSummary }) {
  const navigate = useNavigate();
  return (
    <SegmentedControl
      aria-label="Whose budget"
      options={budgets.map((b) => ({
        value: b.scope,
        label: b.scope === 'mine' ? 'Mine' : 'Ours',
      }))}
      value={chosen.scope}
      onChange={(scope) =>
        void navigate({
          to: '.',
          search: (prev: Record<string, unknown>) => ({ ...prev, scope }),
          replace: true,
        })
      }
    />
  );
}

// ── Setting up (§2, D5) ──────────────────────────────────────────────────────────────────────

function SetUp({ household, memberCount }: { household: Household; memberCount: number }) {
  const householdId = household.id;
  const queryClient = useQueryClient();
  const suggestion = useQuery(budgetSuggestionQuery(householdId));
  const [reviewing, setReviewing] = useState(false);
  const canEdit = household.you.role !== 'viewer';
  const start = useMutation({
    mutationFn: (amounts: { categoryId: string; amountMinor: number }[]) =>
      api('POST', `${base(householdId)}/budgets`, { body: { amounts } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'budgets'] });
      toast('Your budget has started.');
    },
    onError: (e) => toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' }),
  });

  if (!canEdit) {
    return (
      <EmptyState icon={PiggyBank} title="No budget yet">
        <p>When an owner or member sets one up, it shows here.</p>
      </EmptyState>
    );
  }
  const s = suggestion.data;
  const total = s?.average.reduce((sum, a) => sum + a.amountMinor, 0) ?? 0;
  if (reviewing && s) {
    return (
      <StartingAmounts
        household={household}
        suggestion={s}
        isPending={start.isPending}
        onCancel={() => setReviewing(false)}
        onStart={(amounts) => start.mutate(amounts)}
      />
    );
  }
  const scopeLine =
    s?.scope === 'household'
      ? 'A shared budget, for what’s yours and everyone’s together. Each of you can add a budget of your own later.'
      : memberCount > 1
        ? 'Your own budget: it counts what’s yours alone, and only you see it.'
        : null;
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-6">
        <h2 className="text-lg font-semibold">Start a budget</h2>
        <p className="max-w-2xl text-sm text-muted">
          A budget is a plan for what you spend. Fiscus suggests a limit for each category from your
          last 3 months, and you can change every amount before you start, and any time after.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            isDisabled={!s || s.average.length === 0}
            isPending={suggestion.isPending}
            onPress={() => setReviewing(true)}
          >
            Start from the last 3 months
          </Button>
          <Button variant="secondary" isPending={start.isPending} onPress={() => start.mutate([])}>
            Start from zero
          </Button>
        </div>
        {s && s.average.length > 0 ? (
          <p className="text-xs text-muted">
            About <Amount minor={total} currency={household.baseCurrency} kind="balance" /> a month
            across {s.average.length} {s.average.length === 1 ? 'category' : 'categories'}
          </p>
        ) : s ? (
          <p className="text-xs text-muted">
            There’s no spending in the last 3 months to start from yet: start from zero, and set
            limits as you go.
          </p>
        ) : null}
      </Card>
      {scopeLine ? <p className="text-sm text-muted">{scopeLine}</p> : null}
      <p className="text-xs text-muted">
        It starts as category limits: a limit per category, like most budgeting apps.
      </p>
    </div>
  );
}

function StartingAmounts({
  household,
  suggestion,
  isPending,
  onCancel,
  onStart,
}: {
  household: Household;
  suggestion: { average: { categoryId: string; amountMinor: number }[] };
  isPending: boolean;
  onCancel: () => void;
  onStart: (amounts: { categoryId: string; amountMinor: number }[]) => void;
}) {
  const groups = useQuery(categoriesQuery(household.id)).data ?? [];
  const [amounts, setAmounts] = useState(
    () => new Map(suggestion.average.map((a) => [a.categoryId, a.amountMinor as number | null])),
  );
  const total = [...amounts.values()].reduce<number>((s, v) => s + (v ?? 0), 0);
  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">Your starting budget</h2>
        <p className="text-sm text-muted">
          Each category’s average over the last 3 months, rounded. Change any of them, or clear one
          to leave it out.
        </p>
      </div>
      {groups.map((g) => {
        const here = g.categories.filter((c) => amounts.has(c.id));
        if (here.length === 0) return null;
        return (
          <section key={g.id} className="max-w-sm space-y-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{g.name}</h3>
            {here.map((c) => (
              <AmountInput
                key={c.id}
                label={c.name}
                currency={household.baseCurrency}
                value={amounts.get(c.id) ?? null}
                onChange={(v) => setAmounts(new Map(amounts).set(c.id, v))}
              />
            ))}
          </section>
        );
      })}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <p className="mr-auto text-sm">
          <Amount
            minor={total}
            currency={household.baseCurrency}
            kind="balance"
            className="font-semibold"
          />{' '}
          <span className="text-muted">a month</span>
        </p>
        <Button variant="secondary" onPress={onCancel}>
          Back
        </Button>
        <Button
          isPending={isPending}
          onPress={() =>
            onStart(
              [...amounts]
                .filter(([, v]) => v !== null && v > 0)
                .map(([categoryId, amountMinor]) => ({ categoryId, amountMinor: amountMinor! })),
            )
          }
        >
          Start budgeting
        </Button>
      </div>
    </Card>
  );
}

// ── A month (§3, §3.1) ───────────────────────────────────────────────────────────────────────

function MonthStepper({ month, startsMonth }: { month: string; startsMonth: string }) {
  const navigate = useNavigate();
  const go = (m: string) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, month: m }),
      replace: true,
    });
  const current = thisMonth();
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Month">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous month"
        isDisabled={month <= startsMonth}
        onPress={() => go(addMonths(month, -1))}
      >
        <ChevronLeft aria-hidden className="size-4" />
      </Button>
      <span className="min-w-36 text-center text-sm font-medium" aria-live="polite">
        {monthName(month)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next month"
        isDisabled={month >= addMonths(current, 12)}
        onPress={() => go(addMonths(month, 1))}
      >
        <ChevronRight aria-hidden className="size-4" />
      </Button>
      {month !== current ? (
        <Button variant="ghost" size="sm" onPress={() => go(current)}>
          This month
        </Button>
      ) : null}
    </div>
  );
}

function MonthView({
  household,
  budget,
  month,
}: {
  household: Household;
  budget: BudgetSummary;
  month: string;
}) {
  const shown = month < budget.startsMonth ? budget.startsMonth : month;
  const data = useQuery(budgetMonthQuery(household.id, budget.id, shown));
  const groups = useQuery(categoriesQuery(household.id)).data ?? [];
  const [editing, setEditing] = useState<{ categoryId: string; row?: CategoryLimitRow } | null>(
    null,
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonthStepper month={shown} startsMonth={budget.startsMonth} />
        <Badge>Category limits</Badge>
      </div>
      {data.isPending ? (
        <LoadingRegion label="Loading the month">
          <div className="space-y-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-64" />
          </div>
        </LoadingRegion>
      ) : data.isError ? (
        <Alert>Couldn’t load {monthName(shown)}. Try again in a moment.</Alert>
      ) : (
        <MonthBody
          data={data.data}
          groups={groups}
          householdId={household.id}
          onEdit={data.data.canEdit ? setEditing : undefined}
        />
      )}
      {editing && data.data ? (
        <LimitDialog
          householdId={household.id}
          month={data.data}
          categoryId={editing.categoryId}
          row={editing.row}
          name={categoryName(groups, editing.categoryId)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

const categoryName = (groups: CategoryGroup[], id: string) =>
  groups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? 'A deleted category';

function MonthBody({
  data,
  groups,
  householdId,
  onEdit,
}: {
  data: BudgetMonth;
  groups: CategoryGroup[];
  householdId: string;
  onEdit: ((e: { categoryId: string; row?: CategoryLimitRow }) => void) | undefined;
}) {
  const { view, currency, month } = data;
  const progress = monthProgress(month);
  const rows = new Map(view.rows.map((r) => [r.categoryId, r]));
  const uncategorized = groups
    .flatMap((g) => g.categories)
    .find((c) => c.systemKey === 'uncategorized')?.id;
  const money = (minor: number, className?: string) => (
    <Amount minor={minor} currency={currency} kind="balance" className={className} />
  );

  return (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
        <Stat label="Money in">{money(view.incomeMinor)}</Stat>
        <Stat label="Budgeted">{money(view.totals.budgetedMinor)}</Stat>
        <Stat
          label="Spent"
          note={progress !== null ? `${Math.round(progress * 100)}% of the month gone` : undefined}
        >
          {money(view.totals.spentMinor)}
        </Stat>
        <Stat
          label="Left in your budgets"
          note={
            view.totals.overCount
              ? `${view.totals.overCount} ${view.totals.overCount === 1 ? 'category' : 'categories'} over`
              : undefined
          }
          noteTone={view.totals.overCount ? 'danger' : undefined}
        >
          {money(view.totals.leftMinor)}
        </Stat>
      </div>

      {view.rows.length === 0 && view.notBudgeted.length === 0 ? (
        <EmptyState icon={PiggyBank} title={`Nothing in ${monthName(month)} yet`}>
          <p>Set a limit for a category to start tracking it, or wait for spending to arrive.</p>
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="hidden grid-cols-[minmax(0,1fr)_7rem_7rem_8rem] gap-3 border-b border-border px-4 py-2 text-xs text-muted sm:grid">
            <span>Category</span>
            <span className="text-right">Budgeted</span>
            <span className="text-right">Spent</span>
            <span className="text-right">Left</span>
          </div>
          {groups.map((g) => {
            const here = g.categories.filter((c) => rows.has(c.id));
            if (here.length === 0) return null;
            return (
              <section key={g.id}>
                <h3 className="border-b border-border bg-bg px-4 py-1.5 text-xs font-semibold tracking-wide text-muted">
                  {g.name}
                </h3>
                <ul className="divide-y divide-border">
                  {here.map((c) => {
                    const r = rows.get(c.id)!;
                    return (
                      <li key={c.id}>
                        <LimitRow
                          name={c.name}
                          row={r}
                          currency={currency}
                          progress={progress}
                          onEdit={onEdit ? () => onEdit({ categoryId: c.id, row: r }) : undefined}
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {view.notBudgeted.length ? (
            <section>
              <h3 className="border-b border-border bg-bg px-4 py-1.5 text-xs font-semibold tracking-wide text-muted">
                Not budgeted
              </h3>
              <ul className="divide-y divide-border">
                {view.notBudgeted.map((n) => (
                  <li key={n.categoryId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1 text-sm">
                      {categoryName(groups, n.categoryId)}
                      <span className="text-muted">
                        {n.categoryId === uncategorized ? ' · needs a category' : ' · no limit set'}
                      </span>
                    </span>
                    {money(n.spentMinor, 'text-sm')}
                    {n.categoryId === uncategorized ? (
                      <Link
                        to={`/h/${householdId}/review`}
                        className="text-sm font-medium text-accent-text underline"
                      >
                        Review
                      </Link>
                    ) : onEdit ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => onEdit({ categoryId: n.categoryId })}
                      >
                        Set limit
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}

function Stat({
  label,
  note,
  noteTone,
  children,
}: {
  label: string;
  note?: string | undefined;
  noteTone?: 'danger' | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg font-semibold">{children}</p>
      {note ? (
        <p className={clsx('text-xs', noteTone === 'danger' ? 'text-danger' : 'text-muted')}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** One category: its bar (with a mark for how far through the month it is), and the numbers. */
function LimitRow({
  name,
  row,
  currency,
  progress,
  onEdit,
}: {
  name: string;
  row: CategoryLimitRow;
  currency: string;
  progress: number | null;
  onEdit: (() => void) | undefined;
}) {
  const available = row.budgetedMinor + row.rolledInMinor;
  const used = available > 0 ? Math.min(1, row.spentMinor / available) : row.spentMinor > 0 ? 1 : 0;
  const over = row.leftMinor < 0;
  const body = (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-left sm:grid-cols-[minmax(0,1fr)_7rem_7rem_8rem]">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {name}
          {row.rollover ? <Badge className="ml-2">Rollover</Badge> : null}
        </p>
        {row.rolledInMinor !== 0 ? (
          <p className="text-xs text-muted">
            <Amount minor={row.rolledInMinor} currency={currency} kind="flow" /> rolled over from
            last month
          </p>
        ) : null}
        <div
          className="relative mt-1.5 h-1.5 max-w-md rounded-full bg-surface-2"
          role="meter"
          aria-label={`${name}: ${Math.round(used * 100)}% used`}
          aria-valuenow={Math.round(used * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={clsx('h-full rounded-full', over ? 'bg-danger' : 'bg-accent')}
            style={{ width: `${used * 100}%` }}
          />
          {progress !== null ? (
            <span
              aria-hidden
              className="absolute -top-1 -bottom-1 w-0.5 bg-fg/40"
              style={{ left: `${progress * 100}%` }}
            />
          ) : null}
        </div>
      </div>
      <span className="hidden text-right text-sm sm:block">
        <Amount minor={row.budgetedMinor} currency={currency} kind="balance" />
      </span>
      <span className="hidden text-right text-sm sm:block">
        <Amount minor={row.spentMinor} currency={currency} kind="balance" />
      </span>
      <span className={clsx('text-right text-sm font-semibold', over && 'text-danger')}>
        {over ? (
          <>
            <Amount minor={-row.leftMinor} currency={currency} kind="balance" /> over
          </>
        ) : (
          <>
            <Amount minor={row.leftMinor} currency={currency} kind="balance" />
            <span className="font-normal text-muted sm:hidden"> left</span>
          </>
        )}
      </span>
    </div>
  );
  return onEdit ? (
    <button
      type="button"
      onClick={onEdit}
      className="block w-full hover:bg-surface-2"
      aria-label={`Change ${name}’s limit`}
    >
      {body}
    </button>
  ) : (
    body
  );
}

/** A category's limit for this month, and whether what's left rolls over (§3.1). */
function LimitDialog({
  householdId,
  month,
  categoryId,
  row,
  name,
  onClose,
}: {
  householdId: string;
  month: BudgetMonth;
  categoryId: string;
  row: CategoryLimitRow | undefined;
  name: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState<number | null>(row?.budgetedMinor ?? null);
  const [rollover, setRollover] = useState(row?.rollover ?? false);
  const budgetUrl = `${base(householdId)}/budgets/${month.budget.id}`;
  const save = useMutation({
    mutationFn: async () => {
      if (amount !== (row?.budgetedMinor ?? null)) {
        await api('PUT', `${budgetUrl}/months/${month.month}/amounts/${categoryId}`, {
          body: { amountMinor: amount ?? 0 },
        });
      }
      if (rollover !== (row?.rollover ?? false)) {
        await api('PUT', `${budgetUrl}/categories/${categoryId}`, { body: { rollover } });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['households', householdId, 'budgets', month.budget.id],
      });
      toast(`${name} saved.`);
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  return (
    <Dialog title={name} isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <AmountInput
          label={`Limit for ${monthName(month.month)}`}
          currency={month.currency}
          value={amount}
          onChange={setAmount}
          description="Later months keep it until you change it."
        />
        <Switch isSelected={rollover} onChange={setRollover}>
          Roll over what’s left
        </Switch>
        <p className="text-xs text-muted">
          What’s left at the end of each month, or what’s overspent, moves to the next month’s{' '}
          {name}.
        </p>
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button isPending={save.isPending} onPress={() => save.mutate()}>
            Save
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
