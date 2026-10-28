// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  HouseholdMember,
  SettlementCandidate,
  SharedCosts,
  SharedExpenseLine,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Scale } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { categoriesQuery, householdQuery, membersQuery } from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import {
  Alert,
  AmountInput,
  Avatar,
  Button,
  Card,
  Dialog,
  DialogActions,
  LoadingRegion,
  RadioCard,
  RadioGroup,
  Skeleton,
  TextField,
  toast,
} from '../components/ui.js';
import { addMonths } from './budget.js';

// Shared costs (#115, budgeting walkthrough §8–§10): where you stand with each person, what
// changed it this month, and settling up.

const base = (householdId: string) => `/api/v1/households/${householdId}`;

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

const sharedCostsQuery = (householdId: string, month: string) => ({
  queryKey: ['households', householdId, 'shared-costs', month],
  queryFn: async () =>
    (await api<{ data: SharedCosts }>('GET', `${base(householdId)}/shared-costs?month=${month}`))
      .data,
});

/** "Sam owes you $142.10", "You owe Sam …", or "You and Sam are square", from your side. */
export function balanceSentence(name: string, amountMinor: number, money: string): string {
  if (amountMinor > 0) return `${name} owes you ${money}`;
  if (amountMinor < 0) return `You owe ${name} ${money}`;
  return `You and ${name} are square`;
}

export function SharedCostsPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const search = useSearch({ strict: false }) as { month?: string };
  const navigate = useNavigate();
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const month = /^\d{4}-\d{2}$/.test(search.month ?? '') ? search.month! : thisMonth();
  const data = useQuery(sharedCostsQuery(householdId, month));
  const categoryName = useCategoryNames(householdId);
  const [settling, setSettling] = useState<{ member: HouseholdMember; balance: number } | null>(
    null,
  );
  const go = (m: string) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, month: m }),
      replace: true,
    });
  const canEdit = household.you.role !== 'viewer';
  const others = members.filter((m) => !m.isYou && m.role !== 'viewer');
  const name = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.isYou ? 'you' : m.displayName) : 'someone who left';
  };

  return (
    <>
      <PageHeader
        title="Shared costs"
        showLens={false}
        members={members}
        action={
          <Link
            to={`/h/${householdId}/settings/shared-costs`}
            className="text-sm font-medium text-accent-text underline"
          >
            Split rules
          </Link>
        }
      />
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 md:px-8">
        <div className="flex items-center gap-1" role="group" aria-label="Month">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous month"
            onPress={() => go(addMonths(month, -1))}
          >
            <ChevronLeft aria-hidden className="size-4" />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium" aria-live="polite">
            {monthName(month)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next month"
            isDisabled={month >= thisMonth()}
            onPress={() => go(addMonths(month, 1))}
          >
            <ChevronRight aria-hidden className="size-4" />
          </Button>
          {month !== thisMonth() ? (
            <Button variant="ghost" size="sm" onPress={() => go(thisMonth())}>
              This month
            </Button>
          ) : null}
        </div>

        {data.isPending ? (
          <LoadingRegion label="Loading shared costs">
            <div className="space-y-3">
              <Skeleton className="h-28" />
              <Skeleton className="h-64" />
            </div>
          </LoadingRegion>
        ) : data.isError ? (
          <Alert>Couldn’t load shared costs. Try again in a moment.</Alert>
        ) : (
          <Body
            data={data.data}
            others={others}
            name={name}
            groups={categoryName}
            onSettle={canEdit ? setSettling : undefined}
          />
        )}
      </div>
      {settling && data.data ? (
        <SettleDialog
          householdId={householdId}
          member={settling.member}
          balance={settling.balance}
          currency={data.data.currency}
          onClose={() => setSettling(null)}
        />
      ) : null}
    </>
  );
}

function useCategoryNames(householdId: string) {
  const groups = useQuery(categoriesQuery(householdId)).data ?? [];
  return (id: string | null) =>
    groups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? 'Uncategorized';
}

function Body({
  data,
  others,
  name,
  groups: categoryName,
  onSettle,
}: {
  data: SharedCosts;
  others: HouseholdMember[];
  name: (id: string) => string;
  groups: (id: string | null) => string;
  onSettle: ((s: { member: HouseholdMember; balance: number }) => void) | undefined;
}) {
  const { currency, month } = data;
  const money = (minor: number) => (
    <Amount minor={Math.abs(minor)} currency={currency} kind="balance" />
  );
  const balanceWith = (id: string) =>
    data.balances.find((b) => b.memberId === id)?.amountMinor ?? 0;
  const carriedWith = (id: string) => data.carried.find((b) => b.memberId === id)?.amountMinor ?? 0;
  const changed = data.expenses.filter((e) => e.effect.length > 0);
  const evens = data.expenses.filter((e) => e.effect.length === 0);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {others.map((m) => {
          const balance = balanceWith(m.id);
          const carried = carriedWith(m.id);
          return (
            <Card
              key={m.id}
              className={clsx('space-y-2', balance !== 0 && 'border-l-4 border-l-accent')}
            >
              <div className="flex items-center gap-2 text-sm text-muted">
                <Avatar name={m.displayName} color={m.color} size="sm" />
                Your balance with {m.displayName}
              </div>
              <p className="text-2xl font-semibold">
                {balance > 0 ? (
                  <>
                    {m.displayName} owes you {money(balance)}
                  </>
                ) : balance < 0 ? (
                  <>
                    You owe {m.displayName} {money(balance)}
                  </>
                ) : (
                  <>You and {m.displayName} are square</>
                )}
              </p>
              {balance !== 0 ? (
                <p className="text-xs text-muted">
                  {money(carried)} from before {monthName(month)}, {money(balance - carried)}{' '}
                  {balance - carried >= 0 === balance >= 0 ? '' : 'back '}
                  from {monthName(month)}
                </p>
              ) : null}
              {onSettle && balance !== 0 ? (
                <Button onPress={() => onSettle({ member: m, balance })}>Settle up</Button>
              ) : null}
            </Card>
          );
        })}
      </div>

      <Card className="space-y-1 text-sm">
        <h2 className="font-semibold">{monthName(month)}</h2>
        <p className="flex justify-between">
          <span className="text-muted">Shared spending you can see</span>
          {money(data.sharedSpendingMinor)}
        </p>
        <p className="flex justify-between">
          <span className="text-muted">From joint accounts you own equally · evens out</span>
          {money(data.evensOutMinor)}
        </p>
      </Card>

      {changed.length === 0 && data.settlements.length === 0 ? (
        <EmptyState icon={Scale} title={`Nothing changed the balance in ${monthName(month)}`}>
          <p>
            Shared expenses paid on someone’s own card, or split differently from how you own a
            joint account, show here.
          </p>
        </EmptyState>
      ) : (
        <section className="overflow-hidden rounded-xl border border-border bg-surface">
          <h2 className="border-b border-border px-4 py-2 text-sm font-semibold">
            What changed the balance in {monthName(month)}
          </h2>
          <ul className="divide-y divide-border">
            {data.settlements.map((s) => {
              const youReceived = !others.some((o) => o.id === s.toMemberId);
              const otherId = youReceived ? s.fromMemberId : s.toMemberId;
              return (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <span className="w-14 shrink-0 text-xs text-muted">{shortDate(s.date)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      {s.kind === 'adjustment'
                        ? 'Adjustment'
                        : youReceived
                          ? `${name(otherId)} paid you`
                          : `You paid ${name(otherId)}`}
                    </span>
                    <span className="text-xs text-muted">
                      {s.kind === 'transfer'
                        ? 'Settle-up, by transfer'
                        : s.kind === 'paid'
                          ? 'Settle-up, paid another way'
                          : (s.note ?? '')}
                    </span>
                  </span>
                  {money(s.amountMinor)}
                </li>
              );
            })}
            {changed.map((e) => (
              <ExpenseRow
                key={e.transactionId}
                e={e}
                name={name}
                category={categoryName}
                money={money}
                currency={currency}
              />
            ))}
            {evens.length ? (
              <li className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className="w-14 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block">Everything else</span>
                  <span className="text-xs text-muted">
                    {evens.length} {evens.length === 1 ? 'expense' : 'expenses'} from joint
                    accounts, which even out
                  </span>
                </span>
                {money(evens.reduce((s, e) => s + e.costMinor, 0))}
              </li>
            ) : null}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted">
        Shared expenses are the ones for more than one of you. Spending from a joint account evens
        out when your split matches how you own it.
      </p>
    </>
  );
}

function ExpenseRow({
  e,
  name,
  category,
  money,
  currency,
}: {
  e: SharedExpenseLine;
  name: (id: string) => string;
  category: (id: string | null) => string;
  money: (minor: number) => React.ReactNode;
  currency: string;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <span className="w-14 shrink-0 text-xs text-muted">{shortDate(e.date)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{e.displayName}</span>
        <span className="text-xs text-muted">
          {category(e.categoryId)} · paid by {e.paidBy.map(name).join(' and ')}
        </span>
      </span>
      <span className="text-right">
        <span className="block">{money(e.costMinor)}</span>
        {e.effect.map((x) => (
          <span key={x.memberId} className="block text-xs text-muted">
            {x.amountMinor > 0 ? `${name(x.memberId)} owes ` : `you owe `}
            <Amount minor={Math.abs(x.amountMinor)} currency={currency} kind="balance" />
          </span>
        ))}
      </span>
    </li>
  );
}

/** Settling up (§10, D20): a transfer already in Fiscus, paid another way, or an adjustment. */
function SettleDialog({
  householdId,
  member,
  balance,
  currency,
  onClose,
}: {
  householdId: string;
  member: HouseholdMember;
  balance: number;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const theyPay = balance > 0;
  const [how, setHow] = useState<'transfer' | 'paid' | 'adjustment'>('transfer');
  const [pick, setPick] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(Math.abs(balance));
  const [note, setNote] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const candidates = useQuery({
    queryKey: ['households', householdId, 'settlement-candidates', member.id, balance],
    queryFn: async () =>
      (
        await api<{ data: SettlementCandidate[] }>(
          'GET',
          `${base(householdId)}/shared-costs/settlement-candidates?memberId=${member.id}&balanceMinor=${balance}`,
        )
      ).data,
  });
  const list = candidates.data ?? [];
  const chosen =
    list.find((c) => c.transactionId === pick) ?? (pick === null ? list[0] : undefined);
  const save = useMutation({
    mutationFn: () =>
      api('POST', `${base(householdId)}/shared-costs/settlements`, {
        body: {
          memberId: member.id,
          direction: theyPay ? 'they_paid' : 'you_paid',
          kind: how,
          ...(how === 'transfer' && chosen
            ? {
                transactionId: chosen.transactionId,
                amountMinor: Math.abs(chosen.amountMinor),
                date: chosen.date,
              }
            : { amountMinor: amount ?? 0, date: today }),
          ...(how === 'adjustment' ? { note } : {}),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId] });
      toast('Settle-up recorded.');
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  const valid =
    how === 'transfer' ? !!chosen : !!amount && (how !== 'adjustment' || note.trim().length > 0);
  const owed = <Amount minor={Math.abs(balance)} currency={currency} kind="balance" />;
  return (
    <Dialog
      title={`Settle up with ${member.displayName}`}
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <p className="text-sm text-muted">
          {theyPay ? (
            <>
              {member.displayName} owes you {owed}.
            </>
          ) : (
            <>
              You owe {member.displayName} {owed}.
            </>
          )}
        </p>
        <RadioGroup label="How" value={how} onChange={(v) => setHow(v as typeof how)}>
          <RadioCard
            value="transfer"
            title={theyPay ? `${member.displayName} already sent it` : 'You already sent it'}
            description="A transfer that’s in Fiscus."
          />
          <RadioCard
            value="paid"
            title={theyPay ? `${member.displayName} paid another way` : 'You paid another way'}
            description="Cash, a payment app, an account Fiscus doesn’t have."
          />
          <RadioCard
            value="adjustment"
            title="Add an adjustment"
            description="Anything else, with a note."
          />
        </RadioGroup>
        {how === 'transfer' ? (
          candidates.isPending ? (
            <Skeleton className="h-24" />
          ) : list.length ? (
            <RadioGroup
              label="Which transfer"
              value={chosen?.transactionId ?? ''}
              onChange={setPick}
            >
              {list.map((c) => (
                <RadioCard
                  key={c.transactionId}
                  value={c.transactionId}
                  title={`${shortDate(c.date)} · ${c.displayName}`}
                  description={`${c.accountName}${Math.abs(c.amountMinor) === Math.abs(balance) ? ' · same amount' : ''}`}
                />
              ))}
            </RadioGroup>
          ) : (
            <p className="text-sm text-muted">
              No transfer {theyPay ? 'into' : 'out of'} your accounts in the last 60 days. Choose
              “paid another way” if it went outside Fiscus.
            </p>
          )
        ) : (
          <>
            <AmountInput label="Amount" currency={currency} value={amount} onChange={setAmount} />
            {how === 'adjustment' ? (
              <TextField label="What it’s for" value={note} onChange={setNote} maxLength={500} />
            ) : null}
          </>
        )}
        <p className="text-xs text-muted">
          {how === 'transfer'
            ? 'The transfer is marked as a settle-up, so it isn’t income or spending. Both of you see it.'
            : `Only you and ${member.displayName} see it.`}
        </p>
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button isDisabled={!valid} isPending={save.isPending} onPress={() => save.mutate()}>
            Record
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
