import type { HouseholdMember } from '@fiscus/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { type Lens, lensOptions, parseLens } from '../lib/lens.js';
import { parseRange, RANGE_GROUPS } from '../lib/ranges.js';
import { SegmentedControl, Select, SelectItem, SelectSection } from './ui.js';

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
        <Select
          aria-label="Time range"
          value={range}
          onChange={(v) => v && set({ range: String(v) })}
          triggerClassName="min-w-40"
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
        </Select>
      ) : null}
      {showLens ? (
        options.length <= 4 ? (
          <SegmentedControl
            aria-label="Whose money"
            options={options}
            value={lens}
            onChange={(v) => set({ lens: v })}
          />
        ) : (
          <Select
            aria-label="Whose money"
            value={lens}
            onChange={(v) => v && set({ lens: String(v) as Lens })}
            triggerClassName="min-w-36"
          >
            {options.map((o) => (
              <SelectItem key={o.value} id={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </Select>
        )
      ) : null}
      {action}
    </header>
  );
}
