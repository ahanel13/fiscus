// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatMoney, type Payoff } from '@fiscus/shared';
import { type KeyboardEvent, type PointerEvent, useId, useRef, useState } from 'react';

/** "Mar 2028", from `YYYY-MM`. */
export const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });

/**
 * Debt coming down (goals walkthrough §8): what's owed in all, month by month, under the chosen
 * plan (a line over a wash), against the minimums alone (dashed). One axis, from zero. A
 * crosshair shows a month, with each debt's balance; point at it, or focus it and use the arrow
 * keys. The debt rows below it say the same as text.
 */
export function PayoffChart({
  plan,
  minimums,
  names,
  owedNowMinor,
  thisMonth,
  currency,
  planLabel,
}: {
  plan: Payoff;
  minimums: Payoff;
  /** Each debt's name, in the debts' order. */
  names: string[];
  owedNowMinor: number;
  thisMonth: string;
  currency: string;
  planLabel: string;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const summaryId = useId();
  const washId = `payoff${useId().replace(/:/g, '')}`;
  const [active, setActive] = useState<number | null>(null);
  const money = (minor: number) => formatMoney(minor, currency);
  const sum = (owed: number[]) => owed.reduce((a, b) => a + b, 0);

  // Point 0 is now; point i is the end of month i. The range is the plan's, half again, so the
  // minimums' line shows how much longer it runs (or that it never ends) without flattening it.
  const length = Math.max(12, Math.ceil(plan.months.length * 1.5));
  const at = (p: Payoff, i: number) =>
    i === 0 ? owedNowMinor : i <= p.months.length ? sum(p.months[i - 1]!.owedMinor) : 0;
  const lastOf = (p: Payoff) => (p.debtFreeMonth ? p.months.length : length);
  const top = Math.max(
    1,
    owedNowMinor,
    ...Array.from({ length: Math.min(length, lastOf(minimums)) + 1 }, (_, i) => at(minimums, i)),
  );
  const x = (i: number) => (i / length) * 100;
  const y = (minor: number) => 100 - (minor / top) * 100;
  const line = (p: Payoff) =>
    Array.from(
      { length: Math.min(length, lastOf(p)) + 1 },
      (_, i) => `${i ? 'L' : 'M'}${x(i)} ${y(at(p, i))}`,
    ).join(' ');
  const planPath = line(plan);
  const minPath = line(minimums);
  const monthAt = (i: number) => {
    const [yy, mm] = thisMonth.split('-').map(Number) as [number, number];
    const index = yy * 12 + mm - 1 + i - 1;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  };
  // Years along the bottom: every January, thinned to at most six.
  const januaries = Array.from({ length: length + 1 }, (_, i) => i).filter(
    (i) => i > 0 && monthAt(i).endsWith('-01'),
  );
  const step = Math.ceil(januaries.length / 6);
  const ticks = januaries.filter((_, k) => k % step === 0);

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = plot.current!.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left) / box.width) * length);
    setActive(Math.max(0, Math.min(length, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? 0;
    const next =
      e.key === 'ArrowLeft'
        ? Math.max(current - 1, 0)
        : e.key === 'ArrowRight'
          ? Math.min(current + 1, length)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? length
              : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };
  const shownOwed =
    active === null
      ? null
      : active === 0
        ? null
        : active <= plan.months.length
          ? plan.months[active - 1]!.owedMinor
          : names.map(() => 0);
  const when = (i: number) => (i === 0 ? 'Now' : monthLabel(monthAt(i)));

  return (
    <figure className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-accent" /> {planLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t-2 border-dashed border-muted" /> Minimums alone
        </span>
      </div>
      <div
        ref={plot}
        role="group"
        aria-label="Debt over time"
        aria-describedby={summaryId}
        tabIndex={0}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((a) => a ?? 0)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        className="relative h-44 touch-pan-y rounded-sm text-accent outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:h-56"
      >
        <svg
          aria-hidden
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          <defs>
            <linearGradient id={washId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.18} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <line
            x1={0}
            x2={100}
            y1={100}
            y2={100}
            stroke="var(--border-strong)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={minPath}
            fill="none"
            stroke="var(--muted)"
            strokeWidth={2}
            strokeDasharray="5 4"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path d={`${planPath} V100 H0 Z`} fill={`url(#${washId})`} />
          <path
            d={planPath}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {ticks.map((i) => (
          <span
            key={i}
            aria-hidden
            className="pointer-events-none absolute top-full mt-1 -translate-x-1/2 text-xs text-muted"
            style={{ left: `${x(i)}%` }}
          >
            {monthAt(i).slice(0, 4)}
          </span>
        ))}
        {active !== null ? (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-border-strong"
              style={{ left: `${x(active)}%` }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute size-2.5 -translate-1/2 rounded-full bg-accent ring-2 ring-surface"
              style={{ left: `${x(active)}%`, top: `${y(at(plan, active))}%` }}
            />
            <div
              className={
                'pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap text-fg shadow-sm ' +
                (x(active) > 55 ? '-translate-x-full -ml-2' : 'ml-2')
              }
              style={{ left: `${x(active)}%` }}
            >
              <span className="block text-muted">{when(active)}</span>
              <span className="flex justify-between gap-4 font-medium">
                <span>{planLabel}</span>
                <span className="tabular-nums">{money(at(plan, active))}</span>
              </span>
              <span className="flex justify-between gap-4 text-muted">
                <span>Minimums alone</span>
                <span className="tabular-nums">
                  {money(active <= lastOf(minimums) ? at(minimums, active) : 0)}
                </span>
              </span>
              {shownOwed && names.length > 1 ? (
                <span className="mt-1 block border-t border-border pt-1">
                  {names.map((n, k) => (
                    <span key={n + k} className="flex justify-between gap-4 text-muted">
                      <span className="max-w-32 truncate">{n}</span>
                      <span className="tabular-nums">{money(shownOwed[k] ?? 0)}</span>
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <figcaption id={summaryId} className="sr-only">
        {money(owedNowMinor)} owed now.{' '}
        {plan.debtFreeMonth
          ? `${planLabel}: debt-free in ${monthLabel(plan.debtFreeMonth)}.`
          : `${planLabel}: not paid off at these payments.`}{' '}
        {minimums.debtFreeMonth
          ? `Minimums alone: ${monthLabel(minimums.debtFreeMonth)}.`
          : 'Minimums alone never pay it off.'}
      </figcaption>
      <p aria-live="polite" className="sr-only">
        {active !== null ? `${when(active)}: ${money(at(plan, active))}` : null}
      </p>
      <div className="h-4" aria-hidden />
    </figure>
  );
}
