// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  formatMoney,
  type HouseholdMember,
  type SplitPolicy,
  type SplitRule,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { categoriesQuery, householdQuery, membersQuery, splitRulesQuery } from '../api/queries.js';
import {
  Alert,
  AmountInput,
  Button,
  Card,
  Dialog,
  DialogActions,
  LoadingRegion,
  RadioCard,
  RadioGroup,
  Select,
  SelectItem,
  SelectSection,
  Skeleton,
  TextField,
  toast,
} from '../components/ui.js';

// Household settings → Shared costs (#109, budgeting walkthrough §9): how a shared expense is
// split, by default and for particular categories, each from a month on.

type Method = SplitRule['method'];

const monthLabel = (month: string) =>
  new Date(`${month}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const nextMonthOf = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};

/** "Equal", "Sam 70% · you 30%", "You $400.00 a month · the rest equally". */
export function describeRule(
  rule: SplitRule | null,
  members: HouseholdMember[],
  currency: string,
): string {
  if (!rule) return 'The household default';
  const name = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.isYou ? 'you' : m.displayName) : 'someone who left';
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (rule.method === 'equal') return 'Equal';
  if (rule.method === 'fixed_percent') {
    return cap(
      [...rule.shares]
        .sort((a, b) => b.shareBps - a.shareBps)
        .map((s) => `${name(s.memberId)} ${s.shareBps / 100}%`)
        .join(' · '),
    );
  }
  return cap(
    `${rule.amounts
      .map((a) => `${name(a.memberId)} ${formatMoney(a.amountMinor, currency)} a month`)
      .join(' · ')} · the rest equally`,
  );
}

/** What applies in `month`, and the change scheduled after it, for one scope. */
function timeline(policies: SplitPolicy[], categoryId: string | null, month: string) {
  const rows = policies.filter((p) => p.categoryId === categoryId);
  const now = rows.filter((p) => p.effectiveFrom <= month).at(-1);
  const scheduled = rows.filter((p) => p.effectiveFrom > month);
  return { now, scheduled };
}

export function SharedCostsSettings() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const groups = useQuery(categoriesQuery(householdId)).data ?? [];
  const rules = useQuery(splitRulesQuery(householdId));
  const queryClient = useQueryClient();
  const canEdit = household.you.role !== 'viewer';
  const [editing, setEditing] = useState<{ categoryId: string | null; isNew: boolean } | null>(
    null,
  );
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api('DELETE', `/api/v1/households/${householdId}/split-rules/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'split-rules'] });
      toast('Change cancelled.');
    },
    onError: (e) => toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' }),
  });

  if (rules.isPending) {
    return (
      <LoadingRegion label="Loading split rules">
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </LoadingRegion>
    );
  }
  if (rules.isError) return <Alert>Couldn’t load the split rules. Try again in a moment.</Alert>;

  const { earliestMonth, policies } = rules.data;
  const currency = household.baseCurrency;
  const categoryName = (id: string) =>
    groups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? 'A deleted category';
  const def = timeline(policies, null, earliestMonth);
  const withRules = [...new Set(policies.flatMap((p) => (p.categoryId ? [p.categoryId] : [])))];

  const scheduled = (rows: SplitPolicy[]) =>
    rows.map((p) => (
      <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">From {monthLabel(p.effectiveFrom)}:</span>
        <span>{describeRule(p.rule, members, currency)}</span>
        {canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            isPending={cancel.isPending && cancel.variables === p.id}
            onPress={() => cancel.mutate(p.id)}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    ));

  return (
    <>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto">
            <h2 className="font-semibold">Household default</h2>
            <p className="text-sm text-muted">
              How a shared expense is split, unless its category has a rule of its own.
            </p>
          </div>
          {canEdit ? (
            <Button
              variant="secondary"
              onPress={() => setEditing({ categoryId: null, isNew: false })}
            >
              Change
            </Button>
          ) : null}
        </div>
        <p className="text-lg font-medium">
          {describeRule(def.now?.rule ?? { method: 'equal' }, members, currency)}
        </p>
        {scheduled(def.scheduled)}
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto">
            <h2 className="font-semibold">Rules for categories</h2>
            <p className="text-sm text-muted">
              Rent by fixed shares, groceries equally, and so on.
            </p>
          </div>
          {canEdit ? (
            <Button
              variant="secondary"
              onPress={() => setEditing({ categoryId: null, isNew: true })}
            >
              <Plus aria-hidden className="size-4" />
              Add a rule
            </Button>
          ) : null}
        </div>
        {withRules.length === 0 ? (
          <p className="text-sm text-muted">
            None yet: every category follows the household default.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {withRules.map((id) => {
              const t = timeline(policies, id, earliestMonth);
              return (
                <li key={id} className="flex flex-wrap items-start gap-3 py-3">
                  <div className="mr-auto min-w-0 space-y-1">
                    <p className="font-medium">{categoryName(id)}</p>
                    <p className="text-sm">
                      {t.now
                        ? describeRule(t.now.rule, members, currency)
                        : 'The household default'}
                    </p>
                    {scheduled(t.scheduled)}
                  </div>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => setEditing({ categoryId: id, isNew: false })}
                    >
                      Change
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className="text-xs text-muted">
        A change starts from this month or a later one: months that have started keep the rule they
        had. Everyone in the household sees each change in its activity.
      </p>

      {editing ? (
        <RuleDialog
          householdId={householdId}
          categoryId={editing.categoryId}
          isNew={editing.isNew}
          initial={
            editing.isNew
              ? null
              : (timeline(policies, editing.categoryId, earliestMonth).now?.rule ?? null)
          }
          earliestMonth={earliestMonth}
          members={members}
          currency={currency}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function RuleDialog({
  householdId,
  categoryId: fixedCategory,
  isNew,
  initial,
  earliestMonth,
  members,
  currency,
  groups,
  onClose,
}: {
  householdId: string;
  categoryId: string | null;
  isNew: boolean;
  initial: SplitRule | null;
  earliestMonth: string;
  members: HouseholdMember[];
  currency: string;
  groups: { id: string; name: string; categories: { id: string; name: string }[] }[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const people = members.filter((m) => m.role !== 'viewer');
  const forCategory = isNew || fixedCategory !== null;
  const [categoryId, setCategoryId] = useState<string | null>(fixedCategory);
  const [method, setMethod] = useState<Method | 'default'>(
    initial?.method ?? (forCategory && !isNew ? 'default' : 'equal'),
  );
  const [percent, setPercent] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      people.map((m) => [
        m.id,
        initial?.method === 'fixed_percent'
          ? String((initial.shares.find((s) => s.memberId === m.id)?.shareBps ?? 0) / 100)
          : String(Math.round(10000 / people.length) / 100),
      ]),
    ),
  );
  const [amounts, setAmounts] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(
      people.map((m) => [
        m.id,
        initial?.method === 'fixed_amount'
          ? (initial.amounts.find((a) => a.memberId === m.id)?.amountMinor ?? null)
          : null,
      ]),
    ),
  );
  const [from, setFrom] = useState(earliestMonth);

  const percentTotal = Object.values(percent).reduce((s, v) => s + (Number(v) || 0), 0);
  const rule = (): SplitRule | null => {
    if (method === 'default') return null;
    if (method === 'equal') return { method };
    if (method === 'fixed_percent') {
      return {
        method,
        shares: people
          .map((m) => ({
            memberId: m.id,
            shareBps: Math.round((Number(percent[m.id]) || 0) * 100),
          }))
          .filter((s) => s.shareBps > 0),
      };
    }
    return {
      method,
      amounts: people.flatMap((m) =>
        amounts[m.id] ? [{ memberId: m.id, amountMinor: amounts[m.id]! }] : [],
      ),
    };
  };
  const valid =
    (!forCategory || categoryId !== null) &&
    (method !== 'fixed_percent' || Math.abs(percentTotal - 100) < 0.001) &&
    (method !== 'fixed_amount' ||
      (people.some((m) => amounts[m.id]) && people.some((m) => !amounts[m.id])));

  const save = useMutation({
    mutationFn: () =>
      api(
        'PUT',
        `/api/v1/households/${householdId}/split-rules/${categoryId ? `categories/${categoryId}` : 'default'}`,
        { body: { rule: rule(), effectiveFrom: from } },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'split-rules'] });
      toast(`Split rule saved, from ${monthLabel(from)}.`);
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  const next = nextMonthOf(earliestMonth);

  return (
    <Dialog
      title={
        forCategory
          ? isNew
            ? 'Add a rule for a category'
            : 'Change this category’s rule'
          : 'Change the household default'
      }
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        {isNew ? (
          <Select
            label="Category"
            placeholder="Choose a category"
            value={categoryId}
            onChange={(v) => setCategoryId(v ? String(v) : null)}
          >
            {groups.map((g) => (
              <SelectSection key={g.id} title={g.name}>
                {g.categories.map((c) => (
                  <SelectItem key={c.id} id={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectSection>
            ))}
          </Select>
        ) : null}
        <RadioGroup
          label="Split"
          value={method}
          onChange={(v) => setMethod(v as Method | 'default')}
        >
          {forCategory && !isNew ? (
            <RadioCard
              value="default"
              title="The household default"
              description="Stop using a rule of its own."
            />
          ) : null}
          <RadioCard value="equal" title="Equally" description="The same share each." />
          <RadioCard
            value="fixed_percent"
            title="Fixed percentages"
            description="Each person’s share, adding up to 100%."
          />
          {forCategory ? (
            <RadioCard
              value="fixed_amount"
              title="Fixed amounts"
              description="Some pay a set amount a month; the rest is split equally."
            />
          ) : null}
        </RadioGroup>
        {method === 'fixed_percent' ? (
          <div className="space-y-2">
            {people.map((m) => (
              <TextField
                key={m.id}
                label={`${m.displayName}${m.isYou ? ' (you)' : ''}, %`}
                inputMode="decimal"
                value={percent[m.id] ?? ''}
                onChange={(v) => setPercent({ ...percent, [m.id]: v })}
              />
            ))}
            <p
              className={`text-sm ${Math.abs(percentTotal - 100) < 0.001 ? 'text-muted' : 'text-danger'}`}
            >
              {Math.round(percentTotal * 100) / 100}% of 100%
            </p>
          </div>
        ) : null}
        {method === 'fixed_amount' ? (
          <div className="space-y-2">
            {people.map((m) => (
              <AmountInput
                key={m.id}
                label={`${m.displayName}${m.isYou ? ' (you)' : ''}, a month`}
                currency={currency}
                value={amounts[m.id] ?? null}
                onChange={(v) => setAmounts({ ...amounts, [m.id]: v })}
                placeholder="The rest, equally"
              />
            ))}
            <p className="text-sm text-muted">Leave someone empty to share what’s left equally.</p>
          </div>
        ) : null}
        <RadioGroup label="Starting" value={from} onChange={setFrom}>
          <RadioCard
            value={earliestMonth}
            title={monthLabel(earliestMonth)}
            description="This month, including what’s already been spent in it."
          />
          <RadioCard
            value={next}
            title={monthLabel(next)}
            description="Next month. This month keeps the rule it has."
          />
        </RadioGroup>
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
