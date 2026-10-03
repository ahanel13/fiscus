import type { HouseholdMember } from '@fiscus/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { type Lens, lensOptions, parseLens } from '../lib/lens.js';
import { parseRange, RANGE_GROUPS } from '../lib/ranges.js';
import { Select } from './ui.js';

/** Title · time range · lens · action: the same header on every data page (IA §3). */
export function PageHeader({
  title,
  showRange,
  showLens,
  members,
  action,
}: {
  title: string;
  showRange: boolean;
  showLens: boolean;
  members: HouseholdMember[];
  action?: ReactNode;
}) {
  const search = useSearch({ strict: false }) as { lens?: string; range?: string };
  const navigate = useNavigate();
  const lens = parseLens(search.lens);
  const range = parseRange(search.range);
  const set = (patch: Record<string, string>) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace: true,
    });
  const options = lensOptions(members);

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 md:px-8 md:py-5">
      <h1 className="mr-auto text-xl font-semibold md:text-2xl">{title}</h1>
      {showRange ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Time range</span>
          <Select
            value={range}
            onChange={(e) => set({ range: e.target.value })}
            className="w-auto py-1.5"
          >
            {RANGE_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.presets.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>
      ) : null}
      {showLens ? (
        options.length <= 4 ? (
          <div
            role="radiogroup"
            aria-label="Whose money"
            className="flex rounded-lg border border-border bg-surface p-0.5 text-sm"
          >
            {options.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={lens === o.value}
                onClick={() => set({ lens: o.value })}
                className={clsx(
                  'rounded-md px-3 py-1',
                  lens === o.value ? 'bg-accent text-accent-fg' : 'hover:bg-surface-2',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          <Select
            aria-label="Whose money"
            value={lens}
            onChange={(e) => set({ lens: e.target.value as Lens })}
            className="w-auto py-1.5"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )
      ) : null}
      {action}
    </header>
  );
}
