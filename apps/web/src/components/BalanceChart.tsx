// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BalancePoint } from '@fiscus/shared';
import { type KeyboardEvent, type PointerEvent, useId, useMemo, useRef, useState } from 'react';
import { pointAt, scales, stepPath } from '../lib/balance-chart.js';
import { Amount, type AmountKind } from './Amount.js';
import { DateText } from './ui.js';

/**
 * An account's balance over a range (#353), as Monarch draws it: one line that steps where the
 * balance changed, a fading wash, and a dashed line at where the range began. No axes; a crosshair
 * shows the balance on a day. Point at it, or focus it and use the arrow keys. The
 * Balances tab lists the same numbers as a table.
 */
export function BalanceChart({
  points,
  from,
  to,
  currency,
  kind,
  label,
}: {
  /** The range's balances, led by the one in effect at its start (`opening`). */
  points: BalancePoint[];
  from: string;
  to: string;
  currency: string;
  kind: AmountKind;
  label: string;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const summaryId = useId();
  const washId = `wash${useId().replace(/:/g, '')}`;
  const [active, setActive] = useState<number | null>(null);
  const series = useMemo(
    () => points.map((p) => ({ date: p.asOf, amountMinor: p.amountMinor })),
    [points],
  );

  if (series.length === 0) {
    return <p className="py-10 text-center text-sm text-muted">No balances in this range.</p>;
  }
  const { x, y } = scales(series, from, to);
  const path = stepPath(series, to, x, y);
  const shown = active === null ? null : series[active]!;
  const first = series[0]!;
  const last = series.at(-1)!;

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = plot.current!.getBoundingClientRect();
    setActive(pointAt(series, x, ((e.clientX - box.left) / box.width) * 100));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? series.length - 1;
    const next =
      e.key === 'ArrowLeft'
        ? Math.max(current - 1, 0)
        : e.key === 'ArrowRight'
          ? Math.min(current + 1, series.length - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? series.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  return (
    <figure className="space-y-1">
      <div
        ref={plot}
        role="group"
        aria-label={label}
        aria-describedby={summaryId}
        tabIndex={0}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((a) => a ?? series.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        className="relative h-44 touch-pan-y sm:h-56 rounded-sm text-accent outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
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
          {/* A wash under the line, fading out: the trend, not a magnitude from zero. */}
          <path d={`${path} V100 H${x(first.date)} Z`} fill={`url(#${washId})`} />
          {/* Where the range started, to read the change against. */}
          <line
            x1={0}
            x2={100}
            y1={y(first.amountMinor)}
            y2={y(first.amountMinor)}
            stroke="var(--border-strong)"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {shown ? (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-border-strong"
              style={{ left: `${x(shown.date)}%` }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute size-2.5 -translate-1/2 rounded-full bg-accent ring-2 ring-surface"
              style={{ left: `${x(shown.date)}%`, top: `${y(shown.amountMinor)}%` }}
            />
            {/* Beside the crosshair, inside the plot; on the right half it sits to the left. */}
            <div
              className={
                'pointer-events-none absolute top-1 z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap text-fg shadow-sm ' +
                (x(shown.date) > 60 ? '-translate-x-full -ml-2' : 'ml-2')
              }
              style={{ left: `${x(shown.date)}%` }}
            >
              <span className="block text-muted">
                <DateText value={shown.date} format="date" />
              </span>
              <Amount
                minor={shown.amountMinor}
                currency={currency}
                kind={kind}
                className="font-medium"
              />
            </div>
          </>
        ) : null}
      </div>
      {/* What the line says, for a screen reader; the focused point is announced as it moves. */}
      <figcaption id={summaryId} className="sr-only">
        From <DateText value={first.date} format="date" />,{' '}
        <Amount minor={first.amountMinor} currency={currency} kind={kind} />, to{' '}
        <DateText value={last.date} format="date" />,{' '}
        <Amount minor={last.amountMinor} currency={currency} kind={kind} />.
      </figcaption>
      <p aria-live="polite" className="sr-only">
        {shown ? (
          <>
            <DateText value={shown.date} format="date" />:{' '}
            <Amount minor={shown.amountMinor} currency={currency} kind={kind} />
          </>
        ) : null}
      </p>
    </figure>
  );
}
