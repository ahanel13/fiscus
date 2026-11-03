// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DetectedSeries,
  describeSchedule,
  type HouseholdMember,
  type RecurringKind,
  type RecurringMonth,
  type RecurringOccurrence,
  type RecurringSeries,
  showWho,
  type Transaction,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { Calendar, ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { accountsQuery, householdQuery, membersQuery, recurringQuery } from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecurringDialog } from '../components/RecurringDialog.js';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogActions,
  LoadingRegion,
  Menu,
  MenuItem,
  MenuTrigger,
  Radio,
  RadioGroup,
  SegmentedControl,
  Select,
  SelectItem,
  Skeleton,
  toast,
  useToday,
} from '../components/ui.js';
import { SMALL, useMediaQuery } from '../lib/media.js';
import { namesOf, whoLabel } from '../lib/recurring.js';

// Bills & recurring (#118, #120; bills walkthrough §4, §5): what's coming up this month, late
// first, as a list or a calendar, and every series under All. Paid and late are worked out from
// the transactions; someone can say a date was paid another way, or skipped (D12).

type Tab = 'upcoming' | 'calendar' | 'all' | 'review';
const TABS: readonly { value: Exclude<Tab, 'review'>; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'all', label: 'All' },
];

const SECTIONS: { kind: RecurringKind; title: string }[] = [
  { kind: 'income', title: 'Income' },
  { kind: 'bill', title: 'Bills' },
  { kind: 'subscription', title: 'Subscriptions' },
  { kind: 'transfer', title: 'Transfers' },
];

const base = (id: string) => `/api/v1/households/${id}`;
const monthOf = (d: string) => d.slice(0, 7);
const shiftMonth = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const fmt = (d: string, o: Intl.DateTimeFormatOptions) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { ...o, timeZone: 'UTC' });
const monthName = (month: string) => fmt(`${month}-01`, { month: 'long', year: 'numeric' });

const monthQuery = (id: string, month: string) => ({
  queryKey: ['households', id, 'recurring', 'month', month],
  queryFn: async () =>
    (await api<{ data: RecurringMonth }>('GET', `${base(id)}/recurring/month?month=${month}`)).data,
});

export function RecurringPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const search = useSearch({ strict: false }) as { tab?: string; month?: string };
  const navigate = useNavigate();
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const today = useToday();
  const tab: Tab =
    search.tab === 'calendar' || search.tab === 'all' || search.tab === 'review'
      ? search.tab
      : 'upcoming';
  const series = useQuery(recurringQuery(householdId));
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const [editing, setEditing] = useState<RecurringSeries | null>(null);
  const [adding, setAdding] = useState(false);
  // Adding by hand: on an account whose transactions you can change, still open.
  const editable = accounts.filter(
    (a) => !a.closedAt && (a.yourAccess === 'owner' || a.yourAccess === 'full'),
  );
  const canAdd = household.you.role !== 'viewer' && editable.length > 0;
  // What Fiscus found (§2): for those who can make a series, not viewers.
  const found = useQuery({
    queryKey: ['households', householdId, 'recurring', 'suggestions'],
    queryFn: async () =>
      (await api<{ data: DetectedSeries[] }>('GET', `${base(householdId)}/recurring/suggestions`))
        .data,
    enabled: household.you.role !== 'viewer',
    staleTime: 60_000,
  });
  const suggestions = found.data ?? [];
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'An account';
  const open = (seriesId: string | null) => {
    const s = series.data?.find((x) => x.id === seriesId);
    if (s) setEditing(s);
  };
  const go = (next: Tab) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        tab: next === 'upcoming' ? undefined : next,
      }),
      replace: true,
    });

  return (
    <>
      <PageHeader title="Bills & recurring" showLens={false} members={members} />
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-4 sm:py-6 md:px-8">
        {tab === 'review' ? (
          <Button variant="ghost" size="sm" onPress={() => go('upcoming')}>
            <ChevronLeft aria-hidden className="size-4" /> Back
          </Button>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <SegmentedControl aria-label="Show" options={TABS} value={tab} onChange={go} />
            {canAdd ? (
              <Button variant="secondary" size="sm" onPress={() => setAdding(true)}>
                <Plus aria-hidden className="size-4" /> Add
                <span className="hidden sm:inline"> recurring</span>
              </Button>
            ) : null}
          </div>
        )}
        {tab !== 'review' && suggestions.length ? (
          <div className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent-text">
            <span className="min-w-0 flex-1">
              <b>
                Fiscus found {suggestions.length}{' '}
                {suggestions.length === 1 ? 'payment' : 'payments'} that repeat.
              </b>{' '}
              <span className="hidden sm:inline">
                {suggestions
                  .slice(0, 3)
                  .map((x) => x.name)
                  .join(', ')}
                {suggestions.length > 3 ? ', and more' : ''}.
              </span>
            </span>
            <Button size="sm" onPress={() => go('review')}>
              Review
            </Button>
          </div>
        ) : null}
        {tab === 'review' ? (
          <Review
            householdId={householdId}
            suggestions={suggestions}
            loading={found.isPending}
            currency={household.baseCurrency}
            accountName={accountName}
            onDone={() => go('upcoming')}
          />
        ) : series.isPending ? (
          <LoadingRegion label="Loading recurring payments">
            <div className="space-y-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-64" />
            </div>
          </LoadingRegion>
        ) : series.isError ? (
          <Alert>Couldn’t load your recurring payments. Try again in a moment.</Alert>
        ) : tab === 'all' ? (
          <AllSeries
            series={series.data}
            members={members}
            accountName={accountName}
            onOpen={setEditing}
          />
        ) : tab === 'calendar' ? (
          <CalendarView
            householdId={householdId}
            month={/^\d{4}-\d{2}$/.test(search.month ?? '') ? search.month! : monthOf(today)}
            today={today}
            accountName={accountName}
            onOpen={open}
          />
        ) : (
          <Upcoming
            householdId={householdId}
            currency={household.baseCurrency}
            today={today}
            empty={series.data.length === 0}
            accountName={accountName}
            onOpen={open}
          />
        )}
      </div>
      {adding ? (
        <RecurringDialog
          householdId={householdId}
          initial={{
            name: '',
            kind: 'bill',
            draft: {
              accountId: editable[0]!.id,
              match: { direction: 'out' },
              schedule: {
                unit: 'month',
                every: 1,
                days: [Number(today.slice(8, 10))],
                anchor: today,
                weekend: 'after',
              },
              windowDays: 3,
            },
          }}
          accounts={editable}
          accountName={editable[0]!.name}
          currency={editable[0]!.currency}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {editing ? (
        <RecurringDialog
          householdId={householdId}
          initial={{
            name: editing.name,
            kind: editing.kind,
            draft: {
              accountId: editing.accountId,
              match: editing.match,
              schedule: editing.schedule,
              windowDays: editing.windowDays,
            },
          }}
          series={editing}
          accountName={accountName(editing.accountId)}
          currency={editing.currency}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function NothingYet() {
  return (
    <EmptyState icon={Calendar} title="Nothing recurring yet">
      <p>
        Choose <b>Add</b> above, or open a paycheck, a bill or a subscription in Transactions and
        choose <b>Make recurring</b>: Fiscus finds the payments before it, and when the next one is
        due.
      </p>
    </EmptyState>
  );
}

/**
 * This month's, late first (§4): this week, then the rest of the month and the start of the
 * next, then what's paid, folded. The month's totals above it.
 */
function Upcoming({
  householdId,
  currency,
  today,
  empty,
  accountName,
  onOpen,
}: {
  householdId: string;
  currency: string;
  today: string;
  empty: boolean;
  accountName: (id: string) => string;
  onOpen: (seriesId: string | null) => void;
}) {
  const month = monthOf(today);
  const now = useQuery(monthQuery(householdId, month));
  const next = useQuery(monthQuery(householdId, shiftMonth(month, 1)));
  const [showPaid, setShowPaid] = useState(false);
  if (now.isPending) return <Skeleton className="h-64" />;
  if (now.isError) return <Alert>Couldn’t work out this month. Try again in a moment.</Alert>;
  const all = [...now.data.occurrences, ...(next.data?.occurrences ?? [])];
  if (empty && all.length === 0) return <NothingYet />;
  const weekEnd = addDays(today, 6);
  // The start of next month shows once this month's end is near.
  const horizon = addDays(today, 14);
  const open = all.filter((o) => o.status === 'due' || o.status === 'late');
  const late = open.filter((o) => o.status === 'late');
  const week = open.filter((o) => o.status === 'due' && o.due <= weekEnd);
  const later = open.filter(
    (o) => o.status === 'due' && o.due > weekEnd && (monthOf(o.due) === month || o.due <= horizon),
  );
  const done = now.data.occurrences.filter(
    (o) => (o.status === 'paid' || o.status === 'skipped') && monthOf(o.due) === month,
  );
  const t = now.data.totals;
  const money = (minor: number, className?: string) => (
    <Amount minor={minor} currency={currency} kind="balance" whole className={className} />
  );
  const row = (o: RecurringOccurrence) => (
    <OccurrenceRow
      key={`${o.seriesId ?? o.accountId}:${o.due}`}
      householdId={householdId}
      o={o}
      today={today}
      accountName={accountName}
      onOpen={onOpen}
    />
  );
  return (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
        <Tile label={`Bills in ${fmt(`${month}-01`, { month: 'long' })}`}>
          <span className="text-lg font-semibold">{money(t.billsMinor)}</span>
          <span className="block text-xs text-muted">
            {money(t.billsPaidMinor)} paid ·{' '}
            <b className="text-fg">{money(Math.max(0, t.billsMinor - t.billsPaidMinor))} to pay</b>
          </span>
        </Tile>
        <Tile label="Income expected">
          <span className="text-lg font-semibold text-positive">{money(t.incomeMinor)}</span>
          <span className="block text-xs text-muted">{money(t.incomeReceivedMinor)} in so far</span>
        </Tile>
        <Tile label="Card statements">
          {t.statementsMinor ? (
            <span className="text-lg font-semibold">{money(t.statementsMinor)}</span>
          ) : (
            <span className="block text-lg font-semibold text-muted">None</span>
          )}
          <span className="block text-xs text-muted">Due this month, from the bank</span>
        </Tile>
        <Tile label="Subscriptions">
          <span className="text-lg font-semibold">{money(t.subscriptionsMinor)}</span>
          <span className="block text-xs text-muted">a month · {t.subscriptionCount} of them</span>
        </Tile>
      </div>
      <div className="space-y-4">
        {[
          { title: 'Late', rows: late },
          { title: 'This week', rows: week },
          { title: `Later`, rows: later },
        ].map(({ title, rows }) =>
          rows.length ? (
            <section key={title} className="space-y-2">
              <h2 className={clsx('px-1 text-sm font-semibold', title === 'Late' && 'text-danger')}>
                {title}
              </h2>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                {rows.map(row)}
              </ul>
            </section>
          ) : null,
        )}
        {late.length + week.length + later.length === 0 ? (
          <p className="px-1 text-sm text-muted">Nothing else is due this month.</p>
        ) : null}
        {done.length ? (
          <section className="space-y-2">
            <button
              type="button"
              aria-expanded={showPaid}
              onClick={() => setShowPaid(!showPaid)}
              className="flex items-center gap-2 px-1 text-sm font-semibold text-muted hover:text-fg"
            >
              <ChevronRight
                aria-hidden
                className={clsx('size-4 transition-transform', showPaid && 'rotate-90')}
              />
              Paid in {fmt(`${month}-01`, { month: 'long' })} · {done.length}
            </button>
            {showPaid ? (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                {done.map(row)}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
    </>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      {children}
    </div>
  );
}

/**
 * Who looks after it (a bill), who it's for (income), or whose card it is: their avatars, only
 * where more than one member sees it (D22). Nothing for someone on their own.
 */
export function Who({
  memberIds,
  shared,
  members,
  kind,
}: {
  memberIds: readonly string[];
  shared: boolean;
  members: readonly HouseholdMember[];
  kind: RecurringKind | 'statement';
}) {
  const who = memberIds.flatMap((id) => members.filter((m) => m.id === id));
  if (!shared || who.length === 0) return null;
  const label = whoLabel(kind, namesOf(memberIds, members));
  return (
    <span role="img" aria-label={label} title={label} className="flex shrink-0 -space-x-1.5">
      {who.map((m) => (
        <Avatar
          key={m.id}
          name={m.displayName}
          color={m.color}
          size="sm"
          className="ring-2 ring-surface"
        />
      ))}
    </span>
  );
}

/** One date something's due: when, what, how much, and what's to be done if it's late. */
export function OccurrenceRow({
  householdId,
  o,
  today,
  accountName,
  onOpen,
}: {
  householdId: string;
  o: RecurringOccurrence;
  today: string;
  accountName: (id: string) => string;
  onOpen: (seriesId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const [picking, setPicking] = useState(false);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['households', householdId, 'recurring'] });
  const fail = (e: unknown) =>
    toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' });
  const mark = useMutation({
    mutationFn: (body: { status: 'paid'; transactionId: string | null } | { status: 'skipped' }) =>
      api('PUT', `${base(householdId)}/recurring/${o.seriesId}/occurrences/${o.due}`, { body }),
    onSuccess: (_r, body) => {
      refresh();
      toast(body.status === 'skipped' ? `${o.name}: skipped this one.` : `${o.name}: marked paid.`);
    },
    onError: fail,
  });
  const unmark = useMutation({
    mutationFn: () =>
      api('DELETE', `${base(householdId)}/recurring/${o.seriesId}/occurrences/${o.due}`),
    onSuccess: refresh,
    onError: fail,
  });
  const end = useMutation({
    mutationFn: () =>
      api('PATCH', `${base(householdId)}/recurring/${o.seriesId}`, {
        body: { endedOn: addDays(o.due, -1) },
      }),
    onSuccess: () => {
      refresh();
      toast(`${o.name} has ended.`);
    },
    onError: fail,
  });
  const income = o.kind === 'income';
  const amount =
    o.status === 'paid' && o.payment?.amountMinor != null ? o.payment.amountMinor : o.expectedMinor;
  const lateBy =
    o.status === 'late' ? Math.round((Date.parse(today) - Date.parse(o.due)) / 86_400_000) : 0;
  const note =
    o.kind === 'statement'
      ? `${accountName(o.accountId)}${o.minimumMinor ? ' · minimum ' : ''}`
      : accountName(o.accountId);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="w-14 shrink-0 text-xs leading-tight whitespace-nowrap text-muted">
        {fmt(o.due, { weekday: 'short' })}
        <b className="block text-sm text-fg">{fmt(o.due, { month: 'short', day: 'numeric' })}</b>
      </span>
      <button
        type="button"
        className="min-w-0 flex-1 text-left disabled:cursor-default"
        disabled={!o.seriesId}
        onClick={() => onOpen(o.seriesId)}
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          <span className="line-clamp-2 break-words">{o.name}</span>
          {o.status === 'late' ? (
            <Badge tone="danger">
              {lateBy} {lateBy === 1 ? 'day' : 'days'} late
            </Badge>
          ) : o.status === 'paid' ? (
            <Badge tone="positive">
              {income ? 'Received' : 'Paid'}
              {o.payment?.date ? ` ${fmt(o.payment.date, { month: 'short', day: 'numeric' })}` : ''}
            </Badge>
          ) : o.status === 'skipped' ? (
            <Badge>Skipped</Badge>
          ) : null}
          {o.kind === 'statement' ? <Badge>From the bank</Badge> : null}
          {o.kind === 'subscription' ? <Badge>Subscription</Badge> : null}
        </span>
        <span className="block truncate text-xs text-muted">
          {note}
          {o.kind === 'statement' && o.minimumMinor ? (
            <Amount minor={o.minimumMinor} currency={o.currency} kind="balance" />
          ) : null}
          {o.kind === 'statement' && o.paidSoFarMinor ? (
            <>
              {' · '}
              <Amount minor={o.paidSoFarMinor} currency={o.currency} kind="balance" /> paid so far
            </>
          ) : null}
          {o.status === 'paid' && o.payment && o.payment.transactionId === null
            ? ' · paid another way'
            : ''}
        </span>
      </button>
      <Who memberIds={o.memberIds} shared={o.shared} members={members} kind={o.kind} />
      <span
        className={clsx(
          'shrink-0 text-right text-sm font-medium',
          o.status === 'paid' || o.status === 'skipped' ? 'text-muted' : income && 'text-positive',
        )}
      >
        {amount === null ? (
          '—'
        ) : (
          <>
            {o.status !== 'paid' && o.kind !== 'statement' ? (
              <span className="hidden text-xs font-normal text-muted sm:inline">about </span>
            ) : null}
            <Amount
              minor={Math.abs(amount)}
              currency={o.currency}
              kind="balance"
              whole={o.status !== 'paid' && Math.abs(amount) >= 1_000}
            />
          </>
        )}
      </span>
      {o.seriesId ? (
        <MenuTrigger>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${o.name}, ${fmt(o.due, { month: 'short', day: 'numeric' })}: more`}
          >
            <MoreHorizontal aria-hidden className="size-4" />
          </Button>
          <Menu placement="bottom end">
            {o.status === 'late' || o.status === 'due' ? (
              <>
                <MenuItem onAction={() => setPicking(true)}>
                  {income ? 'Mark received…' : 'Mark paid…'}
                </MenuItem>
                <MenuItem onAction={() => mark.mutate({ status: 'skipped' })}>
                  Skip this one
                </MenuItem>
                <MenuItem onAction={() => end.mutate()}>It’s ended</MenuItem>
              </>
            ) : (
              <MenuItem onAction={() => unmark.mutate()}>
                {o.status === 'skipped' ? 'It was due after all' : 'Not paid'}
              </MenuItem>
            )}
            <MenuItem onAction={() => onOpen(o.seriesId)}>Edit…</MenuItem>
          </Menu>
        </MenuTrigger>
      ) : null}
      {picking ? (
        <MarkPaid
          householdId={householdId}
          o={o}
          onPick={(transactionId) => {
            mark.mutate({ status: 'paid', transactionId });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </li>
  );
}

/**
 * Which payment paid it (D12): one from its account around its date, picked from a list, or
 * "paid another way" (from another account, cash, or a check Fiscus doesn't see).
 */
function MarkPaid({
  householdId,
  o,
  onPick,
  onClose,
}: {
  householdId: string;
  o: RecurringOccurrence;
  onPick: (transactionId: string | null) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const near = useQuery({
    queryKey: ['households', householdId, 'transactions', 'near', o.accountId, o.due],
    queryFn: async () => {
      const params = new URLSearchParams({
        lens: 'all',
        accounts: o.accountId,
        from: addDays(o.due, -15),
        to: addDays(o.due, 31),
        limit: '100',
      });
      return (
        await api<{ data: Transaction[] }>('GET', `${base(householdId)}/transactions?${params}`)
      ).data.filter(
        (t) => !t.hasSplits && (o.kind === 'income' ? t.amountMinor > 0 : t.amountMinor < 0),
      );
    },
  });
  return (
    <Dialog
      title={`${o.name}, ${fmt(o.due, { month: 'short', day: 'numeric' })}`}
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Which payment was it? These are from its account, around that date.
        </p>
        {near.isPending ? (
          <Skeleton className="h-32" />
        ) : near.data?.length ? (
          <RadioGroup aria-label="The payment" value={chosen} onChange={setChosen}>
            {near.data.map((t) => (
              <Radio key={t.id} value={t.id}>
                <span className="flex w-full items-center gap-3">
                  <span className="w-14 shrink-0 text-xs text-muted">
                    {fmt(t.date, { month: 'short', day: 'numeric' })}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t.displayName}</span>
                  <Amount minor={t.amountMinor} currency={t.currency} />
                </span>
              </Radio>
            ))}
          </RadioGroup>
        ) : (
          <p className="text-sm">Nothing in its account around then.</p>
        )}
        <DialogActions>
          <Button variant="ghost" className="mr-auto" onPress={() => onPick(null)}>
            Paid another way
          </Button>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button isDisabled={!chosen} onPress={() => onPick(chosen)}>
            That’s the one
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

/**
 * A month by day (§4): on a wide screen, each day lists what's due; on a phone, a dot per day,
 * and the day you tap is listed under the month.
 */
function CalendarView({
  householdId,
  month,
  today,
  accountName,
  onOpen,
}: {
  householdId: string;
  month: string;
  today: string;
  accountName: (id: string) => string;
  onOpen: (seriesId: string | null) => void;
}) {
  const navigate = useNavigate();
  const wide = useMediaQuery(SMALL);
  const data = useQuery(monthQuery(householdId, month));
  const [picked, setPicked] = useState<string | null>(null);
  const go = (m: string) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, month: m }),
      replace: true,
    });
  const first = `${month}-01`;
  const lead = new Date(`${first}T00:00:00Z`).getUTCDay();
  const days = Number(addDays(`${shiftMonth(month, 1)}-01`, -1).slice(8));
  const byDay = new Map<string, RecurringOccurrence[]>();
  for (const o of data.data?.occurrences ?? []) {
    if (monthOf(o.due) !== month) continue;
    byDay.set(o.due, [...(byDay.get(o.due) ?? []), o]);
  }
  const day = picked && monthOf(picked) === month ? picked : null;
  const dot = (o: RecurringOccurrence) =>
    o.status === 'late'
      ? 'bg-danger'
      : o.status === 'paid' || o.status === 'skipped'
        ? 'bg-border-strong'
        : o.kind === 'income'
          ? 'bg-positive'
          : 'bg-fg';
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous month"
          onPress={() => go(shiftMonth(month, -1))}
        >
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <span className="text-sm font-semibold" aria-live="polite">
          {monthName(month)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next month"
          onPress={() => go(shiftMonth(month, 1))}
        >
          <ChevronRight aria-hidden className="size-4" />
        </Button>
      </div>
      {data.isError ? (
        <Alert>Couldn’t work out {monthName(month)}. Try again in a moment.</Alert>
      ) : null}
      <div
        className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-border bg-border text-xs"
        role="grid"
        aria-label={monthName(month)}
      >
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div
            key={d}
            className="bg-bg px-2 py-1.5 text-center font-semibold text-muted"
            role="columnheader"
          >
            {wide ? d : d[0]}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead${i}`} className="bg-bg" />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const d = `${month}-${String(i + 1).padStart(2, '0')}`;
          const here = byDay.get(d) ?? [];
          return (
            <button
              key={d}
              type="button"
              role="gridcell"
              aria-label={`${fmt(d, { weekday: 'long', month: 'long', day: 'numeric' })}: ${here.length ? here.map((o) => o.name).join(', ') : 'nothing due'}`}
              onClick={() => setPicked(d)}
              className={clsx(
                'flex min-h-12 flex-col items-stretch bg-surface p-1.5 text-left hover:bg-surface-2 sm:min-h-24',
                d === today && 'font-bold text-accent-text',
                d === day && 'ring-2 ring-accent ring-inset',
              )}
            >
              <span className={clsx('text-center sm:text-left')}>{i + 1}</span>
              {wide ? (
                here.slice(0, 3).map((o) => (
                  <span
                    key={`${o.seriesId}${o.accountId}`}
                    className={clsx(
                      'mt-1 truncate rounded px-1.5 py-0.5 font-normal',
                      o.status === 'late'
                        ? 'bg-danger-soft text-danger'
                        : o.status === 'paid' || o.status === 'skipped'
                          ? 'text-muted line-through'
                          : o.kind === 'income'
                            ? 'bg-accent-soft text-accent-text'
                            : 'bg-surface-2 text-fg',
                    )}
                  >
                    {o.name}
                  </span>
                ))
              ) : here.length ? (
                <span className="mt-1 flex justify-center gap-0.5" aria-hidden>
                  {here.slice(0, 3).map((o) => (
                    <span
                      key={`${o.seriesId}${o.accountId}`}
                      className={clsx('size-1.5 rounded-full', dot(o))}
                    />
                  ))}
                </span>
              ) : null}
              {wide && here.length > 3 ? (
                <span className="mt-1 px-1.5 text-muted">+{here.length - 3} more</span>
              ) : null}
            </button>
          );
        })}
        {Array.from({ length: (7 - ((lead + days) % 7)) % 7 }, (_, i) => (
          <div key={`trail${i}`} className="bg-bg" />
        ))}
      </div>
      {day ? (
        <section className="space-y-2">
          <h2 className="px-1 text-sm font-semibold">
            {fmt(day, { weekday: 'long', month: 'long', day: 'numeric' })}
          </h2>
          {byDay.get(day)?.length ? (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {byDay.get(day)!.map((o) => (
                <OccurrenceRow
                  key={`${o.seriesId ?? o.accountId}:${o.due}`}
                  householdId={householdId}
                  o={o}
                  today={today}
                  accountName={accountName}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          ) : (
            <p className="px-1 text-sm text-muted">Nothing due.</p>
          )}
        </section>
      ) : (
        <p className="px-1 text-xs text-muted">
          {wide
            ? 'Click a day for what’s due, and to mark it paid.'
            : 'Dots: a bill, money in (green), late (red), paid (grey). Tap a day for what’s due.'}
        </p>
      )}
    </div>
  );
}

/** Every series, by kind, with when it's next due and about how much; ended ones last. */
function AllSeries({
  series,
  members,
  accountName,
  onOpen,
}: {
  series: RecurringSeries[];
  members: readonly HouseholdMember[];
  accountName: (id: string) => string;
  onOpen: (s: RecurringSeries) => void;
}) {
  if (series.length === 0) return <NothingYet />;
  const active = series.filter((s) => !s.endedOn || (s.next && s.next <= s.endedOn));
  const ended = series.filter((s) => !active.includes(s));
  const row = (s: RecurringSeries) => (
    <li key={s.id}>
      <button
        type="button"
        onClick={() => onOpen(s)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{s.name}</span>
          <span className="block truncate text-xs text-muted">
            {describeSchedule(s.schedule)} · {accountName(s.accountId)}
          </span>
        </span>
        <Who
          memberIds={
            s.kind === 'income'
              ? s.forMemberIds
              : s.responsibleMemberId
                ? [s.responsibleMemberId]
                : []
          }
          shared={showWho(s.seenBy)}
          members={members}
          kind={s.kind}
        />
        <span className="shrink-0 text-right">
          <span className="block text-sm font-medium">
            {s.estimateMinor !== null ? (
              <>
                <span className="text-xs font-normal text-muted">about </span>
                <Amount
                  minor={s.estimateMinor}
                  currency={s.currency}
                  whole={Math.abs(s.estimateMinor) >= 1_000}
                />
              </>
            ) : (
              <span className="text-muted">—</span>
            )}
          </span>
          <span className="block text-xs text-muted">
            {s.next
              ? `Next ${fmt(s.next, { weekday: 'short', month: 'short', day: 'numeric' })}`
              : 'Ended'}
          </span>
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted" />
      </button>
    </li>
  );
  return (
    <>
      {SECTIONS.map(({ kind, title }) => {
        const here = active.filter((s) => s.kind === kind);
        return here.length ? (
          <section key={kind} className="space-y-2">
            <h2 className="px-1 text-sm font-semibold">{title}</h2>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {here.map(row)}
            </ul>
          </section>
        ) : null;
      })}
      {ended.length ? (
        <section className="space-y-2">
          <h2 className="px-1 text-sm font-semibold text-muted">Ended</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface opacity-80">
            {ended.map(row)}
          </ul>
        </section>
      ) : null}
      <p className="px-1 text-xs text-muted">
        To add another, choose <b>Add</b> above, or open one of its payments in Transactions and
        choose <b>Make recurring</b>.
      </p>
    </>
  );
}

/**
 * What Fiscus found in your history (§2, D5): each with its schedule, how often it's been seen and
 * its amounts, to confirm (as a bill, a subscription, income or a transfer) or put away.
 */
export function Review({
  householdId,
  suggestions,
  loading,
  currency,
  accountName,
  onDone,
}: {
  householdId: string;
  currency: string;
  suggestions: DetectedSeries[];
  loading: boolean;
  accountName: (id: string) => string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const [kinds, setKinds] = useState<Record<string, RecurringKind>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<DetectedSeries | null>(null);
  const id = (x: DetectedSeries) => `${x.draft.accountId}|${x.draft.match.direction}|${x.key}`;
  const kindOf = (x: DetectedSeries) => kinds[id(x)] ?? x.kind;
  /** Who looks after it, when there's a choice (D13, D22): asked here, before confirming. */
  const askWho = (x: DetectedSeries) => kindOf(x) !== 'income' && showWho(x.seenBy ?? []);
  const whoOf = (x: DetectedSeries) => chosen[id(x)] ?? x.responsibleMemberId ?? null;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['households', householdId, 'recurring'] });
  const fail = (e: unknown) =>
    toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' });
  const confirm = useMutation({
    mutationFn: async (list: DetectedSeries[]) => {
      for (const x of list) {
        const who = askWho(x) ? whoOf(x) : null;
        await api('POST', `${base(householdId)}/recurring`, {
          body: {
            ...x.draft,
            name: x.name,
            kind: kindOf(x),
            ...(who ? { responsibleMemberId: who } : {}),
          },
        });
      }
      return list.length;
    },
    onSuccess: async (n) => {
      await refresh();
      toast(n === 1 ? 'It’s recurring now.' : `${n} are recurring now.`);
      if (n === suggestions.length) onDone();
    },
    onError: async (e) => {
      await refresh();
      fail(e);
    },
  });
  const dismiss = useMutation({
    mutationFn: (x: DetectedSeries) =>
      api('POST', `${base(householdId)}/recurring/suggestions/dismiss`, {
        body: { accountId: x.draft.accountId, direction: x.draft.match.direction, key: x.key },
      }),
    onSuccess: () => refresh(),
    onError: fail,
  });
  if (loading) return <Skeleton className="h-64" />;
  if (suggestions.length === 0) {
    return (
      <EmptyState icon={Calendar} title="Nothing more to review">
        <p>Everything that repeats in your history is a series, or you said it isn’t.</p>
      </EmptyState>
    );
  }
  const busy = confirm.isPending || dismiss.isPending;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold">Review what Fiscus found</h2>
          <p className="text-sm text-muted">
            Payments that came at a steady pace, at least three times, and are still coming. Confirm
            one to see it coming; what you don’t confirm stays a plain transaction.
          </p>
        </div>
        <Button isDisabled={busy} onPress={() => confirm.mutate(suggestions)}>
          Confirm all {suggestions.length}
        </Button>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {suggestions.map((x) => {
          const sizes = x.amounts.map(Math.abs);
          const top = Math.max(...sizes, 1);
          const lo = Math.min(...sizes);
          const hi = Math.max(...sizes);
          // Cents matter below $10: a few cents' reinvestment isn't "$0".
          const whole = lo >= 1_000;
          return (
            <li key={id(x)} className="space-y-3 px-4 py-3">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{x.name}</p>
                  <p className="text-xs text-muted">
                    {describeSchedule(x.draft.schedule)}
                    {x.next ? ` · next ${fmt(x.next, { month: 'short', day: 'numeric' })}` : ''}
                  </p>
                  <p className="text-xs text-muted">
                    Seen {x.seenCount} times since{' '}
                    {fmt(x.since, { month: 'short', year: 'numeric' })} ·{' '}
                    {accountName(x.draft.accountId)}
                  </p>
                </div>
                <span className="hidden h-6 shrink-0 items-end gap-0.5 sm:flex" aria-hidden>
                  {sizes.map((a, i) => (
                    <span
                      key={i}
                      className={clsx(
                        'w-1.5 rounded-sm',
                        i === sizes.length - 1 ? 'bg-accent' : 'bg-border-strong',
                      )}
                      style={{ height: `${Math.max(15, (a / top) * 100)}%` }}
                    />
                  ))}
                </span>
                <span
                  className={clsx(
                    'shrink-0 text-right text-sm font-medium',
                    x.draft.match.direction === 'in' && 'text-positive',
                  )}
                >
                  {hi - lo <= lo * 0.1 ? (
                    <>
                      <span className="text-xs font-normal text-muted">about </span>
                      <Amount
                        minor={Math.round((lo + hi) / 2)}
                        currency={currency}
                        kind="balance"
                        whole={whole}
                      />
                    </>
                  ) : (
                    <>
                      <Amount minor={lo} currency={currency} kind="balance" whole={whole} />–
                      <Amount minor={hi} currency={currency} kind="balance" whole={whole} />
                    </>
                  )}
                </span>
              </div>
              {/* On a phone: what it is and Edit, then Confirm and Not recurring. */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:justify-end">
                <Select
                  aria-label={`What ${x.name} is`}
                  className="min-w-0 sm:w-36"
                  value={kindOf(x)}
                  onChange={(v) => setKinds({ ...kinds, [id(x)]: v as RecurringKind })}
                >
                  {SECTIONS.map(({ kind, title }) => (
                    <SelectItem key={kind} id={kind}>
                      {title.replace(/s$/, '')}
                    </SelectItem>
                  ))}
                </Select>
                {askWho(x) ? (
                  <Select
                    aria-label={`Who looks after ${x.name}`}
                    className="col-span-2 min-w-0 sm:col-span-1 sm:w-36"
                    value={whoOf(x)}
                    onChange={(v) => setChosen({ ...chosen, [id(x)]: String(v) })}
                  >
                    {(x.seenBy ?? []).map((m) => (
                      <SelectItem key={m} id={m}>
                        {namesOf([m], members) || 'Someone'}
                      </SelectItem>
                    ))}
                  </Select>
                ) : kindOf(x) === 'income' &&
                  showWho(x.seenBy ?? []) &&
                  namesOf(x.forMemberIds ?? [], members) ? (
                  <span className="col-span-2 text-xs text-muted sm:col-span-1">
                    For {namesOf(x.forMemberIds ?? [], members)}
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={busy}
                  aria-label={`Edit ${x.name} before confirming`}
                  onPress={() => setEditing(x)}
                >
                  <Pencil aria-hidden className="size-4" />
                  <span className="hidden sm:inline">Edit</span>
                </Button>
                <Button size="sm" isDisabled={busy} onPress={() => confirm.mutate([x])}>
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy}
                  onPress={() => dismiss.mutate(x)}
                >
                  Not recurring
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="px-1 text-xs text-muted">
        Not shown: payments that stopped, and spending that’s frequent but not steady, like
        groceries. You can still make any transaction recurring yourself.
      </p>
      {editing ? (
        // The same dialog as Make recurring: change anything, and saving confirms it.
        <RecurringDialog
          householdId={householdId}
          initial={{
            name: editing.name,
            kind: kindOf(editing),
            draft: editing.draft,
            responsibleMemberId: whoOf(editing),
          }}
          accountName={accountName(editing.draft.accountId)}
          currency={currency}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
