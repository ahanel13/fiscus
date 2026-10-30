// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BudgetCategoryHistory,
  type BudgetMonth,
  type BudgetScope,
  type BudgetSummary,
  type BudgetYear,
  type CategoryGroup,
  type CategoryLimitRow,
  type CategoryLimitsMonth,
  type FlexMonth,
  type HouseholdMember,
  type ScopePreview,
  type StrategyPreview,
  type Household,
  type Transaction,
  formatMoney,
  minorUnitExponent,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Eye, EyeOff, PiggyBank } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  RadioCard,
  RadioGroup,
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
  const search = useSearch({ strict: false }) as {
    month?: string;
    scope?: string;
    view?: string;
    year?: string;
    /** Starting the other budget: `mine` or `household` (D21, D23). */
    add?: string;
  };
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
  const adding =
    (search.add === 'mine' || search.add === 'household') &&
    !budgets.some((b) => b.scope === search.add)
      ? (search.add as BudgetScope)
      : null;
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
        {adding ? (
          <SetUp household={household} memberCount={members.length} scope={adding} />
        ) : chosen && search.view === 'year' ? (
          <YearView
            household={household}
            budget={chosen}
            year={Number(search.year) || fiscalYearOf(month, household.fiscalYearStartMonth)}
          />
        ) : chosen ? (
          <>
            <MonthView household={household} budget={chosen} month={month} />
            <ScopeActions
              household={household}
              budgets={budgets}
              budget={chosen}
              members={members}
            />
          </>
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

// ── Whose budget (§7, §7a) ───────────────────────────────────────────────────────────────

/**
 * What the household's shape offers next (D21, D23, D25): sharing your budget or adding a shared
 * one once there are two of you, adding your own beside a shared one in Hybrid, and making a
 * shared budget yours once you're on your own.
 */
function ScopeActions({
  household,
  budgets,
  budget,
  members,
}: {
  household: Household;
  budgets: BudgetSummary[];
  budget: BudgetSummary;
  members: HouseholdMember[];
}) {
  const navigate = useNavigate();
  const [changing, setChanging] = useState<BudgetScope | null>(null);
  if (household.you.role === 'viewer') return null;
  const people = members.length;
  const has = (scope: BudgetScope) => budgets.some((b) => b.scope === scope);
  const add = (scope: BudgetScope) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, add: scope }),
    });
  let offer: { text: string; label: string; onPress: () => void } | null = null;
  if (budget.scope === 'mine' && people > 1 && !has('household')) {
    offer =
      household.financeStyle === 'combined'
        ? {
            text: 'It’s all yours together now. Share this budget, and it becomes the household’s, with its amounts and history.',
            label: 'Share my budget',
            onPress: () => setChanging('household'),
          }
        : {
            text: 'Plan what you share: a shared budget counts what’s for two or more of you. This one stays yours.',
            label: 'Start a shared budget',
            onPress: () => add('household'),
          };
  } else if (budget.scope === 'household' && people === 1 && !has('mine')) {
    offer = {
      text: 'You’re the only one here now, so a shared budget counts nothing. Make it yours, keeping its amounts and history.',
      label: 'Make it mine',
      onPress: () => setChanging('mine'),
    };
  } else if (
    budget.scope === 'household' &&
    people > 1 &&
    household.financeStyle === 'hybrid' &&
    !has('mine')
  ) {
    offer = {
      text: 'Want a budget for what’s yours alone? Only you see it.',
      label: 'Add a budget of your own',
      onPress: () => add('mine'),
    };
  }
  if (!offer) return null;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="max-w-2xl text-sm text-muted">{offer.text}</p>
        <Button variant="secondary" size="sm" onPress={offer.onPress}>
          {offer.label}
        </Button>
      </div>
      {changing ? (
        <ScopeDialog
          householdId={household.id}
          currency={household.baseCurrency}
          budget={budget}
          target={changing}
          onClose={() => setChanging(null)}
        />
      ) : null}
    </>
  );
}

/** Share my budget, or Make it mine (D25), after a look at what it would count this month. */
function ScopeDialog({
  householdId,
  currency,
  budget,
  target,
  onClose,
}: {
  householdId: string;
  currency: string;
  budget: BudgetSummary;
  target: BudgetScope;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const preview = useQuery({
    queryKey: ['households', householdId, 'budgets', budget.id, 'scope-preview', target],
    queryFn: async () =>
      (
        await api<{ data: ScopePreview }>(
          'GET',
          `${base(householdId)}/budgets/${budget.id}/scope-preview?scope=${target}`,
        )
      ).data,
  });
  const save = useMutation({
    mutationFn: () =>
      api('PUT', `${base(householdId)}/budgets/${budget.id}/scope`, { body: { scope: target } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'budgets'] });
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, scope: target }),
        replace: true,
      });
      toast(
        target === 'household' ? 'Your budget is the household’s now.' : 'The budget is yours now.',
      );
      onClose();
    },
  });
  const err = (save.error ?? preview.error) as ApiError | null;
  const p = preview.data;
  const money = (minor: number) => <Amount minor={minor} currency={currency} kind="balance" />;
  const moneyIn = (v: ScopePreview['before'], scope: BudgetScope) =>
    v.incomeMinor + (scope === 'household' ? v.contributionsMinor : 0);
  const from = budget.scope;
  return (
    <Dialog
      title={target === 'household' ? 'Share my budget' : 'Make it mine'}
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <p className="text-sm">
          {target === 'household'
            ? 'It becomes the household’s budget: everyone in the household sees it, and owners and members can change it. It counts what’s for two or more of you, in every month.'
            : 'It becomes your own budget: only you see it. It counts what’s yours, in every month.'}
        </p>
        <p className="text-sm text-muted">
          Its way of budgeting, its amounts and its past months stay as they are.
        </p>
        {preview.isPending ? (
          <Skeleton className="h-20" />
        ) : p ? (
          <div className="space-y-1 rounded-xl border border-border p-3 text-sm">
            <p className="font-medium">In {monthName(p.month)}</p>
            <p className="flex justify-between gap-4">
              <span className="text-muted">Spent</span>
              <span>
                {money(p.before.totals.spentMinor)} → {money(p.after.totals.spentMinor)}
              </span>
            </p>
            <p className="flex justify-between gap-4">
              <span className="text-muted">Money in</span>
              <span>
                {money(moneyIn(p.before, from))} → {money(moneyIn(p.after, target))}
              </span>
            </p>
          </div>
        ) : null}
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button isPending={save.isPending} isDisabled={!p} onPress={() => save.mutate()}>
            {target === 'household' ? 'Share my budget' : 'Make it mine'}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

// ── Setting up (§2, D5) ──────────────────────────────────────────────────────────────────────

function SetUp({
  household,
  memberCount,
  scope,
}: {
  household: Household;
  memberCount: number;
  /** The other budget, asked for (D23); otherwise the finance style decides (D21). */
  scope?: BudgetScope;
}) {
  const householdId = household.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const suggestion = useQuery(budgetSuggestionQuery(householdId, scope));
  // A shared budget with nothing shared to start from: is it all on accounts that are yours alone?
  const nothingShared =
    suggestion.data?.scope === 'household' && suggestion.data.average.length === 0;
  const yours = useQuery({ ...budgetSuggestionQuery(householdId, 'mine'), enabled: nothingShared });
  const [reviewing, setReviewing] = useState(false);
  const canEdit = household.you.role !== 'viewer';
  const start = useMutation({
    mutationFn: (amounts: { categoryId: string; amountMinor: number }[]) =>
      api('POST', `${base(householdId)}/budgets`, {
        body: { amounts, ...(scope ? { scope } : {}) },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'budgets'] });
      if (scope) {
        void navigate({
          to: '.',
          search: (prev: Record<string, unknown>) => ({ ...prev, add: undefined, scope }),
          replace: true,
        });
      }
      toast(scope === 'household' ? 'The shared budget has started.' : 'Your budget has started.');
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
        <h2 className="text-lg font-semibold">
          {scope === 'household'
            ? 'Start a shared budget'
            : scope === 'mine'
              ? 'Start a budget of your own'
              : 'Start a budget'}
        </h2>
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
          {scope ? (
            <Button
              variant="ghost"
              onPress={() =>
                void navigate({
                  to: '.',
                  search: (prev: Record<string, unknown>) => ({ ...prev, add: undefined }),
                  replace: true,
                })
              }
            >
              Not now
            </Button>
          ) : null}
        </div>
        {s && s.average.length > 0 ? (
          <p className="text-xs text-muted">
            About <Amount minor={total} currency={household.baseCurrency} kind="balance" /> a month
            across {s.average.length} {s.average.length === 1 ? 'category' : 'categories'}
          </p>
        ) : nothingShared && yours.data && yours.data.average.length > 0 ? (
          <div className="space-y-2 rounded-md border border-border p-3 text-sm">
            <p>
              None of your spending in the last 3 months is shared: it’s all on accounts that are
              yours alone, so a shared budget has nothing to start from. A budget of your own starts
              from what you spent, and a shared one can come later.
            </p>
            <Button
              variant="secondary"
              onPress={() =>
                void navigate({
                  to: '.',
                  search: (prev: Record<string, unknown>) => ({ ...prev, add: 'mine' }),
                  replace: true,
                })
              }
            >
              Start a budget of your own
            </Button>
          </div>
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
  const [open, setOpen] = useState<{ categoryId: string; row?: CategoryLimitRow } | null>(null);
  const [yearly, setYearly] = useState<{ categoryId: string; yearlyMinor: number | null } | null>(
    null,
  );
  const [flexible, setFlexible] = useState(false);
  const [switching, setSwitching] = useState(false);
  const strategy = data.data?.view.strategy ?? budget.strategy;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonthStepper month={shown} startsMonth={budget.startsMonth} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{STRATEGY_NAMES[strategy as 'category' | 'flex'] ?? 'Category limits'}</Badge>
          <ViewLink view="year">Annual view</ViewLink>
          {data.data?.canEdit ? (
            <Button variant="ghost" size="sm" onPress={() => setSwitching(true)}>
              Change how you budget
            </Button>
          ) : null}
        </div>
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
      ) : data.data.view.strategy === 'flex' ? (
        <FlexBody
          data={data.data as BudgetMonth & { view: FlexMonth }}
          groups={groups}
          onOpen={setOpen}
          onYearly={data.data.canEdit ? setYearly : undefined}
          onFlexible={data.data.canEdit ? () => setFlexible(true) : undefined}
        />
      ) : (
        <MonthBody
          data={data.data as BudgetMonth & { view: CategoryLimitsMonth }}
          groups={groups}
          householdId={household.id}
          onOpen={setOpen}
        />
      )}
      {yearly && data.data ? (
        <YearlyDialog
          householdId={household.id}
          month={data.data}
          categoryId={yearly.categoryId}
          yearlyMinor={yearly.yearlyMinor}
          name={categoryName(groups, yearly.categoryId)}
          onClose={() => setYearly(null)}
        />
      ) : null}
      {flexible && data.data?.view.strategy === 'flex' ? (
        <FlexibleDialog
          householdId={household.id}
          month={data.data}
          amountMinor={data.data.view.flexible.budgetedMinor}
          onClose={() => setFlexible(false)}
        />
      ) : null}
      {switching && data.data ? (
        <StrategyDialog
          householdId={household.id}
          month={data.data}
          onClose={() => setSwitching(false)}
        />
      ) : null}
      {open && data.data ? (
        <CategoryDrawer
          householdId={household.id}
          month={data.data}
          categoryId={open.categoryId}
          row={
            data.data.view.strategy === 'category'
              ? data.data.view.rows.find((r) => r.categoryId === open.categoryId)
              : open.row
          }
          name={categoryName(groups, open.categoryId)}
          canRollover={data.data.canEdit && data.data.view.strategy === 'category'}
          onEdit={
            data.data.canEdit && data.data.view.strategy === 'flex'
              ? () => {
                  setEditing(open);
                  setOpen(null);
                }
              : undefined
          }
          onClose={() => setOpen(null)}
        />
      ) : null}
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

const SHOW_UNBUDGETED = 'fiscus.budget.showUnbudgeted';

/** Whether this viewer shows categories without a budget; remembered in this browser only. */
function useShowUnbudgeted(): [boolean, (show: boolean) => void] {
  const [show, setShow] = useState(() => {
    try {
      return localStorage.getItem(SHOW_UNBUDGETED) === '1';
    } catch {
      return false;
    }
  });
  return [
    show,
    (next) => {
      setShow(next);
      try {
        if (next) localStorage.setItem(SHOW_UNBUDGETED, '1');
        else localStorage.removeItem(SHOW_UNBUDGETED);
      } catch {
        // Not remembered, but still shown.
      }
    },
  ];
}

const COLLAPSED = 'fiscus.budget.collapsed';

/** The groups you've folded up, by id (Income is `income`), remembered in this browser. */
function useCollapsed(): [ReadonlySet<string>, (id: string) => void] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED) ?? '[]');
      return new Set(Array.isArray(saved) ? saved.filter((x) => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  });
  return [
    collapsed,
    (id) => {
      const next = new Set(collapsed);
      if (!next.delete(id)) next.add(id);
      setCollapsed(next);
      try {
        localStorage.setItem(COLLAPSED, JSON.stringify([...next]));
      } catch {
        // Not remembered, but still folded.
      }
    },
  ];
}

/** A group's header: its name folds it up or opens it, and its totals show either way. */
function GroupHeader({
  id,
  name,
  open,
  onToggle,
  className = 'border-b',
  children,
}: {
  id: string;
  name: string;
  open: boolean;
  onToggle: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <h3
      className={clsx(
        'grid cursor-pointer items-center gap-3 border-border bg-bg px-4 py-2.5 text-sm font-semibold hover:bg-surface-2',
        COLUMNS,
        className,
      )}
      onClick={(e) => {
        if (!(e.target as Element).closest('button')) onToggle();
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className="flex min-w-0 items-center gap-2 text-left"
      >
        <ChevronRight
          aria-hidden
          className={clsx('size-4 shrink-0 text-muted transition-transform', open && 'rotate-90')}
        />
        <span className="truncate">{name}</span>
      </button>
      {children}
    </h3>
  );
}

const COLUMNS = 'grid-cols-[minmax(0,1fr)_7.5rem] sm:grid-cols-[minmax(0,1fr)_8.5rem_7rem_8rem]';

/**
 * A month of category limits, grouped as Monarch does: income on its own, then each spending
 * group with its totals. Categories without a budget are hidden unless asked for, and what they
 * spent is still counted below (D6). Every budgeted amount is edited in place.
 */
function MonthBody({
  data,
  groups,
  householdId,
  onOpen,
}: {
  data: BudgetMonth & { view: CategoryLimitsMonth };
  groups: CategoryGroup[];
  householdId: string;
  onOpen: (e: { categoryId: string; row?: CategoryLimitRow }) => void;
}) {
  const { view, currency, month } = data;
  const progress = monthProgress(month);
  const [showAll, setShowAll] = useShowUnbudgeted();
  const [collapsed, toggle] = useCollapsed();
  const [shownIn, setShownIn] = useState<ReadonlySet<string>>(new Set());
  const rows = new Map(view.rows.map((r) => [r.categoryId, r]));
  const unbudgeted = new Map(view.notBudgeted.map((n) => [n.categoryId, n.spentMinor]));
  const income = new Map(view.income.map((r) => [r.categoryId, r]));
  const uncategorized = groups
    .flatMap((g) => g.categories)
    .find((c) => c.systemKey === 'uncategorized')?.id;
  const money = (minor: number, className?: string) => (
    <Amount minor={minor} currency={currency} kind="balance" className={className} />
  );
  const amount = (categoryId: string, name: string, value: number) => (
    <BudgetAmount
      key={`${categoryId}:${value}`}
      householdId={householdId}
      data={data}
      categoryId={categoryId}
      name={name}
      value={value}
    />
  );

  const incomeGroups = groups.filter((g) => g.kind === 'income');
  const incomeShown = incomeGroups
    .flatMap((g) => g.categories)
    .filter((c) => showAll || income.has(c.id));
  const received = view.income.reduce((s, r) => s + r.receivedMinor, 0);
  // Each group shows its budgeted categories; the rest are a click away in the group, or all at
  // once with the switch.
  const spending = groups
    .filter((g) => g.kind !== 'income' && g.kind !== 'transfer')
    .map((g) => {
      const all = g.categories.filter(
        (c) => c.id !== uncategorized && (!c.archived || rows.has(c.id) || unbudgeted.has(c.id)),
      );
      const others = data.canEdit ? all.filter((c) => !rows.has(c.id)) : [];
      const showOthers = showAll || shownIn.has(g.id);
      return {
        group: g,
        // Budgeted first; unbudgeted ones join below them, so showing them moves nothing.
        categories: [...all.filter((c) => rows.has(c.id)), ...(showOthers ? others : [])],
        others: showAll ? [] : others,
        showOthers,
      };
    })
    .filter((g) => g.categories.length > 0 || g.others.length > 0);
  const hiddenSpent = view.notBudgeted.filter((n) => n.categoryId !== uncategorized);
  const uncategorizedSpent = uncategorized ? unbudgeted.get(uncategorized) : undefined;

  return (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
        <MoneyIn data={data} />
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

      {data.canEdit ? (
        <div className="flex justify-end">
          <Switch isSelected={showAll} onChange={setShowAll}>
            Show unbudgeted categories
          </Switch>
        </div>
      ) : null}

      {incomeShown.length ? (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div
            className={clsx(
              'grid gap-3 border-b border-border px-4 py-2 text-xs font-semibold text-muted',
              COLUMNS,
            )}
          >
            <span>Income</span>
            <span className="text-right">Budgeted</span>
            <span className="hidden text-right sm:block">Received</span>
            <span className="hidden text-right sm:block">Remaining</span>
          </div>
          {collapsed.has('income') ? null : (
            <ul id="budget-group-income" className="divide-y divide-border">
              {incomeShown.map((c) => {
                const r = income.get(c.id) ?? { budgetedMinor: 0, receivedMinor: 0 };
                const remaining = r.budgetedMinor - r.receivedMinor;
                return (
                  <li key={c.id} className={clsx('grid items-center gap-3 px-4 py-2', COLUMNS)}>
                    <span className="min-w-0 truncate text-sm font-medium">
                      {c.name}
                      <span className="block text-xs font-normal text-muted sm:hidden">
                        {money(r.receivedMinor)} received
                      </span>
                    </span>
                    {amount(c.id, c.name, r.budgetedMinor)}
                    <span className="hidden text-right text-sm sm:block">
                      {money(r.receivedMinor)}
                    </span>
                    <span className="hidden text-right text-sm sm:block">
                      {r.budgetedMinor === 0 ? (
                        <span className="text-muted">—</span>
                      ) : remaining < 0 ? (
                        <span className="text-accent-text">{money(-remaining)} more</span>
                      ) : (
                        money(remaining)
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <GroupHeader
            id="budget-group-income"
            name="Total income"
            className="border-t"
            open={!collapsed.has('income')}
            onToggle={() => toggle('income')}
          >
            <span className="text-right">{money(view.totals.incomeBudgetedMinor)}</span>
            <span className="hidden text-right sm:block">{money(received)}</span>
            <span className="hidden sm:block" />
          </GroupHeader>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div
          className={clsx(
            'grid gap-3 border-b border-border px-4 py-2 text-xs font-semibold text-muted',
            COLUMNS,
          )}
        >
          <span>Expenses</span>
          <span className="text-right">Budgeted</span>
          <span className="hidden text-right sm:block">Spent</span>
          <span className="hidden text-right sm:block">Left</span>
        </div>
        {view.rows.length === 0 ? (
          <p className="border-b border-border px-4 py-6 text-sm text-muted">
            No category has a budget in {monthName(month)}.
            {data.canEdit ? ' Show a group’s unbudgeted categories to set some.' : ''}
          </p>
        ) : null}
        {spending.map(({ group, categories, others, showOthers }) => {
          const here = categories.map((c) => rows.get(c.id)).filter((r) => r !== undefined);
          const total = (f: (r: CategoryLimitRow) => number) => here.reduce((s, r) => s + f(r), 0);
          const left = total((r) => r.leftMinor);
          const open = !collapsed.has(group.id);
          return (
            <section key={group.id}>
              <GroupHeader
                id={`budget-group-${group.id}`}
                name={group.name}
                open={open}
                onToggle={() => {
                  // Folding a group puts its unbudgeted categories away too.
                  if (open && shownIn.has(group.id)) {
                    const next = new Set(shownIn);
                    next.delete(group.id);
                    setShownIn(next);
                  }
                  toggle(group.id);
                }}
              >
                <span className="text-right">{money(total((r) => r.budgetedMinor))}</span>
                <span className="hidden text-right sm:block">
                  {money(total((r) => r.spentMinor))}
                </span>
                <span className={clsx('hidden text-right sm:block', left < 0 && 'text-danger')}>
                  {money(left)}
                </span>
              </GroupHeader>
              {open ? (
                <ul
                  id={`budget-group-${group.id}`}
                  className="divide-y divide-border border-b border-border"
                >
                  {categories.map((c) => {
                    const r = rows.get(c.id);
                    return (
                      <li key={c.id}>
                        <LimitRow
                          name={c.name}
                          row={r}
                          spentMinor={r?.spentMinor ?? unbudgeted.get(c.id) ?? 0}
                          currency={currency}
                          progress={progress}
                          amount={
                            data.canEdit
                              ? amount(c.id, c.name, r?.budgetedMinor ?? 0)
                              : money(r?.budgetedMinor ?? 0, 'text-sm')
                          }
                          onOpen={() => onOpen({ categoryId: c.id, row: r })}
                        />
                      </li>
                    );
                  })}
                  {others.length ? (
                    <li>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted hover:bg-surface-2 hover:text-fg"
                        aria-expanded={showOthers}
                        onClick={() => {
                          const next = new Set(shownIn);
                          if (!next.delete(group.id)) next.add(group.id);
                          setShownIn(next);
                        }}
                      >
                        {showOthers ? (
                          <EyeOff aria-hidden className="size-3.5" />
                        ) : (
                          <Eye aria-hidden className="size-3.5" />
                        )}
                        {showOthers ? 'Hide' : 'Show'} {others.length} unbudgeted
                      </button>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </section>
          );
        })}
        {uncategorizedSpent ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 text-sm">
            <span className="min-w-0 flex-1">
              Uncategorized <span className="text-muted">· needs a category</span>
            </span>
            {money(uncategorizedSpent)}
            <Link
              to={`/h/${householdId}/review`}
              className="font-medium text-accent-text underline"
            >
              Review
            </Link>
          </div>
        ) : null}
        {!showAll && hiddenSpent.length ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 text-sm text-muted">
            <span className="min-w-0 flex-1">
              {money(hiddenSpent.reduce((s, n) => s + n.spentMinor, 0))} spent in{' '}
              {hiddenSpent.length} {hiddenSpent.length === 1 ? 'category' : 'categories'} without a
              budget
            </span>
            {data.canEdit ? (
              <Button variant="ghost" size="sm" onPress={() => setShowAll(true)}>
                Show them
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** A category's budget for the month, typed straight into the row; saved on Enter or leaving it. */
function BudgetAmount({
  householdId,
  data,
  categoryId,
  name,
  value,
}: {
  householdId: string;
  data: BudgetMonth;
  categoryId: string;
  name: string;
  value: number;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState<number | null>(value || null);
  const save = useMutation({
    mutationFn: (amountMinor: number) =>
      api(
        'PUT',
        `${base(householdId)}/budgets/${data.budget.id}/months/${data.month}/amounts/${categoryId}`,
        { body: { amountMinor } },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['households', householdId, 'budgets', data.budget.id],
      }),
    onError: (e) => {
      setAmount(value || null);
      toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' });
    },
  });
  return (
    <AmountInput
      aria-label={`${name}: budget for ${monthName(data.month)}`}
      currency={data.currency}
      value={amount}
      placeholder="—"
      // Not disabled while it saves: that would drop focus, out of the drawer too.
      onChange={(next) => {
        setAmount(next);
        if ((next ?? 0) !== value) save.mutate(next ?? 0);
      }}
      onFocus={(e) => (e.target as HTMLInputElement).select()}
    />
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
      <div className="text-lg font-semibold">{children}</div>
      {note ? (
        <p className={clsx('text-xs', noteTone === 'danger' ? 'text-danger' : 'text-muted')}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** A line across a chart at a fraction of its height, labelled just above. */
function ChartLine({
  at,
  label,
  className,
  align,
}: {
  at: number;
  label: string;
  className: string;
  align: 'left' | 'right';
}) {
  return (
    <div
      aria-hidden
      className={clsx('pointer-events-none absolute inset-x-0 z-10 border-t', className)}
      style={{ bottom: `${at * 100}%` }}
    >
      <span
        className={clsx(
          'absolute bottom-0.5 rounded bg-surface/80 px-1 text-[0.7rem] leading-tight text-muted',
          align === 'left' ? 'left-0' : 'right-0',
        )}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * One category: its name and bar (with a mark for how far through the month it is) open its
 * transactions; its budget is typed in beside them. Without a budget, it shows what was spent.
 */
function LimitRow({
  name,
  row,
  spentMinor,
  currency,
  progress,
  amount,
  onOpen,
}: {
  name: string;
  row: CategoryLimitRow | undefined;
  spentMinor: number;
  currency: string;
  progress: number | null;
  amount: React.ReactNode;
  onOpen: () => void;
}) {
  const available = row ? row.budgetedMinor + row.rolledInMinor : 0;
  const used = available > 0 ? Math.min(1, spentMinor / available) : spentMinor > 0 ? 1 : 0;
  const over = row ? row.leftMinor < 0 : false;
  const left = row ? (
    over ? (
      <>
        <Amount minor={-row.leftMinor} currency={currency} kind="balance" /> over
      </>
    ) : (
      <>
        <Amount minor={row.leftMinor} currency={currency} kind="balance" />
        <span className="font-normal text-muted sm:hidden"> left</span>
      </>
    )
  ) : (
    <span className="font-normal text-muted">—</span>
  );
  return (
    // The whole row opens the drawer, like the name does, except the amount you type into. The
    // name stays the button, for the keyboard.
    <div
      className={clsx(
        'grid cursor-pointer items-center gap-x-3 px-4 py-2 hover:bg-surface-2',
        COLUMNS,
      )}
      onClick={(e) => {
        if (!(e.target as Element).closest('input, button, a')) onOpen();
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 py-1 text-left"
        aria-label={`${name}: its transactions and history`}
      >
        <p className="truncate text-sm font-medium">
          {name}
          {row?.rollover ? <Badge className="ml-2">Rollover</Badge> : null}
        </p>
        {row && row.rolledInMinor !== 0 ? (
          <p className="text-xs text-muted">
            <Amount minor={row.rolledInMinor} currency={currency} kind="flow" /> rolled over from
            last month
          </p>
        ) : null}
        {row ? (
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
        ) : (
          <p className="text-xs text-muted">
            No budget
            {spentMinor ? (
              <>
                {' · '}
                <Amount minor={spentMinor} currency={currency} kind="balance" /> spent
              </>
            ) : null}
          </p>
        )}
        <p className={clsx('mt-1 text-xs font-semibold sm:hidden', over && 'text-danger')}>
          {row ? left : null}
        </p>
      </button>
      <div className="text-right">{amount}</div>
      <span className="hidden text-right text-sm sm:block">
        <Amount minor={spentMinor} currency={currency} kind="balance" />
      </span>
      <span
        className={clsx('hidden text-right text-sm font-semibold sm:block', over && 'text-danger')}
      >
        {left}
      </span>
    </div>
  );
}

/** A category's amount for this month, under flex (its limits are typed into their rows). */
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
  const save = useMutation({
    mutationFn: () =>
      api(
        'PUT',
        `${base(householdId)}/budgets/${month.budget.id}/months/${month.month}/amounts/${categoryId}`,
        { body: { amountMinor: amount ?? 0 } },
      ),
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

// ── A category up close (§4) ─────────────────────────────────────────────────────────────────

/** The transactions behind a category's figure this month, and its last six months. */
function CategoryDrawer({
  householdId,
  month,
  categoryId,
  row,
  name,
  onEdit,
  canRollover,
  onClose,
}: {
  householdId: string;
  month: BudgetMonth;
  categoryId: string;
  row: CategoryLimitRow | undefined;
  name: string;
  /** Flex: its amounts aren't in the rows, so they're changed here. */
  onEdit: (() => void) | undefined;
  /** Category limits: the amount is typed in, and rollover switched, right here. */
  canRollover: boolean;
  onClose: () => void;
}) {
  const scope = month.budget.scope;
  const queryClient = useQueryClient();
  const rollover = useMutation({
    mutationFn: (on: boolean) =>
      api('PUT', `${base(householdId)}/budgets/${month.budget.id}/categories/${categoryId}`, {
        body: { rollover: on },
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['households', householdId, 'budgets', month.budget.id],
      }),
    onError: (e) => toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' }),
  });
  const history = useQuery({
    queryKey: [
      'households',
      householdId,
      'budgets',
      month.budget.id,
      'history',
      categoryId,
      month.month,
    ],
    queryFn: async () =>
      (
        await api<{ data: BudgetCategoryHistory }>(
          'GET',
          `${base(householdId)}/budgets/${month.budget.id}/categories/${categoryId}/history?to=${month.month}`,
        )
      ).data,
  });
  const from = `${month.month}-01`;
  const lastDay = new Date(Date.parse(`${addMonths(month.month, 1)}-01T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const txns = useQuery({
    queryKey: ['households', householdId, 'transactions', 'budget', scope, categoryId, month.month],
    queryFn: async () => {
      const params = new URLSearchParams({
        lens: scope === 'mine' ? 'me' : 'shared',
        categories: categoryId,
        from,
        to: lastDay,
        includeExcluded: 'false',
        limit: '100',
      });
      return (
        await api<{ data: Transaction[] }>('GET', `${base(householdId)}/transactions?${params}`)
      ).data.filter((t) => !t.hasSplits);
    },
  });
  const { currency } = month;
  const months = history.data?.months ?? [];
  const average = history.data?.averageSpentMinor ?? null;
  // Lines across the bars for context: what's budgeted this month, and the average spent.
  const budgetLine = row ? row.budgetedMinor + row.rolledInMinor : null;
  const peak = Math.max(
    1,
    average ?? 0,
    budgetLine ?? 0,
    ...months.map((m) => Math.max(m.spentMinor, m.budgetedMinor ?? 0)),
  );

  return (
    <Dialog title={name} variant="drawer" isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <div className="space-y-5">
        <p className="text-sm text-muted">{monthName(month.month)}</p>
        {row ? (
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border">
            {canRollover ? (
              // Typed in as in its row; what rolled over is beside it, not in it.
              <Stat
                label="Budgeted"
                note={
                  row.rolledInMinor
                    ? `${row.rolledInMinor > 0 ? '+' : '−'}${formatMinor(Math.abs(row.rolledInMinor), currency)} rolled over`
                    : undefined
                }
              >
                <BudgetAmount
                  key={row.budgetedMinor}
                  householdId={householdId}
                  data={month}
                  categoryId={categoryId}
                  name={name}
                  value={row.budgetedMinor}
                />
              </Stat>
            ) : (
              <Stat label="Budgeted" note={row.rolledInMinor ? 'with last month’s' : undefined}>
                <Amount
                  minor={row.budgetedMinor + row.rolledInMinor}
                  currency={currency}
                  kind="balance"
                />
              </Stat>
            )}
            <Stat label="Spent">
              <Amount minor={row.spentMinor} currency={currency} kind="balance" />
            </Stat>
            <Stat
              label={row.leftMinor < 0 ? 'Over' : 'Left'}
              noteTone={row.leftMinor < 0 ? 'danger' : undefined}
            >
              <Amount minor={Math.abs(row.leftMinor)} currency={currency} kind="balance" />
            </Stat>
          </div>
        ) : month.canEdit && month.view.strategy === 'category' ? (
          <div className="max-w-48 space-y-1">
            <p className="text-xs text-muted">Budget for {monthName(month.month)}</p>
            <BudgetAmount
              householdId={householdId}
              data={month}
              categoryId={categoryId}
              name={name}
              value={0}
            />
          </div>
        ) : (
          <p className="text-sm">No limit set for {name} this month.</p>
        )}
        {canRollover && row ? (
          <div className="space-y-1">
            <Switch
              isSelected={rollover.isPending ? rollover.variables : row.rollover}
              isDisabled={rollover.isPending}
              onChange={(on) => rollover.mutate(on)}
            >
              Roll over what’s left
            </Switch>
            <p className="text-xs text-muted">
              What’s left at the end of each month, or what’s overspent, moves to the next month’s{' '}
              {name}.
            </p>
          </div>
        ) : null}
        {onEdit ? (
          <Button variant="secondary" onPress={onEdit}>
            {row ? 'Change amount' : 'Set an amount'}
          </Button>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Last 6 months</h3>
          {history.isPending ? (
            <Skeleton className="h-24" />
          ) : (
            <>
              <div
                className="relative mt-4 grid h-24 grid-cols-6 items-end gap-2"
                role="img"
                aria-label={[
                  ...months.map(
                    (m) => `${monthName(m.month)}: spent ${formatMinor(m.spentMinor, currency)}`,
                  ),
                  ...(budgetLine !== null
                    ? [`budgeted this month ${formatMinor(budgetLine, currency)}`]
                    : []),
                  ...(average !== null ? [`average ${formatMinor(average, currency)}`] : []),
                ].join('; ')}
              >
                {budgetLine !== null && budgetLine > 0 ? (
                  <ChartLine
                    at={budgetLine / peak}
                    label={`Budget ${formatMinor(budgetLine, currency)}`}
                    className="border-solid border-fg/40"
                    align="left"
                  />
                ) : null}
                {average !== null ? (
                  <ChartLine
                    at={average / peak}
                    label={`Avg ${formatMinor(average, currency)}`}
                    className="border-dashed border-fg/60"
                    align="right"
                  />
                ) : null}
                {months.map((m) => (
                  <div key={m.month} className="flex h-full items-end justify-center gap-0.5">
                    {m.budgetedMinor !== null ? (
                      <span
                        className="w-2.5 rounded-t bg-border"
                        style={{ height: `${(m.budgetedMinor / peak) * 100}%` }}
                      />
                    ) : null}
                    <span
                      className={clsx(
                        'w-2.5 rounded-t',
                        m.budgetedMinor !== null && m.spentMinor > m.budgetedMinor
                          ? 'bg-danger'
                          : 'bg-accent',
                      )}
                      style={{ height: `${(m.spentMinor / peak) * 100}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-6 gap-2 text-center text-xs text-muted">
                {months.map((m) => (
                  <span key={m.month}>
                    {new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString(undefined, {
                      month: 'short',
                      timeZone: 'UTC',
                    })}
                  </span>
                ))}
              </div>
              {history.data?.averageSpentMinor != null ? (
                <p className="text-xs text-muted">
                  Average spent:{' '}
                  <Amount
                    minor={history.data.averageSpentMinor}
                    currency={currency}
                    kind="balance"
                  />{' '}
                  a month
                </p>
              ) : null}
            </>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">
            This month
            {txns.data
              ? ` · ${txns.data.length} ${txns.data.length === 1 ? 'transaction' : 'transactions'}`
              : ''}
          </h3>
          {txns.isPending ? (
            <Skeleton className="h-32" />
          ) : txns.data?.length ? (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {txns.data.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-14 shrink-0 text-xs text-muted">
                    {new Date(`${t.date}T00:00:00Z`).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t.displayName}</span>
                  <Amount minor={t.amountMinor} currency={t.currency} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Nothing yet.</p>
          )}
          <p className="text-xs text-muted">
            {scope === 'mine'
              ? 'Counted here because they’re for you alone.'
              : 'Counted here because they’re for more than one of you.'}{' '}
            <Link
              to={`/h/${householdId}/transactions`}
              search={{
                category: categoryId,
                range: 'custom',
                from,
                to: lastDay,
              }}
              className="text-accent-text underline"
            >
              Open in Transactions
            </Link>
          </p>
        </section>
      </div>
    </Dialog>
  );
}

// ── "Counts in", on a transaction (D22) ──────────────────────────────────────────────────────

/**
 * Which budget, and which of its categories, a transaction counts in, and why: its attribution
 * decides (D1), so the drawer says it plainly rather than leave it invisible.
 */
export function CountsIn({ householdId, t }: { householdId: string; t: Transaction }) {
  const household = useQuery(householdQuery(householdId)).data;
  const budgets = useQuery(budgetsQuery(householdId)).data ?? [];
  const groups = useQuery(categoriesQuery(householdId)).data ?? [];
  const ids = t.attribution.map((a) => a.memberId);
  const me = household?.you.memberId;
  const scope = ids.length >= 2 ? 'household' : ids[0] === me ? 'mine' : null;
  const budget = budgets.find((b) => b.scope === scope);
  const month = t.date.slice(0, 7);
  const kind = groups.find((g) => g.categories.some((c) => c.id === t.categoryId))?.kind;
  const counted =
    !!budget && !t.hasSplits && !t.excluded && kind !== 'transfer' && month >= budget.startsMonth;
  const view = useQuery({
    ...budgetMonthQuery(householdId, budget?.id ?? '', month),
    enabled: counted && kind !== 'income',
  });
  if (!budget || t.hasSplits || kind === 'transfer') return null;

  const label = budgets.length > 1 ? (budget.scope === 'mine' ? 'Mine' : 'Ours') : 'Your budget';
  const name = t.categoryId ? categoryName(groups, t.categoryId) : 'Uncategorized';
  const why =
    budgets.length > 1
      ? budget.scope === 'mine'
        ? 'It’s for you alone, so it counts in your own budget, wherever it was paid from.'
        : 'It’s for more than one of you, so it counts in the shared budget, not your own.'
      : null;
  const v = view.data?.view;
  const row =
    v?.strategy === 'category'
      ? v.rows.find((r) => r.categoryId === t.categoryId)
      : v?.strategy === 'flex'
        ? (() => {
            const fixed = v.fixed.find((r) => r.categoryId === t.categoryId);
            if (fixed) return { ...fixed, rolledInMinor: 0 };
            if (v.flexible.categories.some((c) => c.categoryId === t.categoryId)) {
              return {
                budgetedMinor: v.flexible.budgetedMinor,
                spentMinor: v.flexible.spentMinor,
                rolledInMinor: 0,
              };
            }
            return undefined;
          })()
        : undefined;
  return (
    <section className="space-y-1 rounded-xl border border-border p-3">
      <h3 className="text-xs text-muted">Counts in</h3>
      {t.excluded ? (
        <p className="text-sm">Nowhere: it’s excluded from budgets and reports.</p>
      ) : month < budget.startsMonth ? (
        <p className="text-sm">
          Nothing yet: the budget starts in {monthName(budget.startsMonth)}.
        </p>
      ) : kind === 'income' ? (
        <p className="text-sm">
          <span className="font-medium">{label}</span> · money in for {monthName(month)}
        </p>
      ) : (
        <p className="text-sm">
          <span className="font-medium">{label}</span> · {name}
          {v?.strategy === 'flex' &&
          v.flexible.categories.some((c) => c.categoryId === t.categoryId)
            ? ' (flexible spending)'
            : ''}
          {row && view.data ? (
            <>
              {' · '}
              <Amount minor={row.spentMinor} currency={view.data.currency} kind="balance" /> of{' '}
              <Amount
                minor={row.budgetedMinor + row.rolledInMinor}
                currency={view.data.currency}
                kind="balance"
              />{' '}
              in {monthName(month)}
            </>
          ) : view.data ? (
            ' · no limit set'
          ) : null}
        </p>
      )}
      {why ? <p className="text-xs text-muted">{why}</p> : null}
      <Link
        to={`/h/${householdId}/budget`}
        search={{ month, scope: budget.scope }}
        className="text-xs text-accent-text underline"
      >
        See the budget
      </Link>
    </section>
  );
}

// ── Flex (§3.4) ──────────────────────────────────────────────────────────────────────────────

const STRATEGY_NAMES = { category: 'Category limits', flex: 'Flex' } as const;

function FlexBody({
  data,
  groups,
  onOpen,
  onYearly,
  onFlexible,
}: {
  data: BudgetMonth & { view: FlexMonth };
  groups: CategoryGroup[];
  onOpen: (e: { categoryId: string; row?: CategoryLimitRow }) => void;
  onYearly: ((e: { categoryId: string; yearlyMinor: number | null }) => void) | undefined;
  onFlexible: (() => void) | undefined;
}) {
  const { view, currency, month } = data;
  const progress = monthProgress(month);
  const money = (minor: number, className?: string) => (
    <Amount minor={minor} currency={currency} kind="balance" className={className} />
  );
  const f = view.flexible;
  const used =
    f.budgetedMinor > 0 ? Math.min(1, f.spentMinor / f.budgetedMinor) : f.spentMinor > 0 ? 1 : 0;
  const asRow = (r: FlexMonth['fixed'][number]): CategoryLimitRow => ({
    ...r,
    rolledInMinor: 0,
    rollover: false,
  });
  return (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
        <MoneyIn data={data} />
        <Stat label="Fixed" note={`of ${formatMinor(view.totals.fixedBudgetedMinor, currency)}`}>
          {money(view.totals.fixedSpentMinor)}
        </Stat>
        <Stat label="Set aside" note="for non-monthly costs">
          {money(view.totals.setAsideMinor)}
        </Stat>
        <Stat
          label="Flexible left"
          noteTone={f.leftMinor < 0 ? 'danger' : undefined}
          note={f.leftMinor < 0 ? 'over' : undefined}
        >
          {money(Math.abs(f.leftMinor))}
        </Stat>
      </div>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto">
            <h2 className="font-semibold">Flexible spending</h2>
            <p className="text-sm text-muted">
              One number for everything that isn’t fixed or non-monthly.
            </p>
          </div>
          <p className="text-right">
            <span className="text-lg font-semibold">{money(f.spentMinor)}</span>{' '}
            <span className="text-sm text-muted">of {formatMinor(f.budgetedMinor, currency)}</span>
          </p>
          {onFlexible ? (
            <Button variant="secondary" size="sm" onPress={onFlexible}>
              Change
            </Button>
          ) : null}
        </div>
        <div
          className="relative h-2 rounded-full bg-surface-2"
          role="meter"
          aria-label={`Flexible spending: ${Math.round(used * 100)}% used`}
          aria-valuenow={Math.round(used * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={clsx('h-full rounded-full', f.leftMinor < 0 ? 'bg-danger' : 'bg-accent')}
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
        {f.categories.length ? (
          <ul className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2 md:grid-cols-3">
            {f.categories.map((c) => (
              <li key={c.categoryId}>
                <button
                  type="button"
                  className="flex w-full justify-between gap-2 rounded px-1 hover:bg-surface-2"
                  onClick={() => onOpen({ categoryId: c.categoryId })}
                >
                  <span className="truncate text-muted">{categoryName(groups, c.categoryId)}</span>
                  {money(c.spentMinor)}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="overflow-hidden rounded-xl border border-border bg-surface">
          <h3 className="border-b border-border px-4 py-2 font-semibold">Fixed</h3>
          {view.fixed.length ? (
            <ul className="divide-y divide-border">
              {view.fixed.map((r) => (
                <li key={r.categoryId}>
                  <button
                    type="button"
                    onClick={() => onOpen({ categoryId: r.categoryId, row: asRow(r) })}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {categoryName(groups, r.categoryId)}
                      {r.budgetedMinor > 0 && r.spentMinor >= r.budgetedMinor ? (
                        <Badge tone="positive" className="ml-2">
                          Paid
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-muted">{money(r.budgetedMinor)}</span>
                    <span className={clsx('w-24 text-right', r.leftMinor < 0 && 'text-danger')}>
                      {money(r.spentMinor)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-sm text-muted">No fixed costs this month.</p>
          )}
        </section>
        <section className="overflow-hidden rounded-xl border border-border bg-surface">
          <h3 className="border-b border-border px-4 py-2 font-semibold">Non-monthly</h3>
          {view.nonMonthly.length ? (
            <ul className="divide-y divide-border">
              {view.nonMonthly.map((r) => (
                <li key={r.categoryId}>
                  <button
                    type="button"
                    disabled={!onYearly}
                    onClick={() =>
                      onYearly?.({ categoryId: r.categoryId, yearlyMinor: r.yearlyMinor })
                    }
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm enabled:hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{categoryName(groups, r.categoryId)}</span>
                      <span className="text-xs text-muted">
                        {r.yearlyMinor === null
                          ? 'No yearly amount set'
                          : `${formatMinor(r.yearlyMinor, currency)} a year · ${formatMinor(r.setAsideMinor, currency)} a month`}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block text-xs text-muted">Saved</span>
                      {money(r.savedMinor)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-sm text-muted">
              Travel, gifts and other costs that come once or twice a year show here.
            </p>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * Money in (D2): for the shared budget, its income and what members moved into joint accounts;
 * for yours, your income, with what you moved into joint accounts going to Ours.
 */
function MoneyIn({ data }: { data: BudgetMonth }) {
  const { incomeMinor, contributionsMinor } = data.view;
  const shared = data.budget.scope === 'household';
  return (
    <Stat
      label="Money in"
      note={
        contributionsMinor === 0
          ? undefined
          : shared
            ? `${formatMinor(contributionsMinor, data.currency)} of it contributions`
            : `${formatMinor(contributionsMinor, data.currency)} went to Ours`
      }
    >
      <Amount
        minor={incomeMinor + (shared ? contributionsMinor : 0)}
        currency={data.currency}
        kind="balance"
      />
    </Stat>
  );
}

function formatMinor(minor: number, currency: string) {
  return formatMoney(minor, currency);
}

/** The flexible number from this month on (§3.4). */
function FlexibleDialog({
  householdId,
  month,
  amountMinor,
  onClose,
}: {
  householdId: string;
  month: BudgetMonth;
  amountMinor: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState<number | null>(amountMinor);
  const save = useMutation({
    mutationFn: () =>
      api('PUT', `${base(householdId)}/budgets/${month.budget.id}/months/${month.month}/flexible`, {
        body: { amountMinor: amount ?? 0 },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['households', householdId, 'budgets', month.budget.id],
      });
      toast('Flexible spending saved.');
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  return (
    <Dialog title="Flexible spending" isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <AmountInput
          label={`From ${monthName(month.month)}`}
          currency={month.currency}
          value={amount}
          onChange={setAmount}
          description="Later months keep it until you change it. Earlier months keep theirs."
        />
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

/** A non-monthly category's yearly figure, a twelfth of it set aside each month (D12). */
function YearlyDialog({
  householdId,
  month,
  categoryId,
  yearlyMinor,
  name,
  onClose,
}: {
  householdId: string;
  month: BudgetMonth;
  categoryId: string;
  yearlyMinor: number | null;
  name: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState<number | null>(yearlyMinor);
  const save = useMutation({
    mutationFn: () =>
      api('PUT', `${base(householdId)}/budgets/${month.budget.id}/categories/${categoryId}`, {
        body: { yearlyMinor: amount },
      }),
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
          label="A year"
          currency={month.currency}
          value={amount}
          onChange={setAmount}
          description={
            amount
              ? `${formatMinor(Math.round(amount / 12), month.currency)} set aside each month, and spent from when it comes.`
              : 'A twelfth of it is set aside each month, and spent from when it comes.'
          }
        />
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

// ── Change how you budget (§5, #104) ─────────────────────────────────────────────────────────

/** Switches strategy from this month or next, with a preview of the first month (D14). */
function StrategyDialog({
  householdId,
  month,
  onClose,
}: {
  householdId: string;
  month: BudgetMonth;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const current = month.view.strategy;
  const target = current === 'flex' ? 'category' : 'flex';
  const now = thisMonth();
  const next = addMonths(now, 1);
  const [from, setFrom] = useState(next);
  const preview = useQuery({
    queryKey: ['households', householdId, 'budgets', month.budget.id, 'preview', target, from],
    queryFn: async () =>
      (
        await api<{ data: StrategyPreview }>(
          'GET',
          `${base(householdId)}/budgets/${month.budget.id}/strategy-preview?strategy=${target}&fromMonth=${from}`,
        )
      ).data,
  });
  const save = useMutation({
    mutationFn: () =>
      api('PUT', `${base(householdId)}/budgets/${month.budget.id}/strategy`, {
        body: { strategy: target, fromMonth: from },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'budgets'] });
      toast(`Your budget uses ${STRATEGY_NAMES[target].toLowerCase()} from ${monthName(from)}.`);
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  const p = preview.data;
  return (
    <Dialog
      title={`Switch to ${STRATEGY_NAMES[target].toLowerCase()}`}
      size="lg"
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <p className="text-sm text-muted">
          Nothing is deleted. Every amount you’ve set is kept, and switching back brings it all
          back.
        </p>
        <p className="text-sm">
          {target === 'flex'
            ? 'Flex budgets fixed costs one by one, saves up for non-monthly ones, and gives everything else one number.'
            : 'Category limits give each category a limit of its own.'}
        </p>
        <RadioGroup label="Starting" value={from} onChange={setFrom}>
          <RadioCard
            value={next}
            title={monthName(next)}
            description={`${monthName(now)} stays as it is.`}
          />
          <RadioCard value={now} title={monthName(now)} description="This month, as it stands." />
        </RadioGroup>
        {preview.isPending ? (
          <Skeleton className="h-24" />
        ) : p ? (
          <div className="space-y-1 rounded-xl border border-border p-3 text-sm">
            <p className="font-medium">In {monthName(p.fromMonth)}</p>
            {p.after.strategy === 'flex' ? (
              <>
                <p>
                  Flexible spending:{' '}
                  <Amount
                    minor={p.after.flexible.budgetedMinor}
                    currency={month.currency}
                    kind="balance"
                  />
                  , your flexible categories’ limits added up.
                </p>
                <p>
                  Fixed costs:{' '}
                  <Amount
                    minor={p.after.totals.fixedBudgetedMinor}
                    currency={month.currency}
                    kind="balance"
                  />
                  , their limits as they are.
                </p>
                <p className="text-muted">
                  Non-monthly categories save up once you give them a yearly amount.
                </p>
              </>
            ) : (
              <p>
                Each category’s limit as you last set it:{' '}
                <Amount
                  minor={p.after.totals.budgetedMinor}
                  currency={month.currency}
                  kind="balance"
                />{' '}
                in all. The flexible number stays saved, for switching back.
              </p>
            )}
          </div>
        ) : null}
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button isPending={save.isPending} onPress={() => save.mutate()}>
            Switch from {monthName(from)}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

// ── The year at a glance (§6, #106) ──────────────────────────────────────────────────────────

/** The fiscal year a month falls in, named by the calendar year it starts in. */
export function fiscalYearOf(month: string, startMonth: number): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m >= startMonth ? y : y - 1;
}

/** Switches between the month and the year, keeping the rest of the page's place. */
function ViewLink({
  view,
  year,
  children,
}: {
  view: 'month' | 'year';
  year?: number;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={() =>
        void navigate({
          to: '.',
          search: (prev: Record<string, unknown>) => {
            const { view: _view, year: _year, ...rest } = prev;
            return view === 'year'
              ? { ...rest, view: 'year', ...(year ? { year: String(year) } : {}) }
              : rest;
          },
          replace: true,
        })
      }
    >
      {children}
    </Button>
  );
}

function YearView({
  household,
  budget,
  year,
}: {
  household: Household;
  budget: BudgetSummary;
  year: number;
}) {
  const navigate = useNavigate();
  const groups = useQuery(categoriesQuery(household.id)).data ?? [];
  const data = useQuery({
    queryKey: ['households', household.id, 'budgets', budget.id, 'year', year],
    queryFn: async () =>
      (
        await api<{ data: BudgetYear }>(
          'GET',
          `${base(household.id)}/budgets/${budget.id}/years/${year}`,
        )
      ).data,
  });
  const go = (y: number) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, view: 'year', year: String(y) }),
      replace: true,
    });
  const current = thisMonth();
  const currency = household.baseCurrency;
  const short = (m: string) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      timeZone: 'UTC',
    });
  const exponent = minorUnitExponent(currency);
  const wholeFormat = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
  const whole = (minor: number) => wholeFormat.format(Math.round(minor / 10 ** exponent));
  const y = data.data;
  const order = groups.flatMap((g) => g.categories.map((c) => c.id));
  const rows = y
    ? [...y.rows].sort((a, b) => order.indexOf(a.categoryId) - order.indexOf(b.categoryId))
    : [];
  // On a narrow screen the table scrolls: open it at this month, not at the year's first.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scroller.current;
    const cell = box?.querySelector<HTMLElement>('[data-current]');
    if (box && cell && box.scrollWidth > box.clientWidth) {
      box.scrollLeft = Math.max(0, cell.offsetLeft - box.clientWidth / 2);
    }
  }, [y]);
  const yearLabel =
    household.fiscalYearStartMonth === 1 ? String(year) : `${year}–${String(year + 1).slice(2)}`;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Year">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous year"
            onPress={() => go(year - 1)}
          >
            <ChevronLeft aria-hidden className="size-4" />
          </Button>
          <span className="min-w-20 text-center text-sm font-medium" aria-live="polite">
            {yearLabel}
          </span>
          <Button variant="ghost" size="icon" aria-label="Next year" onPress={() => go(year + 1)}>
            <ChevronRight aria-hidden className="size-4" />
          </Button>
        </div>
        <ViewLink view="month">Month view</ViewLink>
      </div>
      <p className="text-sm text-muted">
        Spent each month, to the dollar. Months ahead show what’s budgeted. Red is over that month’s
        limit.
      </p>
      {data.isPending ? (
        <Skeleton className="h-64" />
      ) : data.isError || !y ? (
        <Alert>Couldn’t load {yearLabel}. Try again in a moment.</Alert>
      ) : rows.length === 0 ? (
        <EmptyState icon={PiggyBank} title={`Nothing in ${yearLabel}`}>
          <p>No spending or limits in this budget’s categories that year.</p>
        </EmptyState>
      ) : (
        <div ref={scroller} className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[56rem] text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted">
                <th
                  scope="col"
                  className="sticky left-0 bg-surface px-3 py-2 text-left font-medium"
                >
                  Category
                </th>
                {y.months.map((m) => (
                  <th
                    key={m}
                    scope="col"
                    data-current={m === current ? '' : undefined}
                    className={clsx('px-2 py-2 text-right font-medium', m === current && 'text-fg')}
                  >
                    {short(m)}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Spent
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Budgeted
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.categoryId}>
                  <th
                    scope="row"
                    className="sticky left-0 max-w-44 truncate bg-surface px-3 py-2 text-left font-normal"
                  >
                    {categoryName(groups, r.categoryId)}
                  </th>
                  {r.months.map((cell, i) => {
                    const m = y.months[i]!;
                    const ahead = m > current;
                    const over =
                      cell.budgetedMinor !== null && cell.spentMinor > cell.budgetedMinor;
                    return (
                      <td
                        key={m}
                        className={clsx(
                          'px-2 py-2 text-right tabular-nums',
                          ahead ? 'text-muted' : over && 'text-danger',
                        )}
                      >
                        {ahead
                          ? cell.budgetedMinor !== null
                            ? whole(cell.budgetedMinor)
                            : '—'
                          : cell.spentMinor
                            ? whole(cell.spentMinor)
                            : '—'}
                        {!ahead && over ? <span className="sr-only"> (over)</span> : null}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {whole(r.spentMinor)}
                  </td>
                  <td className="px-3 py-2 text-right text-muted tabular-nums">
                    {r.budgetedMinor ? whole(r.budgetedMinor) : '—'}
                  </td>
                </tr>
              ))}
              {y.flexible.some((f) => f !== null) ? (
                <tr>
                  <th
                    scope="row"
                    className="sticky left-0 bg-surface px-3 py-2 text-left font-normal"
                  >
                    Flexible spending
                  </th>
                  {y.flexible.map((f, i) => (
                    <td key={y.months[i]} className="px-2 py-2 text-right text-muted tabular-nums">
                      {f === null ? '' : whole(f)}
                    </td>
                  ))}
                  <td />
                  <td className="px-3 py-2 text-right text-muted tabular-nums">
                    {whole(y.flexible.reduce<number>((s, f) => s + (f ?? 0), 0))}
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold">
                <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left">
                  Total spent
                </th>
                {y.spentMinor.map((v, i) => (
                  <td key={y.months[i]} className="px-2 py-2 text-right tabular-nums">
                    {y.months[i]! > current ? '' : v ? whole(v) : '—'}
                  </td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">
                  {whole(y.spentMinor.reduce((s, v) => s + v, 0))}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">
        Years follow the household’s fiscal year, set in Household settings.
      </p>
    </>
  );
}
