// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ConsentRequest,
  formatMoney,
  type HouseholdMember,
  type IncomeSplit,
  type IncomeSplitConsent,
  type SplitPolicy,
  type SplitRule,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  categoriesQuery,
  consentRequestsQuery,
  householdQuery,
  incomeSplitQuery,
  membersQuery,
  splitRulesQuery,
} from '../api/queries.js';
import {
  Alert,
  AmountInput,
  Button,
  Card,
  Checkbox,
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
// split, by default and for particular categories, each from a month on. A split by income waits
// for everyone's agreement, and shows only the split, never an income (F4, #110, D19). Anyone can
// ask someone it's waiting for, who has 14 days to answer (#265, D34).

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

const nameOf = (members: HouseholdMember[], id: string) => {
  const m = members.find((x) => x.id === id);
  return m ? (m.isYou ? 'you' : m.displayName) : 'someone who left';
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Sam 57% · you 43%": shares in basis points, largest first. */
const describeShares = (
  shares: readonly { memberId: string; shareBps: number }[],
  members: HouseholdMember[],
) =>
  cap(
    [...shares]
      .sort((a, b) => b.shareBps - a.shareBps)
      .map((s) => `${nameOf(members, s.memberId)} ${Math.round(s.shareBps / 10) / 10}%`)
      .join(' · '),
  );

/**
 * Where a split by income stands, for the people in it: "Waiting for Sam", or today's split once
 * everyone has agreed.
 */
export function describeIncomeSplit(split: IncomeSplit, members: HouseholdMember[]): string {
  const waiting = split.members.filter((m) => !m.consented).map((m) => nameOf(members, m.memberId));
  if (waiting.length > 0) {
    const you = waiting.indexOf('you');
    const names = you >= 0 ? ['you', ...waiting.filter((_, i) => i !== you)] : waiting;
    const list =
      names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
    return `Waiting for ${list}`;
  }
  return describeShares(split.shares, members);
}

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

/**
 * The latest request to someone for a split by income that still says something: one that's
 * open, or one they declined or let expire. Withdrawn and answered ones say nothing more.
 */
export function latestRequest(
  requests: readonly ConsentRequest[],
  memberId: string,
): ConsentRequest | null {
  const r = requests
    .filter((x) => x.kind === 'income_split' && x.memberId === memberId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return r && ['pending', 'declined', 'expired'].includes(r.status) ? r : null;
}

/** "You asked on November 21. It ends on December 5.", "Declined on November 22." */
export function describeRequest(r: ConsentRequest, members: HouseholdMember[]): string {
  switch (r.status) {
    case 'pending':
      return `${cap(nameOf(members, r.requestedByMemberId))} asked on ${dayLabel(r.createdAt)}. It ends on ${dayLabel(r.expiresAt)}.`;
    case 'declined':
      return `Declined on ${dayLabel(r.closedAt ?? r.createdAt)}.`;
    case 'expired':
      return `Didn’t answer by ${dayLabel(r.expiresAt)}.`;
    default:
      return '';
  }
}

/**
 * "Equal", "Sam 70% · you 30%", "You $400.00 a month · the rest equally", with "· by days in the
 * household" when it prorates (#261, D33).
 */
export function describeRule(
  rule: SplitRule | null,
  members: HouseholdMember[],
  currency: string,
): string {
  if (!rule) return 'The household default';
  const split = describeSplit(rule, members, currency);
  return rule.prorate ? `${split} · by days in the household` : split;
}

function describeSplit(rule: SplitRule, members: HouseholdMember[], currency: string): string {
  const name = (id: string) => nameOf(members, id);
  if (rule.method === 'equal') return 'Equal';
  if (rule.method === 'income_proportional') return 'By income';
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
  const income = useQuery(incomeSplitQuery(householdId));
  const requests = useQuery(consentRequestsQuery(householdId)).data ?? [];
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
  // Policies in effect now or later: a split by income among them asks for everyone's income.
  const current = policies.filter(
    (p) =>
      p.effectiveFrom > earliestMonth || timeline(policies, p.categoryId, earliestMonth).now === p,
  );
  const byIncome = current.some((p) => p.rule?.method === 'income_proportional');
  const incomeStatus = (rule: SplitRule | null | undefined) =>
    rule?.method === 'income_proportional' && income.data ? (
      <p className="text-sm text-muted">{describeIncomeSplit(income.data, members)}</p>
    ) : null;

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
        {incomeStatus(def.now?.rule)}
        {scheduled(def.scheduled)}
      </Card>

      {income.data && byIncome && canEdit ? (
        <AgreementCard
          householdId={householdId}
          split={income.data}
          members={members}
          requests={requests}
        />
      ) : null}

      {income.data &&
      (byIncome || income.data.yours || askedYou(requests, household.you.memberId).length > 0) &&
      canEdit ? (
        <IncomeCard
          householdId={householdId}
          split={income.data}
          currency={currency}
          members={members}
          asked={askedYou(requests, household.you.memberId)}
        />
      ) : null}

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
                    {incomeStatus(t.now?.rule)}
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
  const [prorate, setProrate] = useState(initial?.prorate === true);

  const percentTotal = Object.values(percent).reduce((s, v) => s + (Number(v) || 0), 0);
  const rule = (): SplitRule | null => {
    const r = split();
    return r && forCategory && prorate ? { ...r, prorate } : r;
  };
  const split = (): SplitRule | null => {
    if (method === 'default') return null;
    if (method === 'equal' || method === 'income_proportional') return { method };
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
            value="income_proportional"
            title="By income"
            description="In proportion to each person’s income, once everyone it’s for agrees. Until then, the household default."
          />
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
        {method === 'income_proportional' ? (
          <Alert tone="info">
            Each person chooses the income it uses, and the others see only the split, such as 57% /
            43%. {forCategory ? 'This category' : 'A shared expense'} is split this way once
            everyone it’s for has agreed.
          </Alert>
        ) : null}
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
        {forCategory && method !== 'default' ? (
          <div>
            <Checkbox isSelected={prorate} onChange={setProrate}>
              Prorate by days for someone who joins or leaves
            </Checkbox>
            <p className="pl-7 text-sm text-muted">
              For costs that cover the month, like rent, utilities and subscriptions. Someone who
              joins on the 16th of a 30-day month pays for 15 days of it, and the others cover the
              rest.
            </p>
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

/** Open requests to you for a split by income. */
const askedYou = (requests: readonly ConsentRequest[], you: string) =>
  requests.filter((r) => r.kind === 'income_split' && r.memberId === you && r.status === 'pending');

const refreshRequests = (queryClient: ReturnType<typeof useQueryClient>, householdId: string) =>
  queryClient.invalidateQueries({ queryKey: ['households', householdId, 'consent-requests'] });

/**
 * Who a split by income is waiting for, and asking them (#265, D34): each has 14 days to answer.
 * Asking changes nothing by itself; until they agree, the household default applies.
 */
function AgreementCard({
  householdId,
  split,
  members,
  requests,
}: {
  householdId: string;
  split: IncomeSplit;
  members: HouseholdMember[];
  requests: ConsentRequest[];
}) {
  const queryClient = useQueryClient();
  const onError = (e: unknown) =>
    toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' });
  const ask = useMutation({
    mutationFn: (memberId: string) =>
      api('POST', `/api/v1/households/${householdId}/consent-requests`, {
        body: { kind: 'income_split', memberId },
      }),
    onSuccess: async (_, memberId) => {
      await refreshRequests(queryClient, householdId);
      toast(`Asked ${nameOf(members, memberId)}. They have 14 days to answer.`);
    },
    onError,
  });
  const withdraw = useMutation({
    mutationFn: (id: string) =>
      api('POST', `/api/v1/households/${householdId}/consent-requests/${id}/withdraw`),
    onSuccess: async () => {
      await refreshRequests(queryClient, householdId);
      toast('Request withdrawn.');
    },
    onError,
  });
  const you = members.find((x) => x.isYou)?.id;
  const others = split.members.filter((m) => m.memberId !== you);
  if (others.length === 0) return null;
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="font-semibold">Who has agreed</h2>
        <p className="text-sm text-muted">
          A split by income counts once everyone it’s for has agreed. Ask the people it’s waiting
          for: each has 14 days to answer.
        </p>
      </div>
      <ul className="divide-y divide-border">
        {others.map((m) => {
          const r = m.consented ? null : latestRequest(requests, m.memberId);
          const mine = r?.status === 'pending' && r.requestedByMemberId === you;
          return (
            <li key={m.memberId} className="flex flex-wrap items-center gap-3 py-3">
              <div className="mr-auto min-w-0">
                <p className="font-medium">{cap(nameOf(members, m.memberId))}</p>
                <p className="text-sm text-muted">
                  {m.consented ? 'Agreed' : r ? describeRequest(r, members) : 'Not asked yet'}
                </p>
              </div>
              {m.consented ? null : mine ? (
                <Button
                  variant="ghost"
                  isPending={withdraw.isPending && withdraw.variables === r!.id}
                  onPress={() => withdraw.mutate(r!.id)}
                >
                  Withdraw
                </Button>
              ) : r?.status === 'pending' ? null : (
                <Button
                  variant="secondary"
                  isPending={ask.isPending && ask.variables === m.memberId}
                  onPress={() => ask.mutate(m.memberId)}
                >
                  {r ? 'Ask again' : 'Ask'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * Your income for a split by income (D19): agree, choosing what it uses; change it; or withdraw.
 * Only you see what you chose. The others see that you agreed, and the split. When someone has
 * asked you (#265, D34), it says so: agree, decline, or leave it for now.
 */
function IncomeCard({
  householdId,
  split,
  currency,
  members,
  asked,
}: {
  householdId: string;
  split: IncomeSplit;
  currency: string;
  members: HouseholdMember[];
  asked: ConsentRequest[];
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notNow, setNotNow] = useState(false);
  const decline = useMutation({
    mutationFn: () =>
      Promise.all(
        asked.map((r) =>
          api('POST', `/api/v1/households/${householdId}/consent-requests/${r.id}/decline`),
        ),
      ),
    onSuccess: async () => {
      await refreshRequests(queryClient, householdId);
      toast('Declined. Nothing changes: the household default still applies.');
    },
    onError: (e) => toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' }),
  });
  const askers = [...new Set(asked.map((r) => cap(nameOf(members, r.requestedByMemberId))))];
  const ends = asked.map((r) => r.expiresAt).sort()[0];
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['households', householdId, 'income-split'] });
  const withdraw = useMutation({
    mutationFn: () => api('DELETE', `/api/v1/households/${householdId}/income-split/consent`),
    onSuccess: async () => {
      await refresh();
      toast('You’ve stopped sharing your income. From today, the household default applies.');
    },
    onError: (e) => toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' }),
  });
  const yours = split.yours;
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h2 className="font-semibold">Your income, for splits by income</h2>
          <p className="text-sm text-muted">
            {yours
              ? yours.basis === 'actual'
                ? 'You’ve agreed, using your paychecks over the last 3 months.'
                : `You’ve agreed, using ${formatMoney(yours.declaredMonthlyMinor, currency)} a month.`
              : 'A split by income needs your agreement. Until you agree, it uses the household default.'}
          </p>
        </div>
        {yours ? (
          <div className="flex gap-2">
            <Button variant="secondary" onPress={() => setOpen(true)}>
              Change
            </Button>
            <Button
              variant="ghost"
              isPending={withdraw.isPending}
              onPress={() => withdraw.mutate()}
            >
              Stop sharing
            </Button>
          </div>
        ) : (
          <Button onPress={() => setOpen(true)}>Review and agree</Button>
        )}
      </div>
      {asked.length > 0 && !yours && !notNow ? (
        <Alert tone="info">
          <div className="space-y-2">
            <p>
              <b>{askers.join(' and ')}</b> asked you to agree to a split by income. The request
              ends on {dayLabel(ends!)}. Until you agree, nothing changes.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onPress={() => setNotNow(true)}>
                Not now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                isPending={decline.isPending}
                onPress={() => decline.mutate()}
              >
                Decline
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}
      <p className="text-xs text-muted">Only you see the income you choose.</p>
      {open ? (
        <ConsentDialog
          householdId={householdId}
          initial={yours}
          currency={currency}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Card>
  );
}

function ConsentDialog({
  householdId,
  initial,
  currency,
  onClose,
}: {
  householdId: string;
  initial: IncomeSplitConsent | null;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [basis, setBasis] = useState<IncomeSplitConsent['basis']>(initial?.basis ?? 'actual');
  const [figure, setFigure] = useState<number | null>(
    initial?.basis === 'declared' ? initial.declaredMonthlyMinor : null,
  );
  const save = useMutation({
    mutationFn: () =>
      api('PUT', `/api/v1/households/${householdId}/income-split/consent`, {
        body:
          basis === 'declared' ? { basis, declaredMonthlyMinor: figure ?? 0 } : { basis: 'actual' },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['households', householdId, 'income-split'],
      });
      await queryClient.invalidateQueries({
        queryKey: ['households', householdId, 'shared-costs'],
      });
      // Agreeing answers any request to you.
      await refreshRequests(queryClient, householdId);
      toast(initial ? 'Your income for splits is changed, from today.' : 'Agreed, from today.');
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  return (
    <Dialog
      title={initial ? 'Change the income your split uses' : 'Split by income'}
      isOpen
      onOpenChange={(o) => (o ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <p className="text-sm">
          Shared costs split by income are paid in proportion to each person’s income. To work out
          your share, Fiscus needs yours.
        </p>
        <RadioGroup
          label="The income to use"
          value={basis}
          onChange={(v) => setBasis(v as IncomeSplitConsent['basis'])}
        >
          <RadioCard
            value="actual"
            title="Use what comes in"
            description="Your paychecks over the last 3 months, a month on average."
          />
          <RadioCard
            value="declared"
            title="Enter a figure"
            description="A monthly amount you choose."
          />
        </RadioGroup>
        {basis === 'declared' ? (
          <AmountInput
            label="Your income, a month"
            currency={currency}
            value={figure}
            onChange={setFigure}
          />
        ) : null}
        <Alert tone="info">
          <b>The others see the split, not your income.</b> But a split like 57% / 43% says roughly
          how your incomes compare, and anyone who knows their own income can work out yours from
          it.
        </Alert>
        <p className="text-sm text-muted">
          You can stop sharing your income any time. From that day, the household default applies
          again.
        </p>
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Not now
          </Button>
          <Button
            isDisabled={basis === 'declared' && figure === null}
            isPending={save.isPending}
            onPress={() => save.mutate()}
          >
            {initial ? 'Save' : 'Agree'}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
