// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HouseholdMember } from '@fiscus/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { type Lens, lensOptions, parseLens } from '../lib/lens.js';
import type { RangeState } from '../lib/use-range.js';
import { RangeSelect } from './RangeControls.js';
import { useShellTitle } from './shell-title.js';
import { SegmentedControl, Select, SelectItem } from './ui.js';

/** Title · time range · lens · action: the same header on every data page (IA §3). */
export function PageHeader({
  title,
  range,
  showLens,
  members,
  action,
}: {
  title: string;
  /** The page's time range (useRange), when it has one. */
  range?: RangeState | undefined;
  showLens: boolean;
  members: HouseholdMember[];
  action?: ReactNode;
}) {
  const search = useSearch({ strict: false }) as { lens?: string };
  const navigate = useNavigate();
  const lens = parseLens(search.lens);
  const set = (patch: Record<string, string>) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace: true,
    });
  const options = lensOptions(members);
  useShellTitle(title);

  const controls = range || showLens;
  // Phones: the title is in the top bar, so the range, "whose money" and the actions share one
  // row (wrapping if they must). Wider screens: the title, then all of them, on one row.
  return (
    <header
      className={clsx(
        'flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 md:px-8 md:py-5',
        // Nothing else to show on a phone: no empty band under the top bar.
        !controls && !action && 'max-md:border-0 max-md:p-0',
      )}
    >
      {/* It gives way before the actions wrap under it. Read out on a phone, shown above. */}
      <h1 className="min-w-0 flex-1 basis-0 truncate text-xl font-semibold max-md:sr-only md:text-2xl">
        {title}
      </h1>
      {controls ? (
        <div className="flex min-w-0 flex-1 items-start gap-2 sm:flex-none sm:flex-wrap sm:items-center">
          {range ? <RangeSelect state={range} /> : null}
          {showLens ? (
            <>
              {/* A dropdown on a phone, so the range and the lens share one row. */}
              <LensSelect
                options={options}
                lens={lens}
                onChange={(v) => set({ lens: v })}
                className={options.length <= 4 ? 'sm:hidden' : undefined}
              />
              {options.length <= 4 ? (
                <div className="hidden sm:block">
                  <SegmentedControl
                    aria-label="Whose money"
                    options={options}
                    value={lens}
                    onChange={(v) => set({ lens: v })}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {action ? <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}

function LensSelect({
  options,
  lens,
  onChange,
  className,
}: {
  options: { value: Lens; label: string }[];
  lens: Lens;
  onChange: (lens: Lens) => void;
  className?: string | undefined;
}) {
  return (
    <div className={className}>
      <Select
        aria-label="Whose money"
        value={lens}
        onChange={(v) => v && onChange(String(v) as Lens)}
        triggerClassName="min-w-28"
      >
        {options.map((o) => (
          <SelectItem key={o.value} id={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}
