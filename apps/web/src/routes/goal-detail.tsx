// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  addDays,
  addMonths,
  formatMoney,
  type Goal,
  type GoalProgress,
  type HouseholdMember,
  monthIndex,
} from '@fiscus/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from '../api/client.js';
import { GoalPicture } from '../components/GoalPicture.js';
import { GoalProgressChart } from '../components/GoalProgressChart.js';
import { claimLabel, lookOf, shortMonth, STATUS } from '../components/GoalRow.js';
import { Alert, Badge, Button, Dialog, DialogActions, Skeleton, toast } from '../components/ui.js';

// A savings goal up close (goals walkthrough §3–§4, #135, #137): what it has, this month planned
// against moved, the market for percentage claims (G12), its pace (G18) and where it leads, a chart
// of it all, what to change when it's at risk, what funds it, and its months.

type Data<T> = { data: T };
const base = (householdId: string) => `/api/v1/households/${householdId}`;

/** A savings goal's history, pace and projection (#135, #137). */
export const goalProgressQuery = (householdId: string, goalId: string) =>
  queryOptions({
    queryKey: ['households', householdId, 'goals', goalId, 'progress'],
    queryFn: async () =>
      (await api<Data<GoalProgress>>('GET', `${base(householdId)}/goals/${goalId}/progress`)).data,
  });

/** The last day of a `YYYY-MM` month, as a goal's date. */
const lastDay = (month: string) => addDays(addMonths(`${month}-01`, 1), -1);

export function GoalDetail({
  householdId,
  goal: g,
  members,
  currency,
  onEdit,
  onClose,
}: {
  householdId: string;
  goal: Goal;
  members: HouseholdMember[];
  currency: string;
  /** Opens the goal to change it; undefined when you can't. */
  onEdit?: (() => void) | undefined;
  onClose: () => void;
}) {
  const query = useQuery(goalProgressQuery(householdId, g.id));
  const queryClient = useQueryClient();
  const money = (minor: number) => formatMoney(minor, currency);
  const p = query.data;
  const thisMonth = p?.months.find((m) => m.month === p.thisMonth);
  const hasPercent = g.claims.some((c) => c.percentBps !== null);
  const status = p?.pace.status ?? g.pace.status;
  const badge = status ? STATUS[status] : null;
  const percent = Math.floor((g.progressMinor / g.targetMinor) * 100);

  // One click: raise the plan (and its budget line, G16), or move the date to the pace's month.
  const fix = useMutation({
    mutationFn: (patch: { planMinor: number } | { targetDate: string }) =>
      api('PATCH', `${base(householdId)}/goals/${g.id}`, {
        body: patch,
        headers: { 'if-match': `"v${g.version}"` },
      }),
    onSuccess: async (_, patch) => {
      await Promise.all(
        ['goals', 'budgets'].map((k) =>
          queryClient.invalidateQueries({ queryKey: ['households', householdId, k] }),
        ),
      );
      toast(
        'planMinor' in patch
          ? `${g.name}’s plan is ${money(patch.planMinor)} a month.`
          : `${g.name} is now for ${shortMonth(patch.targetDate)}.`,
      );
    },
    onError: (e) => {
      const err = e as ApiError;
      toast(err.title, { tone: 'error', description: err.detail ?? '' });
    },
  });

  const monthsMore =
    p?.pace.projectedMonth && !g.targetDate
      ? monthIndex(p.pace.projectedMonth) - monthIndex(p.thisMonth) + 1
      : null;

  return (
    <Dialog title={g.name} size="lg" isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <GoalPicture look={lookOf(householdId, g)} />
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
              {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
              <span>{statusLine(g, p, money)}</span>
            </p>
            <p className="text-sm text-muted">
              {g.targetDate ? `${money(g.targetMinor)} by ${shortMonth(g.targetDate)}` : null}
              {!g.targetDate ? `${money(g.targetMinor)}, no date` : null}
            </p>
          </div>
        </div>

        {query.isError ? <Alert>Couldn’t load its history. Try again in a moment.</Alert> : null}

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Saved" value={money(g.progressMinor)} note={`${percent}% of target`} />
          <Stat
            label="This month"
            value={p ? money(thisMonth?.movedMinor ?? 0) : null}
            note={g.planMinor ? `moved of ${money(g.planMinor)} planned` : 'moved in'}
          />
          {hasPercent ? (
            <Stat
              label="Market"
              value={p ? money(thisMonth?.marketMinor ?? 0) : null}
              note="this month, not a contribution"
            />
          ) : (
            <Stat
              label="Pace"
              value={p ? `${money(p.pace.paceMinor)}` : null}
              note={p?.pace.basis === 'plan' ? 'a month, its plan while new' : 'a month, moved in'}
            />
          )}
          <Stat
            label="At this pace"
            value={
              p ? (p.pace.projectedMonth ? shortMonth(p.pace.projectedMonth) : 'Not there') : null
            }
            note={
              monthsLate(p)
                ? `${monthsLate(p)} ${monthsLate(p) === 1 ? 'month' : 'months'} late`
                : monthsMore
                  ? `about ${monthsMore} ${monthsMore === 1 ? 'month' : 'months'} more`
                  : hasPercent && p
                    ? `at ${money(p.pace.paceMinor)} a month`
                    : g.targetDate
                      ? 'on time'
                      : ''
            }
          />
        </dl>

        {p ? (
          <GoalProgressChart
            progress={p}
            progressMinor={g.progressMinor}
            targetMinor={g.targetMinor}
            currency={currency}
          />
        ) : (
          <Skeleton className="h-52" />
        )}

        {p && p.pace.status === 'at_risk' && (p.fixes.planMinor || p.fixes.month) ? (
          <section aria-labelledby="what-to-change" className="space-y-2">
            <h3 id="what-to-change" className="text-sm font-medium">
              What to change
            </h3>
            <div className="flex flex-wrap gap-2">
              {p.fixes.planMinor ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={!g.canEdit || fix.isPending}
                  onPress={() => fix.mutate({ planMinor: p.fixes.planMinor! })}
                >
                  {money(p.fixes.planMinor)} a month makes {shortMonth(g.targetDate!)}
                </Button>
              ) : null}
              {p.fixes.month ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={!g.canEdit || fix.isPending}
                  onPress={() => fix.mutate({ targetDate: lastDay(p.fixes.month!) })}
                >
                  At {money(p.pace.paceMinor)} a month, it’s done in {shortMonth(p.fixes.month)}
                </Button>
              ) : null}
            </div>
            {!g.canEdit ? (
              <p className="text-xs text-muted">Owners and members can change its plan or date.</p>
            ) : null}
          </section>
        ) : null}

        <section aria-labelledby="funded-by" className="space-y-2">
          <h3 id="funded-by" className="text-sm font-medium">
            Funded by
          </h3>
          {g.claims.length === 0 ? (
            <p className="text-sm text-muted">Not funded yet: no account drawn on.</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border text-sm">
              {g.claims.map((c) => (
                <li key={c.accountId} className="flex items-baseline gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate">{claimLabel(c, members)}</span>
                  <span className="text-xs text-muted">
                    {c.percentBps !== null ? `${c.percentBps / 100}%` : 'Fixed'}
                  </span>
                  <span className="font-medium tabular-nums">{money(c.valueMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {p && p.months.length ? <Months progress={p} money={money} /> : null}

        <p className="text-xs text-muted">
          Its pace is what moved into its accounts over the last three months, or its plan while
          it’s newer. Earmarking money already there is progress, not saving, and the market’s
          changes are the market’s.
        </p>

        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Close
          </Button>
          {onEdit ? <Button onPress={onEdit}>Edit goal</Button> : null}
        </DialogActions>
      </div>
    </Dialog>
  );
}

const monthsLate = (p: GoalProgress | undefined) => p?.pace.monthsLate ?? 0;

/** The line beside its status. */
function statusLine(g: Goal, p: GoalProgress | undefined, money: (minor: number) => string) {
  const status = p?.pace.status ?? g.pace.status;
  if (status === 'done') return 'It reached its target';
  if (status === 'short') return `${money(g.shortMinor)} short in its accounts`;
  if (status === 'ahead') return 'A month’s plan or more ahead of a steady pace';
  if (status === 'on_track') return 'Its pace gets there by its date';
  if (status === 'at_risk') return 'At its pace, it falls short by its date';
  return 'No date, so no status: just progress';
}

function Stat({ label, value, note }: { label: string; value: string | null; note: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">
        {value ?? <Skeleton className="my-1 h-5 w-20" />}
      </dd>
      <dd className="text-xs text-muted">{note}</dd>
    </div>
  );
}

/** Month by month, newest first: the chart's numbers as text (G11, G12, G17). */
function Months({ progress: p, money }: { progress: GoalProgress; money: (n: number) => string }) {
  const rows = [...p.months].reverse().slice(0, 6);
  return (
    <section aria-labelledby="by-month" className="space-y-2">
      <h3 id="by-month" className="text-sm font-medium">
        Month by month
      </h3>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-xs text-muted">
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 text-left font-normal">
                Month
              </th>
              <th scope="col" className="px-3 py-2 text-right font-normal">
                Saved
              </th>
              <th scope="col" className="px-3 py-2 text-right font-normal">
                Moved in
              </th>
              <th scope="col" className="px-3 py-2 text-right font-normal">
                Market
              </th>
              <th scope="col" className="px-3 py-2 text-right font-normal">
                Claims changed
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((m) => (
              <tr key={m.month}>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {m.month === p.thisMonth ? 'This month' : shortMonth(m.month)}
                </th>
                <td className="px-3 py-2 text-right font-medium">{money(m.savedMinor)}</td>
                <td className="px-3 py-2 text-right">{money(m.movedMinor)}</td>
                <td className="px-3 py-2 text-right">
                  {m.marketMinor ? money(m.marketMinor) : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {m.claimsMinor ? money(m.claimsMinor) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
