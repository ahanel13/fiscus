// SPDX-License-Identifier: AGPL-3.0-or-later
import { describeSchedule, type RecurringKind, type RecurringSeries } from '@fiscus/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { Calendar, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { accountsQuery, membersQuery, recurringQuery } from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecurringDialog } from '../components/RecurringDialog.js';
import { Alert, LoadingRegion, Skeleton } from '../components/ui.js';

// Bills & recurring (#118; bills walkthrough §4): every series you can see, by kind, with when
// it's next due and about how much. Upcoming, the calendar and detection come next (#119, #120).

const SECTIONS: { kind: RecurringKind; title: string }[] = [
  { kind: 'income', title: 'Income' },
  { kind: 'bill', title: 'Bills' },
  { kind: 'subscription', title: 'Subscriptions' },
  { kind: 'transfer', title: 'Transfers' },
];

const dateLabel = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export function RecurringPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const list = useQuery(recurringQuery(householdId));
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const [open, setOpen] = useState<RecurringSeries | null>(null);
  const accountOf = (id: string) => accounts.find((a) => a.id === id);
  const series = list.data ?? [];
  const active = series.filter((s) => !s.endedOn || (s.next && s.next <= s.endedOn));
  const ended = series.filter((s) => !active.includes(s));

  const row = (s: RecurringSeries) => (
    <li key={s.id}>
      <button
        type="button"
        onClick={() => setOpen(s)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{s.name}</span>
          <span className="block truncate text-xs text-muted">
            {describeSchedule(s.schedule)} · {accountOf(s.accountId)?.name ?? 'An account'}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-sm font-medium">
            {s.estimateMinor !== null ? (
              <>
                <span className="text-xs font-normal text-muted">about </span>
                <Amount minor={s.estimateMinor} currency={s.currency} whole />
              </>
            ) : (
              <span className="text-muted">—</span>
            )}
          </span>
          <span className="block text-xs text-muted">
            {s.next ? `Next ${dateLabel(s.next)}` : 'Ended'}
          </span>
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted" />
      </button>
    </li>
  );

  return (
    <>
      <PageHeader title="Bills & recurring" showLens={false} members={members} />
      <div className="mx-auto max-w-3xl space-y-5 px-4 py-4 sm:py-6 md:px-8">
        {list.isPending ? (
          <LoadingRegion label="Loading recurring payments">
            <div className="space-y-3">
              <Skeleton className="h-16" />
              <Skeleton className="h-40" />
            </div>
          </LoadingRegion>
        ) : list.isError ? (
          <Alert>Couldn’t load your recurring payments. Try again in a moment.</Alert>
        ) : series.length === 0 ? (
          <EmptyState icon={Calendar} title="Nothing recurring yet">
            <p>
              Open a paycheck, a bill or a subscription in Transactions, and choose{' '}
              <b>Make recurring</b>. Fiscus finds the payments before it, and when the next one is
              due.
            </p>
          </EmptyState>
        ) : (
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
                <ul
                  className={clsx(
                    'divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface',
                    'opacity-80',
                  )}
                >
                  {ended.map(row)}
                </ul>
              </section>
            ) : null}
            <p className="px-1 text-xs text-muted">
              To add another, open one of its payments in Transactions and choose{' '}
              <b>Make recurring</b>.
            </p>
          </>
        )}
      </div>
      {open ? (
        <RecurringDialog
          householdId={householdId}
          initial={{
            name: open.name,
            kind: open.kind,
            draft: {
              accountId: open.accountId,
              match: open.match,
              schedule: open.schedule,
              windowDays: open.windowDays,
            },
          }}
          series={open}
          accountName={accountOf(open.accountId)?.name ?? 'its account'}
          currency={open.currency}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
