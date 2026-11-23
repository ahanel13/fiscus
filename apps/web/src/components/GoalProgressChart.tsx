// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatMoney, type GoalProgress, monthIndex, monthOf, steadyAt } from '@fiscus/shared';
import { type KeyboardEvent, type PointerEvent, useId, useRef, useState } from 'react';
import { monthLabel } from './PayoffChart.js';

/** The furthest a goal's chart runs past now: five years. */
const MAX_AHEAD = 60;

/**
 * A savings goal over time (goals walkthrough §3, #135): what it had at each month's end (a line
 * over a wash), where its pace leads from now (dashed), a steady line from where it began to the
 * target by its date (dotted), and the target. One axis, from zero. A crosshair shows a month;
 * point at it, or focus it and use the arrow keys. The month-by-month list says the same as text.
 */
export function GoalProgressChart({
  progress: p,
  progressMinor,
  targetMinor,
  currency,
}: {
  progress: GoalProgress;
  /** What it has now, as the goal says. */
  progressMinor: number;
  targetMinor: number;
  currency: string;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const summaryId = useId();
  const washId = `goal${useId().replace(/:/g, '')}`;
  const [active, setActive] = useState<number | null>(null);
  const money = (minor: number) => formatMoney(minor, currency);

  // x is a month index, a month at its end; now sits within this month.
  const now = monthIndex(p.thisMonth);
  const nowX = now - 1 + p.monthFraction;
  const history = p.months.map((m) => ({
    x: m.month === p.thisMonth ? nowX : monthIndex(m.month),
    month: m,
  }));
  const first = history[0]?.x ?? nowX;
  const lastProjected = p.projection.length
    ? monthIndex(p.projection[p.projection.length - 1]!.month)
    : now;
  const due = p.steady ? monthIndex(p.steady.toMonth) : now;
  const end = Math.min(now + MAX_AHEAD, Math.max(now + 1, lastProjected, due));
  const start = Math.min(first, now - 1);
  const span = Math.max(1, end - start);
  const top = Math.max(targetMinor, progressMinor, ...p.months.map((m) => m.savedMinor), 1) * 1.08;
  const x = (i: number) => ((i - start) / span) * 100;
  const y = (minor: number) => 100 - (Math.max(0, minor) / top) * 100;

  const actual = history.map((h, i) => `${i ? 'L' : 'M'}${x(h.x)} ${y(h.month.savedMinor)}`);
  const ahead = [
    `M${x(nowX)} ${y(progressMinor)}`,
    ...p.projection
      .filter((q) => monthIndex(q.month) <= end)
      .map((q) => `L${x(monthIndex(q.month))} ${y(q.savedMinor)}`),
  ].join(' ');
  const steady = p.steady
    ? `M${x(Math.max(start, monthIndex(p.steady.fromMonth)))} ${y(
        steadyAt(p.steady, Math.max(start, monthIndex(p.steady.fromMonth))),
      )} L${x(Math.min(end, due))} ${y(steadyAt(p.steady, Math.min(end, due)))}`
    : null;

  // Years along the bottom: every January, thinned to at most six; with less than a year, months.
  const marks = Array.from({ length: Math.floor(end) - Math.ceil(start) + 1 }, (_, k) =>
    Math.ceil(start + k),
  );
  const januaries = marks.filter((i) => monthOf(i).endsWith('-12'));
  const short = januaries.length < 2;
  const ticks = (short ? marks : januaries).filter(
    (_, k, all) => k % Math.ceil(all.length / 6) === 0,
  );
  const tickLabel = (i: number) =>
    short
      ? new Date(`${monthOf(i + 1)}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' })
      : monthOf(i + 1).slice(0, 4);

  // The crosshair snaps to months: past ones, now, and the months ahead.
  const stops = [...history.map((h) => h.x), ...marks.filter((i) => i > nowX)].sort(
    (a, b) => a - b,
  );
  const nearest = (to: number) =>
    stops.reduce((best, s, k) => (Math.abs(s - to) < Math.abs(stops[best]! - to) ? k : best), 0);
  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = plot.current!.getBoundingClientRect();
    setActive(nearest(start + ((e.clientX - box.left) / box.width) * span));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? history.length - 1;
    const next =
      e.key === 'ArrowLeft'
        ? Math.max(current - 1, 0)
        : e.key === 'ArrowRight'
          ? Math.min(current + 1, stops.length - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? stops.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };
  const shown = active === null ? null : stops[active]!;
  const past = shown === null ? null : history.find((h) => h.x === shown)?.month;
  const projected =
    shown === null || past
      ? null
      : (p.projection.find((q) => monthIndex(q.month) === shown)?.savedMinor ??
        (p.projection.length && shown > lastProjected ? targetMinor : null));
  const pointY = shown === null ? null : past ? past.savedMinor : (projected ?? null);
  const when =
    shown === null ? '' : shown === nowX ? 'Now' : monthLabel(monthOf(Math.round(shown)));

  return (
    <figure className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-accent" /> Saved
        </span>
        {p.projection.length ? (
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-dashed border-accent" /> At this pace
          </span>
        ) : null}
        {steady ? (
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-dotted border-muted" /> Steady to the date
          </span>
        ) : null}
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t border-border-strong" /> Target
        </span>
      </div>
      <div
        ref={plot}
        role="group"
        aria-label="Saved over time"
        aria-describedby={summaryId}
        tabIndex={0}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((a) => a ?? history.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        className="relative h-44 touch-pan-y rounded-sm text-accent outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:h-52"
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
          <line
            x1={0}
            x2={100}
            y1={y(targetMinor)}
            y2={y(targetMinor)}
            stroke="var(--border-strong)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {p.steady && due <= end ? (
            <line
              x1={x(due)}
              x2={x(due)}
              y1={y(targetMinor) - 3}
              y2={100}
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {steady ? (
            <path
              d={steady}
              fill="none"
              stroke="var(--muted)"
              strokeWidth={2}
              strokeDasharray="1 4"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {history.length > 1 ? (
            <path d={`${actual.join(' ')} V100 H${x(history[0]!.x)} Z`} fill={`url(#${washId})`} />
          ) : null}
          {history.length > 1 ? (
            <path
              d={actual.join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {p.projection.length ? (
            <path
              d={ahead}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeDasharray="5 4"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 -translate-y-full pb-0.5 text-xs text-muted"
          style={{ top: `${y(targetMinor)}%` }}
        >
          Target {money(targetMinor)}
        </span>
        <div
          aria-hidden
          className="pointer-events-none absolute size-2.5 -translate-1/2 rounded-full bg-accent ring-2 ring-surface"
          style={{ left: `${x(nowX)}%`, top: `${y(progressMinor)}%` }}
        />
        {ticks.map((i) => (
          <span
            key={i}
            aria-hidden
            className="pointer-events-none absolute top-full mt-1 -translate-x-1/2 text-xs text-muted"
            style={{ left: `${x(i)}%` }}
          >
            {tickLabel(i)}
          </span>
        ))}
        {shown !== null ? (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-border-strong"
              style={{ left: `${x(shown)}%` }}
            />
            {pointY !== null ? (
              <div
                aria-hidden
                className="pointer-events-none absolute size-2.5 -translate-1/2 rounded-full bg-accent ring-2 ring-surface"
                style={{ left: `${x(shown)}%`, top: `${y(pointY)}%` }}
              />
            ) : null}
            <div
              className={
                'pointer-events-none absolute top-1 z-10 min-w-44 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap text-fg shadow-sm ' +
                (x(shown) > 55 ? '-translate-x-full -ml-2' : 'ml-2')
              }
              style={{ left: `${x(shown)}%` }}
            >
              <span className="block text-muted">{when}</span>
              {past ? (
                <>
                  <Row label="Saved" value={money(past.savedMinor)} strong />
                  <Row label="Moved in" value={money(past.movedMinor)} />
                  {past.marketMinor ? <Row label="Market" value={money(past.marketMinor)} /> : null}
                  {past.claimsMinor ? (
                    <Row label="Claims changed" value={money(past.claimsMinor)} />
                  ) : null}
                </>
              ) : projected !== null ? (
                <Row label="At this pace" value={money(projected)} strong />
              ) : (
                <span className="block text-muted">No pace to project</span>
              )}
              {p.steady ? (
                <Row
                  label="Steady to the date"
                  value={money(Math.round(steadyAt(p.steady, shown)))}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <figcaption id={summaryId} className="sr-only">
        {money(progressMinor)} saved of {money(targetMinor)}.{' '}
        {p.pace.projectedMonth
          ? `At this pace, it gets there in ${monthLabel(p.pace.projectedMonth)}.`
          : 'At this pace, it doesn’t get there.'}{' '}
        {p.steady ? `Its date is ${monthLabel(p.steady.toMonth)}.` : ''}
      </figcaption>
      <p aria-live="polite" className="sr-only">
        {shown !== null && pointY !== null ? `${when}: ${money(pointY)}` : null}
      </p>
      <div className="h-4" aria-hidden />
    </figure>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span className={'flex justify-between gap-4 ' + (strong ? 'font-medium' : 'text-muted')}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}
