// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Comparison, Granularity, Household, Preset } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { api } from '../api/client.js';
import { preferencesQuery } from '../api/queries.js';
import {
  effectiveGranularity,
  type RangeSelection,
  readSelection,
  resolveSelection,
} from './ranges.js';

const SEARCH_KEYS = ['range', 'from', 'to', 'granularity', 'compare'] as const;

/**
 * A page's time range (ADR 0011 §5): from the URL if present (bookmarkable, shareable in the
 * household), else this member's remembered default for the page, else the page's default.
 * Changes go to the URL and are remembered for next time.
 */
export function useRange(household: Household, page: string, fallback: Preset) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const prefs = useQuery(preferencesQuery(household.id)).data;
  const key = `range:${page}`;

  const selection: RangeSelection = useMemo(
    () =>
      readSelection(search) ?? readSelection(prefs?.[key]) ?? { range: fallback, compare: 'none' },
    [search, prefs, key, fallback],
  );
  const settings = {
    timeZone: household.timezone,
    weekStart: household.weekStart,
    fiscalYearStartMonth: household.fiscalYearStartMonth,
  };
  const resolved = resolveSelection(selection, settings);
  const granularity = effectiveGranularity(selection, resolved);

  const remember = useMutation({
    mutationFn: (value: RangeSelection) =>
      api('PUT', `/api/v1/households/${household.id}/preferences/${encodeURIComponent(key)}`, {
        body: { value },
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['households', household.id, 'preferences'] }),
  });

  const set = (next: RangeSelection) => {
    void navigate({
      to: '.',
      replace: true,
      search: (prev: Record<string, unknown>) => {
        const rest = Object.fromEntries(
          Object.entries(prev).filter(([k]) => !(SEARCH_KEYS as readonly string[]).includes(k)),
        );
        return {
          ...rest,
          range: next.range,
          ...(next.range === 'custom' ? { from: next.from, to: next.to } : {}),
          ...(next.granularity ? { granularity: next.granularity } : {}),
          ...(next.compare !== 'none' ? { compare: next.compare } : {}),
        };
      },
    });
    remember.mutate(next);
  };

  return {
    selection,
    resolved,
    granularity,
    settings,
    setRange: (range: RangeSelection['range'], custom?: { from: string; to: string }) =>
      set({
        ...selection,
        range,
        ...(range === 'custom' ? custom : { from: undefined, to: undefined }),
      } as RangeSelection),
    setGranularity: (granularity: Granularity) => set({ ...selection, granularity }),
    setCompare: (compare: Comparison) => set({ ...selection, compare }),
  };
}

export type RangeState = ReturnType<typeof useRange>;
