// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  estimatedMinimum,
  formatMoney,
  type Goal,
  type GoalIconName,
  type GoalsOverview,
  type HouseholdMember,
  type Payoff,
  payoff,
  type PayoffDebt,
  type PayoffStrategy,
} from '@fiscus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { BankLogo } from '../components/BankLogo.js';
import { EmptyState } from '../components/EmptyState.js';
import { PicturePicker, shrinkPhoto } from '../components/GoalPicture.js';
import { GoalRow, lookOf, percentOf } from '../components/GoalRow.js';
import { monthLabel, PayoffChart } from '../components/PayoffChart.js';
import {
  Alert,
  AmountInput,
  Button,
  Dialog,
  DialogActions,
  DatePicker,
  Radio,
  RadioGroup,
  Switch,
  TextField,
  toast,
} from '../components/ui.js';

// Paying down debt (#134; goals walkthrough §8, G9): one goal per loan or card. What's owed comes
// down by its minimum, a bill, and its plan, the extra. Together they're projected three ways:
// as planned, each its own; avalanche, highest rate first; snowball, smallest balance first. The
// two pooled ones roll a paid-off debt's payment onto the next.

const base = (householdId: string) => `/api/v1/households/${householdId}`;

const STRATEGIES: { value: Exclude<PayoffStrategy, 'minimums'>; label: string; how: string }[] = [
  { value: 'planned', label: 'Your plan', how: 'Each debt gets its minimum and its own extra.' },
  {
    value: 'avalanche',
    label: 'Avalanche',
    how: 'The extra goes to the highest rate first; each one paid off rolls its payment on.',
  },
  {
    value: 'snowball',
    label: 'Snowball',
    how: 'The extra goes to the smallest balance first; each one paid off rolls its payment on.',
  },
];

const thisMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

/** Months between two `YYYY-MM`s. */
const monthsBetween = (a: string, b: string) => {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
};

export function PayDown({
  householdId,
  data,
  goals,
  currency,
  members,
  shared,
  onEdit,
  onArchive,
  onDelete,
  onManage,
}: {
  householdId: string;
  data: GoalsOverview;
  /** Pay-down goals shown, by the whose filter, in priority order. */
  goals: Goal[];
  currency: string;
  members: HouseholdMember[];
  shared: boolean;
  onEdit: (g: Goal) => void;
  onArchive: (g: Goal) => void;
  onDelete: (g: Goal) => void;
  onManage: () => void;
}) {
  const [strategy, setStrategy] = useState<Exclude<PayoffStrategy, 'minimums'>>('planned');
  const money = (minor: number) => formatMoney(minor, currency);
  const month = thisMonth();
  // What the projection can use: debts you see, still owed.
  const owing = goals.filter((g) => g.debt?.owedMinor);
  const debts: PayoffDebt[] = owing.map((g) => ({
    id: g.id,
    owedMinor: g.debt!.owedMinor!,
    aprBps: g.debt!.aprBps,
    minimumMinor: g.debt!.minimumMinor ?? estimatedMinimum(g.debt!.owedMinor!),
    extraMinor: g.planMinor ?? 0,
  }));
  // A few debts over at most 50 years: cheap enough to work out each render.
  const results = Object.fromEntries(
    (['planned', 'avalanche', 'snowball', 'minimums'] as const).map((s) => [
      s,
      payoff(debts, s, month),
    ]),
  ) as Record<PayoffStrategy, Payoff>;
  const chosen = results[strategy];
  const owed = debts.reduce((s, d) => s + d.owedMinor, 0);
  const noApr = owing.filter((g) => g.debt!.aprBps === null).length;

  if (goals.length === 0) {
    return (
      <EmptyState icon={CreditCard} title="Pay down debt">
        {data.debts.length === 0 ? (
          <p className="text-sm text-muted">
            Add a loan or a card to pay it down. Fiscus shows when it’s paid off, and how much
            interest a little extra each month saves.
          </p>
        ) : (
          <p className="text-sm text-muted">
            Choose the loans and cards to pay down. Each becomes a goal: its balance reaching zero,
            with its minimum and what you put in over it.
          </p>
        )}
        {data.debts.length && data.canCreate ? (
          <Button onPress={onManage}>Choose debts</Button>
        ) : null}
      </EmptyState>
    );
  }

  const types = [
    { type: 'credit', title: 'Credit cards' },
    { type: 'loan', title: 'Loans' },
  ] as const;
  const sooner = (p: Payoff) =>
    p.debtFreeMonth && results.minimums.debtFreeMonth
      ? monthsBetween(p.debtFreeMonth, results.minimums.debtFreeMonth)
      : null;
  const saved = (p: Payoff) => results.minimums.interestMinor - p.interestMinor;

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: 'Owed now', value: money(owed) },
          {
            label: 'Projected interest',
            value: chosen.debtFreeMonth ? money(chosen.interestMinor) : '—',
          },
          {
            label: 'Total to pay',
            value: chosen.debtFreeMonth ? money(owed + chosen.interestMinor) : '—',
          },
          {
            label: 'Debt-free',
            value: chosen.debtFreeMonth
              ? monthLabel(chosen.debtFreeMonth)
              : 'Not at these payments',
          },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-border bg-surface px-4 py-3">
            <dt className="text-sm text-muted">{c.label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{c.value}</dd>
          </div>
        ))}
      </dl>

      {debts.length ? (
        <section
          aria-label="Payoff"
          className="grid gap-5 rounded-xl border border-border bg-surface p-4 sm:p-5 lg:grid-cols-[1fr_18rem]"
        >
          <div className="min-w-0 space-y-2">
            <h2 className="text-lg font-semibold">Payoff timeline</h2>
            <PayoffChart
              plan={chosen}
              minimums={results.minimums}
              names={owing.map((g) => g.name)}
              owedNowMinor={owed}
              thisMonth={month}
              currency={currency}
              planLabel={STRATEGIES.find((s) => s.value === strategy)!.label}
            />
          </div>
          <div className="space-y-3">
            <RadioGroup
              label="Strategy"
              value={strategy}
              onChange={(v) => setStrategy(v as typeof strategy)}
            >
              {STRATEGIES.map((s) => {
                const p = results[s.value];
                const months = sooner(p);
                return (
                  <Radio key={s.value} value={s.value}>
                    <span className="min-w-0">
                      <span className="block font-medium">{s.label}</span>
                      <span className="block text-xs text-muted">
                        {p.debtFreeMonth
                          ? `Debt-free ${monthLabel(p.debtFreeMonth)} · ${money(p.interestMinor)} interest`
                          : 'Not paid off at these payments'}
                      </span>
                      {months !== null && months > 0 ? (
                        <span className="block text-xs text-positive">
                          {months} {months === 1 ? 'month' : 'months'} sooner than minimums alone,{' '}
                          {money(saved(p))} less interest
                        </span>
                      ) : null}
                    </span>
                  </Radio>
                );
              })}
            </RadioGroup>
            <p className="text-xs text-muted">
              {STRATEGIES.find((s) => s.value === strategy)!.how} Each month pays{' '}
              {money(debts.reduce((s, d) => s + d.minimumMinor + d.extraMinor, 0))} in all: the
              minimums, and the extra planned on each goal.
              {results.minimums.debtFreeMonth
                ? ''
                : ' Minimums alone never pay it all off: the interest outruns them.'}
            </p>
          </div>
        </section>
      ) : null}

      {noApr ? (
        <Alert tone="warning">
          {noApr === 1 ? 'One debt has' : `${noApr} debts have`} no rate yet, so the projections
          leave out its interest. Set up its APR from its row.
        </Alert>
      ) : null}

      {types.map(({ type, title }) => {
        const list = goals.filter((g) => (g.debt?.type ?? 'loan') === type);
        if (!list.length) return null;
        return (
          <section
            key={type}
            aria-label={title}
            className="overflow-hidden rounded-xl border border-border bg-surface"
          >
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3 sm:px-5">
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="text-lg font-semibold tabular-nums">
                {money(list.reduce((s, g) => s + (g.debt?.owedMinor ?? 0), 0))}
              </p>
            </header>
            <ul className="divide-y divide-border">
              {list.map((g) => (
                <li key={g.id}>
                  <GoalRow
                    householdId={householdId}
                    goal={g}
                    currency={currency}
                    members={members}
                    shared={shared}
                    onOpen={g.canEdit ? () => onEdit(g) : undefined}
                    onArchive={g.canEdit ? () => onArchive(g) : undefined}
                    onDelete={g.canEdit ? () => onDelete(g) : undefined}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="px-1 text-xs text-muted">
        Projections add each month’s interest at the debt’s rate, then pay its minimum and extra.
        Minimums are taken as they are now; where the bank doesn’t say, it’s estimated at 2% of
        what’s owed. A card you still use adds its new spending to what’s owed.
      </p>
    </div>
  );
}

/** Which loans and cards are paid down (walkthrough §8): each one on is a goal; off puts it away. */
export function ManageDebts({
  householdId,
  data,
  shared,
  currency,
  onClose,
}: {
  householdId: string;
  data: GoalsOverview;
  shared: boolean;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const goalsById = new Map(data.goals.map((g) => [g.id, g]));
  const toggle = useMutation({
    mutationFn: async ({ accountId, on }: { accountId: string; on: boolean }) => {
      const d = data.debts.find((x) => x.accountId === accountId)!;
      if (on) {
        await api('POST', `${base(householdId)}/goals/pay-down`, {
          body: { accountId, scope: shared && !d.private ? 'household' : 'mine' },
        });
      } else if (d.goalId) {
        await api('PUT', `${base(householdId)}/goals/${d.goalId}/archived`, {
          body: { archived: true },
        });
      }
    },
    onSettled: () =>
      Promise.all(
        ['goals', 'budgets'].map((k) =>
          queryClient.invalidateQueries({ queryKey: ['households', householdId, k] }),
        ),
      ),
  });
  const err = toggle.error as ApiError | null;
  return (
    <Dialog title="Manage debts" isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <p className="text-sm text-muted">
          Each debt you turn on is a goal: its balance reaching zero. Turning one off archives its
          goal.
        </p>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {data.debts.map((d) => {
            const g = d.goalId ? goalsById.get(d.goalId) : undefined;
            const locked = g ? !g.canEdit : false;
            return (
              <li key={d.accountId} className="flex items-center gap-3 px-3 py-2">
                <BankLogo institution={d.institution} name={d.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{d.name}</span>
                  <span className="block text-xs text-muted">
                    {formatMoney(d.owedMinor, currency)} owed
                    {d.aprBps !== null ? ` · ${percentOf(d.aprBps)} APR` : ''}
                    {shared && d.private ? ' · private, so the goal is yours' : ''}
                  </span>
                </span>
                <Switch
                  aria-label={`Pay down ${d.name}`}
                  isSelected={d.goalId !== null}
                  isDisabled={locked || toggle.isPending || (!d.goalId && d.owedMinor <= 0)}
                  onChange={(on) => toggle.mutate({ accountId: d.accountId, on })}
                />
              </li>
            );
          })}
        </ul>
        <DialogActions>
          <Button onPress={onClose}>Done</Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

/**
 * Changing a pay-down goal (walkthrough §8): its picture and name, where it started, an optional
 * date, the extra each month, and its rate and minimum when the bank doesn't say, or says wrong.
 */
export function DebtDialog({
  householdId,
  goal,
  currency,
  onClose,
}: {
  householdId: string;
  goal: Goal;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const d = goal.debt!;
  const [name, setName] = useState(goal.name);
  const [target, setTarget] = useState<number | null>(goal.targetMinor);
  const [date, setDate] = useState<string | null>(goal.targetDate);
  const [plan, setPlan] = useState<number | null>(goal.planMinor);
  const [apr, setApr] = useState(d.entered.aprBps !== null ? String(d.entered.aprBps / 100) : '');
  const [minimum, setMinimum] = useState<number | null>(d.entered.minimumMinor);
  const [icon, setIcon] = useState<GoalIconName | null>(goal.icon);
  const [color, setColor] = useState<string | null>(goal.color);
  const [photo, setPhoto] = useState<{ previewUrl: string; dataBase64: string } | 'remove' | null>(
    null,
  );
  const shownPhoto =
    photo === 'remove' ? null : (photo?.previewUrl ?? lookOf(householdId, goal).photo);
  const plain = () => setPhoto(shownPhoto ? 'remove' : null);
  const aprBps = apr.trim() === '' ? null : Math.round(Number(apr) * 100);
  const money = (minor: number) => formatMoney(minor, currency);

  const save = useMutation({
    mutationFn: async () => {
      const patch = {
        ...(name !== goal.name ? { name } : {}),
        ...(target !== goal.targetMinor ? { targetMinor: target } : {}),
        ...(date !== goal.targetDate ? { targetDate: date } : {}),
        ...(plan !== goal.planMinor ? { planMinor: plan } : {}),
        ...(aprBps !== d.entered.aprBps ? { aprBps } : {}),
        ...(minimum !== d.entered.minimumMinor ? { minimumMinor: minimum } : {}),
        ...(icon !== goal.icon ? { icon } : {}),
        ...(color !== goal.color ? { color } : {}),
      };
      if (Object.keys(patch).length) {
        await api('PATCH', `${base(householdId)}/goals/${goal.id}`, {
          body: patch,
          headers: { 'if-match': `"v${goal.version}"` },
        });
      }
      const url = `${base(householdId)}/goals/${goal.id}/image`;
      if (photo === 'remove') await api('DELETE', url);
      else if (photo) {
        await api('PUT', url, { body: { type: 'image/jpeg', dataBase64: photo.dataBase64 } });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'goals'] });
      // Its extra is its budget line (G9, G16).
      void queryClient.invalidateQueries({ queryKey: ['households', householdId, 'budgets'] });
      toast(`${name} saved.`);
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  const aprOk = aprBps === null || (Number.isFinite(aprBps) && aprBps >= 0 && aprBps <= 10_000);
  const valid = name.trim() && target && target > 0 && aprOk;

  return (
    <Dialog title={goal.name} size="lg" isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <PicturePicker
          look={{ icon, color, photo: shownPhoto }}
          onIcon={(i) => {
            setIcon(i);
            plain();
          }}
          onColor={(c) => {
            setColor(c);
            plain();
          }}
          onPhoto={(file) =>
            void shrinkPhoto(file).then(setPhoto, () =>
              toast('That photo couldn’t be read', {
                tone: 'error',
                description: 'Choose a JPEG, PNG or WebP picture.',
              }),
            )
          }
          onRemovePhoto={() => setPhoto(goal.imageVersion ? 'remove' : null)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Name" value={name} onChange={setName} />
          <AmountInput
            label="Started at"
            description="What was owed when the goal began; progress counts down from it."
            currency={currency}
            value={target}
            onChange={setTarget}
          />
          <DatePicker label="Paid off by (optional)" value={date ?? undefined} onChange={setDate} />
          <AmountInput
            label="Extra each month"
            description="Over the minimum: the goal’s plan."
            currency={currency}
            value={plan}
            onChange={setPlan}
          />
          <TextField
            label="APR (%)"
            value={apr}
            inputMode="decimal"
            onChange={(v) => setApr(v.replace(/[^0-9.]/g, ''))}
            {...(d.bank?.aprBps != null ? { placeholder: String(d.bank.aprBps / 100) } : {})}
            description={
              d.bank?.aprBps != null
                ? `The bank says ${percentOf(d.bank.aprBps)}. Leave it empty to use that.`
                : 'The bank doesn’t say. From your statement.'
            }
            isInvalid={!aprOk}
            errorMessage="A rate from 0 to 100%"
          />
          <AmountInput
            label="Minimum payment"
            description={
              d.bank?.minimumMinor != null
                ? `The bank says ${money(d.bank.minimumMinor)}. Leave it empty to use that.`
                : `The bank doesn’t say. Without one, ${money(estimatedMinimum(d.owedMinor ?? 0))} is assumed.`
            }
            currency={currency}
            value={minimum}
            onChange={setMinimum}
          />
        </div>
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button isDisabled={!valid} isPending={save.isPending} onPress={() => save.mutate()}>
            Save
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
