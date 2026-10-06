// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CashFlow, CashFlowBucket, Household } from '@fiscus/shared';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { cashFlowQuery, householdQuery, membersQuery } from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { PageHeader } from '../components/PageHeader.js';
import { CompareSelect, GranularityToggle, PeriodStepper } from '../components/RangeControls.js';
import { Alert, Card, LoadingRegion, Skeleton } from '../components/ui.js';
import { type Lens, lensVisible, parseLens } from '../lib/lens.js';
import { bucketLabel, formatSpan, rangeParams } from '../lib/ranges.js';
import { useRange } from '../lib/use-range.js';
import { NetWorthCard } from './accounts.js';

/** Where you stand (IA): cash flow over the chosen range, and net worth. Reports come in M7. */
export function DashboardPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const search = useSearch({ strict: false }) as { lens?: string };
  const showLens = lensVisible(household, members.length);
  const lens: Lens = showLens ? parseLens(search.lens) : 'all';
  const range = useRange(household, 'dashboard', 'last_6m');

  return (
    <>
      <PageHeader title="Dashboard" range={range} showLens={showLens} members={members} />
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
        <CashFlowCard household={household} lens={lens} range={range} />
        <NetWorthCard household={household} lens={lens} />
      </div>
    </>
  );
}

function CashFlowCard({
  household,
  lens,
  range,
}: {
  household: Household;
  lens: Lens;
  range: ReturnType<typeof useRange>;
}) {
  const query = useQuery(
    cashFlowQuery(household.id, lens, rangeParams(range.selection, range.granularity)),
  );
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto font-semibold">
          Cash flow <span className="text-sm font-normal text-muted">(visible to you)</span>
        </h2>
        <PeriodStepper state={range} />
        <GranularityToggle state={range} />
        <CompareSelect state={range} />
      </div>
      {query.isPending ? (
        <LoadingRegion label="Loading cash flow">
          <Skeleton className="h-48" />
        </LoadingRegion>
      ) : query.isError ? (
        <Alert>Couldn’t load cash flow. Try again in a moment.</Alert>
      ) : (
        <CashFlowBody flow={query.data} householdId={household.id} />
      )}
    </Card>
  );
}

const pct = (now: number, before: number) =>
  before === 0 ? null : Math.round(((now - before) / Math.abs(before)) * 100);

function Delta({
  now,
  before,
  lessIsBetter,
}: {
  now: number;
  before: number;
  lessIsBetter?: boolean;
}) {
  const p = pct(now, before);
  if (p === null) return null;
  const better = lessIsBetter ? p < 0 : p > 0;
  return (
    <span
      className={clsx('text-xs', p === 0 ? 'text-muted' : better ? 'text-positive' : 'text-muted')}
    >
      {p === 0 ? 'Same as before' : `${Math.abs(p)}% ${p > 0 ? 'more' : 'less'} than before`}
    </span>
  );
}

function CashFlowBody({ flow, householdId }: { flow: CashFlow; householdId: string }) {
  const c = flow.currency;
  const withData = flow.buckets.filter((b) => b.incomeMinor !== null);
  if (withData.length === 0) {
    return (
      <p className="text-sm text-muted">
        No transactions in this range yet.{' '}
        <Link to={`/h/${householdId}/transactions`} className="font-medium text-accent-text">
          Add some
        </Link>
        .
      </p>
    );
  }
  const max = Math.max(1, ...withData.flatMap((b) => [b.incomeMinor ?? 0, b.spendingMinor ?? 0]));
  const totals: [string, number, number | undefined, boolean][] = [
    ['Money in', flow.totals.incomeMinor, flow.comparison?.incomeMinor, false],
    ['Money out', flow.totals.spendingMinor, flow.comparison?.spendingMinor, true],
    ['Net', flow.totals.netMinor, flow.comparison?.netMinor, false],
  ];
  return (
    <div className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-3">
        {totals.map(([label, value, before, lessIsBetter]) => (
          <div key={label}>
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="space-y-0.5">
              <Amount
                minor={label === 'Money out' ? -value : value}
                currency={c}
                kind={label === 'Net' ? 'balance' : 'flow'}
                className="block text-xl font-semibold"
              />
              {before !== undefined ? (
                <Delta now={value} before={before} lessIsBetter={lessIsBetter} />
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <table className="w-full text-sm">
        <caption className="sr-only">Money in and out per period</caption>
        <thead>
          <tr className="text-left text-xs text-muted">
            <th scope="col" className="w-36 pb-2 font-medium">
              Period
            </th>
            <th scope="col" className="pb-2 font-medium">
              <span className="sr-only">Chart</span>
            </th>
            <th scope="col" className="w-28 pb-2 text-right font-medium">
              In
            </th>
            <th scope="col" className="w-28 pb-2 text-right font-medium">
              Out
            </th>
          </tr>
        </thead>
        <tbody>
          {flow.buckets.map((b) => (
            <BucketRow key={b.start} b={b} max={max} currency={c} />
          ))}
        </tbody>
      </table>
      {flow.averages.spendingMinor !== null ? (
        <p className="text-xs text-muted">
          Average per {flow.range.granularity ?? 'period'}:{' '}
          <Amount minor={flow.averages.incomeMinor ?? 0} currency={c} kind="balance" /> in,{' '}
          <Amount minor={flow.averages.spendingMinor} currency={c} kind="balance" /> out. Periods
          still in progress, and before your first transaction, aren’t averaged.
        </p>
      ) : null}
      {flow.range.comparison ? (
        <p className="text-xs text-muted">
          Compared with {formatSpan(flow.range.comparison.from, flow.range.comparison.to)}.
        </p>
      ) : null}
    </div>
  );
}

const hatch = {
  backgroundImage:
    'repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in oklab, var(--surface) 55%, transparent) 4px 7px)',
};

function BucketRow({ b, max, currency }: { b: CashFlowBucket; max: number; currency: string }) {
  const empty = b.incomeMinor === null;
  return (
    <tr className="border-t border-border">
      <th scope="row" className="py-1.5 pr-2 text-left font-normal">
        {bucketLabel(b.start, b.end)}
        {b.partial ? <span className="block text-xs text-muted">so far</span> : null}
      </th>
      <td className="py-1.5">
        {empty ? (
          <span className="text-xs text-muted">No data</span>
        ) : (
          <div aria-hidden className="space-y-1">
            {(
              [
                ['bg-positive', b.incomeMinor ?? 0],
                ['bg-muted', b.spendingMinor ?? 0],
              ] as const
            ).map(([color, value]) => (
              <div
                key={color}
                className={clsx('h-2 rounded-full', color, b.partial && 'opacity-70')}
                style={{
                  width: `${Math.max(1, (value / max) * 100)}%`,
                  ...(b.partial ? hatch : {}),
                }}
              />
            ))}
          </div>
        )}
      </td>
      <td className="py-1.5 text-right">
        {empty ? '—' : <Amount minor={b.incomeMinor ?? 0} currency={currency} kind="balance" />}
      </td>
      <td className="py-1.5 text-right">
        {empty ? '—' : <Amount minor={b.spendingMinor ?? 0} currency={currency} kind="balance" />}
      </td>
    </tr>
  );
}
