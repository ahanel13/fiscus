// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  describeSchedule,
  LAST_DAY,
  type RecurringDraft,
  type RecurringKind,
  type RecurringMatch,
  type RecurringPreview,
  type RecurringSchedule,
  type RecurringSeries,
  type WeekendRule,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { Amount } from './Amount.js';
import {
  AmountInput,
  Button,
  DatePicker,
  Dialog,
  DialogActions,
  Select,
  SelectItem,
  TextField,
  toast,
  useToday,
} from './ui.js';

// Make recurring, and editing a series (#118; bills walkthrough §3, D6, D11): what it is, when
// it comes, and what it matches, with the dates and payments that gives as you change it.

const KINDS: Record<RecurringKind, string> = {
  income: 'Income',
  bill: 'Bill',
  subscription: 'Subscription',
  transfer: 'Transfer',
};

/** The schedules people pick from, as one choice. */
const REPEATS = {
  week1: 'Every week',
  week2: 'Every 2 weeks',
  twice: 'Twice a month',
  month1: 'Every month',
  month2: 'Every 2 months',
  month3: 'Every 3 months',
  month6: 'Every 6 months',
  month12: 'Every year',
} as const;
type Repeat = keyof typeof REPEATS | 'days';

const WEEKEND: Record<WeekendRule, string> = {
  before: 'The Friday before',
  after: 'The Monday after',
  as_is: 'That day',
};

type AmountMode = 'any' | 'min' | 'max' | 'between';

interface Form {
  name: string;
  kind: RecurringKind;
  accountId: string;
  direction: 'in' | 'out';
  /** Empty: any name. */
  named: string;
  namedOp: 'equals' | 'contains' | 'starts_with';
  amountMode: AmountMode;
  min: number | null;
  max: number | null;
  repeat: Repeat;
  /** Every N days, for a schedule that came that way. */
  everyDays: number;
  anchor: string;
  days: [number, number];
  weekend: WeekendRule;
  windowDays: number;
}

function toForm(name: string, kind: RecurringKind, d: RecurringDraft): Form {
  const s = d.schedule;
  const a = d.match.amount;
  const day = Number(s.anchor.slice(8, 10));
  return {
    name,
    kind,
    accountId: d.accountId,
    direction: d.match.direction,
    named: d.match.description?.value ?? '',
    namedOp: d.match.description?.op ?? 'equals',
    amountMode: !a
      ? 'any'
      : a.min !== undefined && a.max !== undefined
        ? 'between'
        : a.min !== undefined
          ? 'min'
          : 'max',
    min: a?.min ?? null,
    max: a?.max ?? null,
    repeat:
      s.unit === 'week'
        ? s.every === 1
          ? 'week1'
          : 'week2'
        : s.unit === 'day'
          ? 'days'
          : s.days.length === 2
            ? 'twice'
            : (`month${s.every}` as Repeat) in REPEATS
              ? (`month${s.every}` as Repeat)
              : 'month1',
    everyDays: s.unit === 'day' ? s.every : 30,
    anchor: s.anchor,
    days: s.unit === 'month' ? [s.days[0]!, s.days[1] ?? 15] : [day, day === 1 ? 15 : 1],
    weekend: s.weekend,
    windowDays: d.windowDays,
  };
}

function toSchedule(f: Form): RecurringSchedule {
  const { anchor, weekend } = f;
  if (f.repeat === 'week1' || f.repeat === 'week2') {
    return { unit: 'week', every: f.repeat === 'week1' ? 1 : 2, anchor, weekend };
  }
  if (f.repeat === 'days') return { unit: 'day', every: f.everyDays, anchor, weekend };
  if (f.repeat === 'twice') {
    const [a, b] = f.days;
    return { unit: 'month', every: 1, days: a === b ? [a] : [a, b], anchor, weekend };
  }
  return { unit: 'month', every: Number(f.repeat.slice(5)), days: [f.days[0]], anchor, weekend };
}

function toMatch(f: Form): RecurringMatch {
  const amount =
    f.amountMode === 'min' && f.min !== null
      ? { min: f.min }
      : f.amountMode === 'max' && f.max !== null
        ? { max: f.max }
        : f.amountMode === 'between' && f.min !== null && f.max !== null
          ? { min: Math.min(f.min, f.max), max: Math.max(f.min, f.max) }
          : undefined;
  return {
    direction: f.direction,
    ...(f.named.trim() ? { description: { op: f.namedOp, value: f.named.trim() } } : {}),
    ...(amount ? { amount } : {}),
  };
}

const toDraft = (f: Form): RecurringDraft => ({
  accountId: f.accountId,
  match: toMatch(f),
  schedule: toSchedule(f),
  windowDays: f.windowDays,
});

/** Waits for typing to pause before passing a value on. */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

const dayLabel = (d: number) => (d === LAST_DAY ? 'Last day' : String(d));
const DAYS = [...Array.from({ length: 31 }, (_, i) => i + 1), LAST_DAY];

const shortDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/**
 * Making a series (from a suggestion) or changing one. `series` given: it's being changed, and
 * can be ended or deleted.
 */
export function RecurringDialog({
  householdId,
  initial,
  series,
  accountName,
  currency,
  onClose,
}: {
  householdId: string;
  initial: { name: string; kind: RecurringKind; draft: RecurringDraft };
  series?: RecurringSeries;
  accountName: string;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const today = useToday();
  const [form, setForm] = useState(() => toForm(initial.name, initial.kind, initial.draft));
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const draft = useSettled(toDraft(form));
  const preview = useQuery({
    queryKey: ['households', householdId, 'recurring', 'preview', draft],
    queryFn: async () =>
      (
        await api<{ data: RecurringPreview }>(
          'POST',
          `/api/v1/households/${householdId}/recurring/preview`,
          { body: draft },
        )
      ).data,
    placeholderData: (prev) => prev,
  });
  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: ['households', householdId, 'recurring'] });
    toast(message);
    onClose();
  };
  const fail = (e: unknown) =>
    toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name.trim(), kind: form.kind, ...toDraft(form) };
      return series
        ? api('PATCH', `/api/v1/households/${householdId}/recurring/${series.id}`, {
            body: {
              name: body.name,
              kind: body.kind,
              match: body.match,
              schedule: body.schedule,
              windowDays: body.windowDays,
            },
          })
        : api('POST', `/api/v1/households/${householdId}/recurring`, { body });
    },
    onSuccess: () =>
      done(series ? `${form.name.trim()} is saved.` : `${form.name.trim()} is recurring.`),
    onError: fail,
  });
  const end = useMutation({
    mutationFn: (endedOn: string | null) =>
      api('PATCH', `/api/v1/households/${householdId}/recurring/${series!.id}`, {
        body: { endedOn },
      }),
    onSuccess: (_r, endedOn) =>
      done(endedOn ? `${form.name.trim()} has ended.` : `${form.name.trim()} is back.`),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/v1/households/${householdId}/recurring/${series!.id}`),
    onSuccess: () => done(`${form.name.trim()} is removed. Its transactions stay as they are.`),
    onError: fail,
  });
  const p = preview.data;
  const schedule = toSchedule(form);
  const monthly = schedule.unit === 'month';

  return (
    <Dialog
      title={series ? series.name : 'Make recurring'}
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Name" value={form.name} onChange={(name) => set({ name })} />
          <Select
            label="What it is"
            value={form.kind}
            onChange={(v) => {
              const kind = v as RecurringKind;
              set({
                kind,
                direction:
                  kind === 'income' ? 'in' : form.kind === 'income' ? 'out' : form.direction,
              });
            }}
          >
            {Object.entries(KINDS).map(([id, label]) => (
              <SelectItem key={id} id={id}>
                {label}
              </SelectItem>
            ))}
          </Select>
          <Select
            label="Repeats"
            value={form.repeat}
            onChange={(v) => set({ repeat: v as Repeat })}
          >
            {[
              ...Object.entries(REPEATS).map(([id, label]) => (
                <SelectItem key={id} id={id}>
                  {label}
                </SelectItem>
              )),
              ...(form.repeat === 'days'
                ? [
                    <SelectItem key="days" id="days">
                      {`Every ${form.everyDays} days`}
                    </SelectItem>,
                  ]
                : []),
            ]}
          </Select>
          <Select
            label="On a weekend"
            value={form.weekend}
            onChange={(v) => set({ weekend: v as WeekendRule })}
          >
            {Object.entries(WEEKEND).map(([id, label]) => (
              <SelectItem key={id} id={id}>
                {label}
              </SelectItem>
            ))}
          </Select>
          {monthly ? (
            <div className="grid grid-cols-2 gap-3 sm:col-span-2">
              <Select
                label={form.repeat === 'twice' ? 'First day' : 'Day of the month'}
                value={form.days[0]}
                onChange={(v) => set({ days: [Number(v), form.days[1]] })}
              >
                {DAYS.map((d) => (
                  <SelectItem key={d} id={d}>
                    {dayLabel(d)}
                  </SelectItem>
                ))}
              </Select>
              {form.repeat === 'twice' ? (
                <Select
                  label="Second day"
                  value={form.days[1]}
                  onChange={(v) => set({ days: [form.days[0], Number(v)] })}
                >
                  {DAYS.map((d) => (
                    <SelectItem key={d} id={d}>
                      {dayLabel(d)}
                    </SelectItem>
                  ))}
                </Select>
              ) : null}
            </div>
          ) : null}
          {schedule.unit !== 'month' || schedule.every > 1 ? (
            <DatePicker
              label="One of its dates"
              description={
                schedule.unit === 'week'
                  ? 'Sets the weekday, and which weeks.'
                  : 'Sets which months it comes in.'
              }
              value={form.anchor}
              onChange={(anchor) => (anchor ? set({ anchor }) : null)}
            />
          ) : null}
        </div>

        <fieldset className="space-y-3 rounded-xl border border-border p-4">
          <legend className="px-1 text-xs font-semibold text-muted">Matches</legend>
          <p className="text-sm">
            {form.direction === 'in' ? 'Money into' : 'Money out of'} <b>{accountName}</b>
          </p>
          <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Select
              label="Named"
              value={form.named.trim() ? form.namedOp : 'any'}
              onChange={(v) =>
                v === 'any' ? set({ named: '' }) : set({ namedOp: v as Form['namedOp'] })
              }
            >
              <SelectItem id="any">Any name</SelectItem>
              <SelectItem id="equals">Exactly</SelectItem>
              <SelectItem id="contains">Containing</SelectItem>
              <SelectItem id="starts_with">Starting with</SelectItem>
            </Select>
            <TextField
              label="Name to match"
              value={form.named}
              onChange={(named) => set({ named })}
              placeholder="Any name"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
            <Select
              label="Amount"
              value={form.amountMode}
              onChange={(v) => set({ amountMode: v as AmountMode })}
            >
              <SelectItem id="any">Any amount</SelectItem>
              <SelectItem id="min">At least</SelectItem>
              <SelectItem id="max">At most</SelectItem>
              <SelectItem id="between">Between</SelectItem>
            </Select>
            {form.amountMode === 'min' || form.amountMode === 'between' ? (
              <AmountInput
                label={form.amountMode === 'between' ? 'From' : 'At least'}
                currency={currency}
                trimZeroCents
                value={form.min}
                onChange={(min) => set({ min })}
              />
            ) : null}
            {form.amountMode === 'max' || form.amountMode === 'between' ? (
              <AmountInput
                label={form.amountMode === 'between' ? 'To' : 'At most'}
                currency={currency}
                trimZeroCents
                value={form.max}
                onChange={(max) => set({ max })}
              />
            ) : null}
          </div>
          <p className="text-xs text-muted">
            Within {form.windowDays} {form.windowDays === 1 ? 'day' : 'days'} of its date. What it
            expects is only an estimate, from recent payments: it never decides what counts.
          </p>
        </fieldset>

        <div className="rounded-xl bg-surface-2 p-4 text-sm" aria-live="polite">
          <p className="font-medium">{describeSchedule(schedule)}</p>
          {p ? (
            <>
              <p className="text-muted">Next: {p.next.slice(0, 6).map(shortDate).join(' · ')}</p>
              <p className="mt-2">
                {p.paidCount === 0 ? (
                  'Nothing in its account matches yet.'
                ) : (
                  <>
                    {p.paidCount} past {p.paidCount === 1 ? 'payment matches' : 'payments match'},
                    since {shortDate(p.firstPaid!)}
                    {p.estimateMinor !== null ? (
                      <>
                        . Expects about{' '}
                        <Amount
                          minor={Math.abs(p.estimateMinor)}
                          currency={currency}
                          kind="balance"
                        />
                        .
                      </>
                    ) : null}
                  </>
                )}
              </p>
            </>
          ) : preview.isError ? (
            <p className="text-danger">Couldn’t check its payments. Try another setting.</p>
          ) : (
            <p className="text-muted">Checking its payments…</p>
          )}
        </div>

        <DialogActions>
          {series ? (
            <>
              <Button
                variant="ghost"
                className="mr-auto"
                isDisabled={remove.isPending}
                onPress={() => remove.mutate()}
              >
                Remove
              </Button>
              <Button
                variant="secondary"
                isDisabled={end.isPending}
                onPress={() => end.mutate(series.endedOn ? null : today)}
              >
                {series.endedOn ? 'It’s back' : 'It’s ended'}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onPress={onClose}>
              Cancel
            </Button>
          )}
          <Button isDisabled={!form.name.trim() || save.isPending} onPress={() => save.mutate()}>
            {series ? 'Save' : 'Make recurring'}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
