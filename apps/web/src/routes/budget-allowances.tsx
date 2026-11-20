// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Allowance,
  AllowanceLine,
  BudgetMonth,
  CategoryGroup,
  HouseholdMember,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { allowancesQuery, householdQuery } from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { CategoryName } from '../components/CategoryName.js';
import {
  Alert,
  AmountInput,
  Button,
  Card,
  Dialog,
  DialogActions,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  toast,
} from '../components/ui.js';
import { thisBudgetMonth } from '../lib/budget-months.js';

// Allowances, or fun money (#114; budgeting walkthrough D15; ADR 0006 §7.4, F5): a line in the
// shared budget that funds a member's own. Everyone sees each amount, never how it was spent.

const base = (householdId: string) => `/api/v1/households/${householdId}`;
const NEW_CATEGORY = 'new';
const FUN_MONEY = 'Fun money';

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const calendarMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthAfter = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/** Viewer-relative: "you", or the member's name. */
const who = (members: HouseholdMember[], id: string) => {
  const m = members.find((x) => x.id === id);
  return m ? (m.isYou ? 'you' : m.displayName) : 'someone who left';
};
const whose = (members: HouseholdMember[], id: string) => {
  const m = members.find((x) => x.id === id);
  return m?.isYou ? 'your' : `${m?.displayName ?? 'their'}’s`;
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Whether a category's amount in this month is an allowance's: it's set there, not typed in. */
export function allowanceIn(data: BudgetMonth, categoryId: string | undefined): boolean {
  return !!categoryId && data.allowances.some((a) => a.categoryId === categoryId);
}

/** An allowance's category amount in a row: shown, not typed (D15). */
export function AllowanceAmount({ data, value }: { data: BudgetMonth; value: number }) {
  return (
    <span className="text-sm">
      <Amount minor={value} currency={data.currency} kind="balance" whole />
      <span className="block text-xs text-muted">Allowance</span>
    </span>
  );
}

/**
 * The shared budget's Allowances: one line per member, as amounts only, with Add and Change for
 * those who can change the budget. In your own budget, yours, as it arrives.
 */
export function Allowances({
  householdId,
  data,
  members,
  groups,
}: {
  householdId: string;
  data: BudgetMonth;
  members: HouseholdMember[];
  groups: CategoryGroup[];
}) {
  const list = useQuery({ ...allowancesQuery(householdId), enabled: members.length > 1 });
  const [editing, setEditing] = useState<Allowance | 'new' | null>(null);
  const shared = data.budget.scope === 'household';
  if (members.length < 2) return null;
  const categoryOf = (id: string) => groups.flatMap((g) => g.categories).find((c) => c.id === id);
  const later = (memberId: string) =>
    list.data?.find((a) => a.memberId === memberId && a.next)?.next ?? null;

  if (!shared) {
    const mine = data.allowances[0];
    if (!mine) return null;
    const c = categoryOf(mine.categoryId);
    return (
      <Card className="space-y-1">
        <h2 className="font-semibold">Your allowance</h2>
        <p className="text-sm">
          <Amount minor={mine.amountMinor} currency={data.currency} kind="balance" /> from the
          shared budget in {monthName(data.month)}. It arrives here as money in, and it’s{' '}
          {c ? <CategoryName c={c} /> : 'its category'}’s limit.
        </p>
        <p className="text-sm text-muted">
          Only you see how you spend it here. Rollover is yours to choose, from the category.
        </p>
      </Card>
    );
  }

  const lines: AllowanceLine[] = data.allowances;
  const taken = new Set(list.data?.map((a) => a.memberId) ?? lines.map((a) => a.memberId));
  const canAdd = data.canEdit && members.some((m) => !taken.has(m.id));
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Allowances</h2>
        {canAdd ? (
          <Button variant="secondary" size="sm" onPress={() => setEditing('new')}>
            Add an allowance
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted">
        Fun money for each of you, from this budget. Everyone sees the amount. How it’s spent is
        never in this budget, only in the budget of whoever it’s for.
      </p>
      {lines.length === 0 && !list.data?.some((a) => a.next) ? (
        <p className="text-sm">No allowances in {monthName(data.month)}.</p>
      ) : (
        <ul className="divide-y divide-border">
          {[
            ...lines,
            // Starting later: shown, so it isn't added twice.
            ...(list.data ?? [])
              .filter((a) => a.amountMinor === 0 && !lines.some((l) => l.memberId === a.memberId))
              .map((a) => ({ ...a, amountMinor: 0 })),
          ].map((a) => {
            const c = categoryOf(a.categoryId);
            const next = later(a.memberId);
            const full = list.data?.find((x) => x.memberId === a.memberId);
            return (
              <li key={a.memberId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {c ? <CategoryName c={c} /> : 'A deleted category'} ·{' '}
                    {capital(who(members, a.memberId))}
                  </p>
                  {next ? (
                    <p className="text-xs text-muted">
                      {next.amountMinor === 0 ? (
                        <>Stops in {monthName(next.month)}</>
                      ) : (
                        <>
                          <Amount
                            minor={next.amountMinor}
                            currency={data.currency}
                            kind="balance"
                          />{' '}
                          from {monthName(next.month)}
                        </>
                      )}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-semibold whitespace-nowrap">
                    <Amount minor={a.amountMinor} currency={data.currency} kind="balance" />
                    <span className="font-normal text-muted"> a month</span>
                  </span>
                  {data.canEdit && full ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => setEditing(full)}
                      aria-label={`Change ${whose(members, a.memberId)} allowance`}
                    >
                      Change
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing ? (
        <AllowanceDialog
          householdId={householdId}
          currency={data.currency}
          members={members}
          groups={groups}
          editing={editing === 'new' ? null : editing}
          taken={taken}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}

/**
 * Setting up or changing an allowance. It says plainly what it can't hide (F5): spending from a
 * joint account stays visible to its co-owners, wherever the money came from.
 */
function AllowanceDialog({
  householdId,
  currency,
  members,
  groups,
  editing,
  taken,
  onClose,
}: {
  householdId: string;
  currency: string;
  members: HouseholdMember[];
  groups: CategoryGroup[];
  editing: Allowance | null;
  taken: ReadonlySet<string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const spending = groups
    .filter((g) => g.kind !== 'income' && g.kind !== 'transfer')
    .flatMap((g) => g.categories)
    .filter((c) => !c.archived && c.systemKey === null);
  const funMoney = spending.find((c) => c.name.toLowerCase() === FUN_MONEY.toLowerCase());
  const open = members.filter((m) => !taken.has(m.id));
  const [memberId, setMemberId] = useState<string | null>(
    editing?.memberId ?? open.find((m) => !m.isYou)?.id ?? open[0]?.id ?? null,
  );
  const [amount, setAmount] = useState<number | null>(editing?.amountMinor || null);
  const [categoryId, setCategoryId] = useState<string>(
    editing?.categoryId ?? funMoney?.id ?? NEW_CATEGORY,
  );
  // The budget month today is in (#71), as the api counts "this month".
  const household = useQuery(householdQuery(householdId)).data;
  const now = household ? thisBudgetMonth(household) : calendarMonth();
  const [from, setFrom] = useState<'this' | 'next'>('this');
  const fromMonth = from === 'this' ? now : monthAfter(now);
  const name = memberId ? who(members, memberId) : 'them';
  const forYou = name === 'you';

  const save = useMutation({
    mutationFn: async (amountMinor: number) => {
      let category = categoryId;
      if (category === NEW_CATEGORY) {
        const group =
          groups.find((g) => g.kind === 'flexible' && g.name === 'Fun') ??
          groups.find((g) => g.kind === 'flexible');
        if (!group) throw new Error('No group to add Fun money to');
        category = (
          await api<{ data: { id: string } }>('POST', `${base(householdId)}/categories`, {
            body: { name: FUN_MONEY, groupId: group.id },
          })
        ).data.id;
      }
      return api('PUT', `${base(householdId)}/allowances/${memberId}`, {
        body: { categoryId: category, amountMinor, fromMonth },
      });
    },
    onSuccess: async (_, amountMinor) => {
      await Promise.all(
        ['allowances', 'budgets', 'categories'].map((k) =>
          queryClient.invalidateQueries({ queryKey: ['households', householdId, k] }),
        ),
      );
      toast(amountMinor === 0 ? 'Allowance stopped.' : 'Allowance saved.');
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  return (
    <Dialog
      title={
        editing ? `${capital(whose(members, editing.memberId))} allowance` : 'Add an allowance'
      }
      isOpen
      onOpenChange={(o) => (o ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title ?? err.message}</Alert> : null}
        {editing ? null : (
          <Select label="For" value={memberId} onChange={(v) => setMemberId(v ? String(v) : null)}>
            {open.map((m) => (
              <SelectItem key={m.id} id={m.id} textValue={m.isYou ? 'You' : m.displayName}>
                {m.isYou ? 'You' : m.displayName}
              </SelectItem>
            ))}
          </Select>
        )}
        <AmountInput
          label="Each month"
          currency={currency}
          value={amount}
          onChange={setAmount}
          description="The shared budget sees this amount, and nothing about how it’s spent."
        />
        <Select
          label="Category"
          value={categoryId}
          onChange={(v) => setCategoryId(v ? String(v) : NEW_CATEGORY)}
          description="Spending in it, for whoever it’s for alone, counts against the allowance in their own budget."
        >
          {[
            ...(funMoney
              ? []
              : [
                  <SelectItem key={NEW_CATEGORY} id={NEW_CATEGORY} textValue="New: Fun money">
                    New category: {FUN_MONEY}
                  </SelectItem>,
                ]),
            ...spending.map((c) => (
              <SelectItem key={c.id} id={c.id} textValue={c.name}>
                <CategoryName c={c} />
              </SelectItem>
            )),
          ]}
        </Select>
        <RadioGroup label="Starting" value={from} onChange={(v) => setFrom(v as typeof from)}>
          <Radio value="this">{monthName(now)}</Radio>
          <Radio value="next">{monthName(monthAfter(now))}</Radio>
        </RadioGroup>
        <Alert tone="info">
          <p className="font-medium">What an allowance can’t hide</p>
          <p className="mt-1">
            It keeps how the money is spent out of the shared budget. Spending from a joint account
            stays visible to everyone who owns that account, wherever the money came from. For real
            privacy, pay it into {forYou ? 'an account of your own' : `${name}’s own account`} and
            spend it from there.
          </p>
        </Alert>
        <DialogActions>
          {editing && editing.amountMinor > 0 ? (
            <Button
              variant="danger"
              isPending={save.isPending && save.variables === 0}
              onPress={() => save.mutate(0)}
            >
              Stop it
            </Button>
          ) : null}
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            isDisabled={!memberId || !amount}
            isPending={save.isPending && save.variables !== 0}
            onPress={() => save.mutate(amount ?? 0)}
          >
            Save
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
