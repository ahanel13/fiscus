// SPDX-License-Identifier: AGPL-3.0-or-later
import { type WeeklyRecap, weekLabel } from '@fiscus/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { api } from '../api/client.js';
import { Amount } from './Amount.js';
import { Card, LoadingRegion, Skeleton } from './ui.js';

// Your weekly recap on the dashboard (#128; bills walkthrough §8, D21): last week, from only what
// you can see. The same recap is emailed on Mondays to those who want it.

export const recapQuery = (householdId: string) => ({
  queryKey: ['households', householdId, 'recap'],
  queryFn: async () =>
    (await api<{ data: WeeklyRecap }>('GET', `/api/v1/households/${householdId}/recap`)).data,
  staleTime: 5 * 60_000,
});

const fmt = (d: string, o: Intl.DateTimeFormatOptions) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { ...o, timeZone: 'UTC' });

export function WeeklyRecapCard({ householdId }: { householdId: string }) {
  const query = useQuery(recapQuery(householdId));
  // The recap is a summary of what's elsewhere: if it can't be worked out, the rest still shows.
  if (query.isError) return null;
  return (
    <Card className="space-y-4">
      {query.isPending ? (
        <LoadingRegion label="Loading your week">
          <Skeleton className="h-40" />
        </LoadingRegion>
      ) : (
        <WeeklyRecapView
          recap={query.data}
          review={
            <Link to={`/h/${householdId}/review`} className="font-medium text-accent-text">
              Review them
            </Link>
          }
        />
      )}
    </Card>
  );
}

/** The recap itself: the week's three numbers, what's coming up, and what's worth a look. */
export function WeeklyRecapView({ recap: r, review }: { recap: WeeklyRecap; review?: ReactNode }) {
  const money = (minor: number, whole = false) => (
    <Amount minor={minor} currency={r.currency} kind="balance" whole={whole} />
  );
  const usual = r.spending.usualMinor;
  const diff = usual === null ? 0 : r.spending.spentMinor - usual;
  return (
    <>
      <div>
        <h2 className="font-semibold">Your week, {weekLabel(r.weekStart, r.weekEnd)}</h2>
        <p className="text-sm text-muted">
          {r.sees === 'yours_and_ours'
            ? 'What you can see: yours and ours.'
            : r.sees === 'yours'
              ? 'What you can see: yours.'
              : `${r.householdName}.`}
        </p>
      </div>
      {r.quiet ? (
        <p className="text-sm">A quiet week: nothing spent, and nothing coming up.</p>
      ) : (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          <Figure label="Spent">
            <span className="text-lg font-semibold">{money(r.spending.spentMinor)}</span>
            {usual !== null ? (
              <span className="block text-xs text-muted">
                {Math.abs(diff) < 100 ? (
                  'About as usual'
                ) : (
                  <>
                    {money(Math.abs(diff), true)} {diff < 0 ? 'less' : 'more'} than usual
                  </>
                )}
              </span>
            ) : null}
          </Figure>
          {r.budgets ? (
            <Figure label={`Left in ${fmt(`${r.budgets.month}-01`, { month: 'long' })}’s budgets`}>
              <span
                className={clsx('text-lg font-semibold', r.budgets.leftMinor < 0 && 'text-danger')}
              >
                {money(r.budgets.leftMinor)}
              </span>
              <span className="block text-xs text-muted">
                {r.budgets.daysLeft} {r.budgets.daysLeft === 1 ? 'day' : 'days'} to go
              </span>
            </Figure>
          ) : null}
          {r.netWorth ? (
            <Figure label="Net worth">
              <span className="text-lg font-semibold">{money(r.netWorth.netWorthMinor, true)}</span>
              <span className="block text-xs text-muted">
                {r.netWorth.changeMinor === 0 ? (
                  'No change this week'
                ) : (
                  <>
                    {r.netWorth.changeMinor > 0 ? '+' : '−'}
                    {money(Math.abs(r.netWorth.changeMinor), true)} this week
                  </>
                )}
              </span>
            </Figure>
          ) : null}
        </div>
      )}
      {r.comingUp.length ? (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold">Coming up this week</h3>
          <ul className="divide-y divide-border text-sm">
            {r.comingUp.map((c) => (
              <li key={`${c.kind}:${c.name}:${c.due}`} className="flex items-center gap-3 py-2">
                <span className="w-14 shrink-0 text-xs text-muted">
                  {fmt(c.due, { weekday: 'short' })} {Number(c.due.slice(8))}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {c.name}
                  {c.lookAfter ? (
                    <span className="text-muted"> · {c.lookAfter} looks after it</span>
                  ) : null}
                </span>
                <span
                  className={clsx(
                    'shrink-0 text-right',
                    (c.amountMinor ?? 0) > 0 && 'text-positive',
                  )}
                >
                  {c.amountMinor === null ? (
                    '—'
                  ) : (
                    <>
                      {c.about ? <span className="text-xs text-muted">about </span> : null}
                      {c.amountMinor > 0 ? '+' : ''}
                      {money(Math.abs(c.amountMinor))}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {r.worthALook.length ? (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold">Worth a look</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {r.worthALook.map((w, i) => (
              <li key={i}>
                {w.kind === 'over_budget' ? (
                  <>
                    {w.category} is {money(w.overMinor)} over its budget
                  </>
                ) : w.kind === 'biggest_purchase' ? (
                  <>
                    {w.name}, {money(Math.abs(w.amountMinor))}
                    {w.account ? ` on ${w.account}` : ''}
                    <span className="text-muted"> · your biggest this week</span>
                  </>
                ) : (
                  <>
                    {w.name} is late: it was due {fmt(w.due, { month: 'short', day: 'numeric' })}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {r.toReview ? (
        <p className="text-sm">
          {r.toReview} {r.toReview === 1 ? 'transaction is' : 'transactions are'} waiting for
          review. {review}
        </p>
      ) : null}
    </>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      {children}
    </div>
  );
}
