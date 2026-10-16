// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  addMonths,
  allowedGranularities,
  type Comparison,
  type Granularity,
  type Preset,
} from '@fiscus/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { GRANULARITY_LABELS, RANGE_GROUPS, formatSpan, selectionLabel } from '../lib/ranges.js';
import type { RangeState } from '../lib/use-range.js';
import {
  Button,
  DateRangePicker,
  Dialog,
  DialogActions,
  type IsoRange,
  SegmentedControl,
  Select,
  SelectItem,
  SelectSection,
} from './ui.js';

// The shared range controls (ADR 0011 §2): the same on every page, so numbers line up.

/** Preset dropdown with a custom range, showing the resolved dates under the label. */
export function RangeSelect({
  state,
  align = 'end',
}: {
  state: RangeState;
  /** `start` in a form (a filters sheet); `end` in a page header. */
  align?: 'start' | 'end';
}) {
  const [custom, setCustom] = useState(false);
  const { selection, resolved } = state;
  const [draft, setDraft] = useState<IsoRange | null>({ start: resolved.from, end: resolved.to });
  return (
    <div className={align === 'start' ? 'flex flex-col items-start' : 'flex flex-col items-end'}>
      <Select
        aria-label="Time range"
        value={selection.range}
        onChange={(v) => {
          if (v === 'custom') {
            setDraft({ start: resolved.from, end: resolved.to });
            setCustom(true);
          } else if (v) state.setRange(v as Preset);
        }}
        triggerClassName={align === 'end' ? 'min-w-36 sm:min-w-44' : 'min-w-44'}
      >
        {RANGE_GROUPS.map((g) => (
          <SelectSection key={g.label} title={g.label}>
            {g.presets.map(([value, label]) => (
              <SelectItem key={value} id={value}>
                {label}
              </SelectItem>
            ))}
          </SelectSection>
        ))}
        <SelectSection title="Custom">
          <SelectItem id="custom" textValue="Custom range">
            {selection.range === 'custom' ? selectionLabel(selection) : 'Custom range…'}
          </SelectItem>
        </SelectSection>
      </Select>
      {selection.range !== 'custom' && selection.range !== 'all_time' ? (
        // In a page header the dates give way on a phone, where the page shows them anyway.
        <span className={`mt-0.5 text-xs text-muted ${align === 'end' ? 'hidden sm:block' : ''}`}>
          {formatSpan(resolved.from, resolved.to)}
          {resolved.partial ? ' (so far)' : ''}
        </span>
      ) : null}
      <Dialog title="Custom range" size="sm" isOpen={custom} onOpenChange={setCustom}>
        {(close) => (
          <div className="space-y-4">
            <DateRangePicker label="Dates" value={draft} onChange={setDraft} />
            <DialogActions>
              <Button variant="secondary" onPress={close}>
                Cancel
              </Button>
              <Button
                isDisabled={!draft}
                onPress={() => {
                  if (draft) state.setRange('custom', { from: draft.start, to: draft.end });
                  close();
                }}
              >
                Apply
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>
    </div>
  );
}

/** One-click chips for balance charts: 1M · 3M · 6M · YTD · 1Y · All (ADR 0011 §2). */
const CHIPS: { value: Preset; label: string }[] = [
  { value: 'last_30d', label: '1M' },
  { value: 'last_90d', label: '3M' },
  { value: 'last_6m', label: '6M' },
  { value: 'ytd', label: 'YTD' },
  { value: 'last_12m', label: '1Y' },
  { value: 'all_time', label: 'All' },
];

export function RangeChips({
  state,
  label = 'Chart range',
}: {
  state: RangeState;
  label?: string;
}) {
  const value = CHIPS.some((c) => c.value === state.selection.range)
    ? (state.selection.range as Preset)
    : 'last_12m';
  return (
    <SegmentedControl
      aria-label={label}
      options={CHIPS}
      value={value}
      onChange={(v) => state.setRange(v)}
    />
  );
}

/** Daily · Weekly · Monthly …: only the granularities that suit the range are offered. */
export function GranularityToggle({ state }: { state: RangeState }) {
  const allowed = allowedGranularities(state.resolved.from, state.resolved.to);
  if (allowed.length < 2) return null;
  return (
    <SegmentedControl
      aria-label="Group by"
      options={allowed.map((g) => ({ value: g, label: GRANULARITY_LABELS[g] }))}
      value={state.granularity}
      onChange={(g: Granularity) => state.setGranularity(g)}
    />
  );
}

const COMPARE_LABELS: Record<Comparison, string> = {
  none: 'No comparison',
  previous_period: 'Previous period',
  same_period_last_year: 'Same period last year',
};

export function CompareSelect({ state }: { state: RangeState }) {
  return (
    <Select
      aria-label="Compare with"
      value={state.selection.compare}
      onChange={(v) => v && state.setCompare(v as Comparison)}
      triggerClassName="min-w-44"
    >
      {(Object.keys(COMPARE_LABELS) as Comparison[]).map((c) => (
        <SelectItem key={c} id={c}>
          {COMPARE_LABELS[c]}
        </SelectItem>
      ))}
    </Select>
  );
}

const monthName = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const addMonthEnd = (from: string) => {
  const d = new Date(`${addMonths(from, 1)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** True when a range is exactly one calendar month. */
const wholeMonth = (from: string, to: string) => from.endsWith('-01') && addMonthEnd(from) === to;

/**
 * "‹ September 2026 ›" (ADR 0011 §2): steps a monthly view one month at a time; "This month"
 * jumps back. Shown when the range is a single month.
 */
export function PeriodStepper({ state }: { state: RangeState }) {
  const { resolved, selection } = state;
  const month =
    selection.range === 'this_month' ||
    selection.range === 'last_month' ||
    wholeMonth(resolved.from, resolved.periodEnd);
  if (!month) return null;
  const step = (n: number) => {
    const from = addMonths(resolved.from, n);
    state.setRange('custom', { from, to: addMonthEnd(from) });
  };
  const isCurrent = selection.range === 'this_month';
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Month">
      <Button variant="ghost" size="icon" aria-label="Previous month" onPress={() => step(-1)}>
        <ChevronLeft aria-hidden className="size-4" />
      </Button>
      <span className="min-w-32 text-center text-sm font-medium" aria-live="polite">
        {monthName.format(new Date(`${resolved.from}T00:00:00Z`))}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next month"
        isDisabled={isCurrent || resolved.partial}
        onPress={() => step(1)}
      >
        <ChevronRight aria-hidden className="size-4" />
      </Button>
      {!isCurrent ? (
        <Button variant="ghost" size="sm" onPress={() => state.setRange('this_month')}>
          This month
        </Button>
      ) : null}
    </div>
  );
}
