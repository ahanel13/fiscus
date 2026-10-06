// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  AccountType,
  AccountVisibility,
  Household,
  HouseholdMember,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Landmark, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  accountQuery,
  accountsQuery,
  balancesQuery,
  householdQuery,
  membersQuery,
  netWorthQuery,
} from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { Sparkline } from '../components/Sparkline.js';
import {
  Alert,
  AmountInput,
  Avatar,
  Badge,
  Button,
  Card,
  Cell,
  Checkbox,
  Column,
  ConfirmDialog,
  DatePicker,
  DateText,
  Dialog,
  DialogActions,
  DialogTrigger,
  Form,
  LoadingRegion,
  RadioCard,
  RadioGroup,
  Row,
  Select,
  SelectItem,
  Skeleton,
  Switch,
  Tab,
  Table,
  TableBody,
  TableHeader,
  TabList,
  TabPanel,
  Tabs,
  TextField,
  toast,
  useToday,
} from '../components/ui.js';
import {
  balanceKind,
  DEFAULT_VISIBILITY,
  GROUPS,
  isLiability,
  ownerLabel,
  privateAllowed,
  trend,
  TYPE_LABELS,
  VISIBILITY,
} from '../lib/accounts.js';
import { lensVisible, parseLens } from '../lib/lens.js';

type Data<T> = { data: T };
const base = (householdId: string) => `/api/v1/households/${householdId}`;

function useHouseholdData() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  return { householdId, household, members };
}

function useInvalidateAccounts(householdId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['households', householdId, 'accounts'] }),
      queryClient.invalidateQueries({ queryKey: ['households', householdId, 'net-worth'] }),
    ]);
}

// ── Accounts list ──────────────────────────────────────────────────────────────────────────────

export function AccountsPage() {
  const { householdId, household, members } = useHouseholdData();
  const search = useSearch({ strict: false }) as { lens?: string };
  const showLens = lensVisible(household, members.length);
  const lens = showLens ? parseLens(search.lens) : 'all';
  const accounts = useQuery(accountsQuery(householdId, lens));
  const netWorth = useQuery(netWorthQuery(householdId, lens));
  const [adding, setAdding] = useState(false);
  const canAdd = household.you.role !== 'viewer';
  const add = canAdd ? (
    <Button onPress={() => setAdding(true)}>
      <Plus aria-hidden className="size-4" /> Add account
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Accounts"
        showRange={false}
        showLens={showLens}
        members={members}
        action={add}
      />
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
        {accounts.isPending ? (
          <LoadingRegion label="Loading accounts">
            <div className="space-y-3">
              <Skeleton className="h-28" />
              <Skeleton className="h-40" />
            </div>
          </LoadingRegion>
        ) : accounts.isError ? (
          <Alert>Couldn’t load accounts. Try again in a moment.</Alert>
        ) : accounts.data.length === 0 ? (
          <EmptyState icon={Landmark} title="No accounts yet">
            <p>
              Add the accounts you want to track: checking, savings, credit cards, loans, and things
              you own, like a home or a car. Bank connections arrive later; for now you enter
              balances yourself.
            </p>
            {add}
          </EmptyState>
        ) : (
          <>
            {netWorth.data ? <NetWorthCard data={netWorth.data} /> : <Skeleton className="h-28" />}
            {GROUPS.map((g) => {
              const items = accounts.data.filter((a) => g.types.includes(a.type));
              return items.length ? (
                <AccountGroup
                  key={g.id}
                  label={g.label}
                  accounts={items}
                  members={members}
                  householdId={householdId}
                  currency={household.baseCurrency}
                />
              ) : null;
            })}
          </>
        )}
      </div>
      {canAdd ? (
        <AddAccountDialog
          isOpen={adding}
          onOpenChange={setAdding}
          household={household}
          members={members}
        />
      ) : null}
    </>
  );
}

function NetWorthCard({ data }: { data: import('@fiscus/shared').NetWorth }) {
  return (
    <Card className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
      <div>
        <h2 className="text-sm font-medium text-muted">
          Net worth <span className="font-normal">(visible to you)</span>
        </h2>
        <Amount
          minor={data.netWorthMinor}
          currency={data.currency}
          kind="balance"
          className="text-3xl font-semibold tracking-tight"
        />
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted">Assets</dt>
            <dd>
              <Amount minor={data.assetsMinor} currency={data.currency} kind="balance" />
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">Liabilities</dt>
            <dd>
              <Amount minor={data.liabilitiesMinor} currency={data.currency} kind="balance" />
            </dd>
          </div>
        </dl>
        {data.unconverted.length ? (
          <p className="mt-2 text-xs text-muted">
            Not included yet:{' '}
            {data.unconverted
              .map(
                (u) =>
                  `${u.accounts} ${u.accounts === 1 ? 'account' : 'accounts'} in ${u.currency}`,
              )
              .join(', ')}
            .
          </p>
        ) : null}
      </div>
      <div className="md:w-64">
        <Sparkline values={trend(data.series.map((p) => p.netWorthMinor))} />
        {trend(data.series.map((p) => p.netWorthMinor)).length > 1 ? (
          <p className="text-right text-xs text-muted">Last 12 months</p>
        ) : null}
      </div>
    </Card>
  );
}

function AccountGroup({
  label,
  accounts,
  members,
  householdId,
  currency,
}: {
  label: string;
  accounts: Account[];
  members: HouseholdMember[];
  householdId: string;
  currency: string;
}) {
  const sameCurrency = accounts.every((a) => a.currency === currency);
  const total = accounts.reduce((sum, a) => sum + (a.balance?.amountMinor ?? 0), 0);
  return (
    <section aria-labelledby={`group-${label}`}>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 id={`group-${label}`} className="font-semibold">
          {label}
        </h2>
        {sameCurrency ? (
          <Amount
            minor={total}
            currency={currency}
            kind={balanceKind(accounts[0]!.type)}
            className="text-sm text-muted"
          />
        ) : null}
      </div>
      <Card className="p-0">
        <ul className="divide-y divide-border">
          {accounts.map((a) => (
            <li key={a.id}>
              <Link
                to={`/h/${householdId}/accounts/${a.id}`}
                className="flex items-center gap-3 hover:bg-surface-2"
                style={{ minHeight: 'var(--row-h)', paddingInline: 'var(--cell-px)' }}
              >
                <span className="min-w-0 flex-1 py-2">
                  <span className="block truncate text-sm font-medium">{a.name}</span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    {members.length > 1 ? <span>{ownerLabel(a, members)}</span> : null}
                    {a.mask ? <span>•••• {a.mask}</span> : null}
                    {a.yourAccess === 'owner' && a.visibility !== 'full' ? (
                      <Badge>{VISIBILITY[a.visibility].label}</Badge>
                    ) : null}
                    {a.closedAt ? <Badge>Closed</Badge> : null}
                  </span>
                </span>
                <span className="text-right">
                  {a.balance ? (
                    <Amount
                      minor={a.balance.amountMinor}
                      currency={a.currency}
                      kind={balanceKind(a.type)}
                      className="block text-sm font-medium"
                    />
                  ) : (
                    <span className="block text-sm text-muted">No balance</span>
                  )}
                </span>
                <ChevronRight aria-hidden className="size-4 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

// ── Add account ────────────────────────────────────────────────────────────────────────────────

function OwnersPicker({
  members,
  selected,
  onChange,
  lockedIds,
}: {
  members: HouseholdMember[];
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Owners that can't be unchecked here (you, or co-owners only they can remove). */
  lockedIds: string[];
}) {
  const eligible = members.filter((m) => m.role !== 'viewer');
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-sm font-medium">Owners</legend>
      {eligible.map((m) => (
        <Checkbox
          key={m.id}
          isSelected={selected.includes(m.id)}
          isDisabled={lockedIds.includes(m.id)}
          onChange={(on) =>
            onChange(on ? [...selected, m.id] : selected.filter((id) => id !== m.id))
          }
        >
          <Avatar name={m.displayName} color={m.color} size="sm" />
          {m.displayName}
          {m.isYou ? ' (you)' : ''}
        </Checkbox>
      ))}
      <p className="text-xs text-muted">Joint accounts are split equally between owners.</p>
    </fieldset>
  );
}

function VisibilityPicker({
  value,
  onChange,
  allowPrivate,
}: {
  value: AccountVisibility;
  onChange: (v: AccountVisibility) => void;
  allowPrivate: boolean;
}) {
  return (
    <RadioGroup
      label="Who else can see it"
      value={value}
      onChange={(v) => onChange(v as AccountVisibility)}
    >
      {(Object.keys(VISIBILITY) as AccountVisibility[]).map((v) => (
        <RadioCard
          key={v}
          value={v}
          title={VISIBILITY[v].label}
          description={
            v === 'private' && !allowPrivate
              ? 'Not available for a joint account in a two-person household: you both own it.'
              : VISIBILITY[v].description
          }
          isDisabled={v === 'private' && !allowPrivate}
        />
      ))}
    </RadioGroup>
  );
}

function AddAccountDialog({
  isOpen,
  onOpenChange,
  household,
  members,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  household: Household;
  members: HouseholdMember[];
}) {
  const me = household.you.memberId;
  const today = useToday();
  const navigate = useNavigate();
  const invalidate = useInvalidateAccounts(household.id);
  const defaults = () => ({
    type: 'depository' as AccountType,
    owners:
      household.financeStyle === 'combined'
        ? members.filter((m) => m.role !== 'viewer').map((m) => m.id)
        : [me],
    visibility: DEFAULT_VISIBILITY[household.financeStyle],
    balance: null as number | null,
    asOf: today,
  });
  const [state, setState] = useState(defaults);
  const set = (patch: Partial<typeof state>) => setState((s) => ({ ...s, ...patch }));
  const allowPrivate = privateAllowed(state.owners.length, members.length);
  const visibility = !allowPrivate && state.visibility === 'private' ? 'full' : state.visibility;
  const liability = isLiability(state.type);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Data<Account>>('POST', `${base(household.id)}/accounts`, { body }),
    onSuccess: async (r) => {
      await invalidate();
      toast(`${r.data.name} added.`);
      onOpenChange(false);
      setState(defaults());
      await navigate({ to: `/h/${household.id}/accounts/${r.data.id}` });
    },
  });
  const err = create.error as ApiError | null;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    create.mutate({
      name: form.get('name'),
      type: state.type,
      visibility,
      owners: state.owners.map((memberId) => ({ memberId })),
      ...(state.balance !== null
        ? {
            openingBalance: {
              amountMinor: liability ? -state.balance : state.balance,
              asOf: state.asOf,
            },
          }
        : {}),
    });
  };

  return (
    <Dialog title="Add account" size="lg" isOpen={isOpen} onOpenChange={onOpenChange}>
      {(close) => (
        <Form onSubmit={onSubmit} validationErrors={err?.fieldErrors()}>
          {err?.formError ? <Alert>{err.formError}</Alert> : null}
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label="Name"
              name="name"
              isRequired
              maxLength={120}
              placeholder="Joint checking"
              autoFocus
            />
            <Select
              label="Type"
              value={state.type}
              onChange={(v) => v && set({ type: v as AccountType })}
            >
              {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => (
                <SelectItem key={t} id={t}>
                  {TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </Select>
            <AmountInput
              label={liability ? 'Amount owed' : 'Current balance'}
              currency={household.baseCurrency}
              value={state.balance}
              onChange={(balance) => set({ balance })}
              description="Optional. You can update it any time."
            />
            <DatePicker
              label="As of"
              value={state.asOf}
              maxValue={today}
              onChange={(asOf) => asOf && set({ asOf })}
            />
          </div>
          {members.filter((m) => m.role !== 'viewer').length > 1 ? (
            <OwnersPicker
              members={members}
              selected={state.owners}
              onChange={(owners) => set({ owners })}
              lockedIds={[me]}
            />
          ) : null}
          {members.length > 1 ? (
            <VisibilityPicker
              value={visibility}
              onChange={(v) => set({ visibility: v })}
              allowPrivate={allowPrivate}
            />
          ) : null}
          <DialogActions>
            <Button variant="secondary" onPress={close}>
              Cancel
            </Button>
            <Button type="submit" isPending={create.isPending}>
              Add account
            </Button>
          </DialogActions>
        </Form>
      )}
    </Dialog>
  );
}

// ── Account detail ─────────────────────────────────────────────────────────────────────────────

export function AccountDetailPage() {
  const { householdId, household, members } = useHouseholdData();
  const { accountId } = useParams({ strict: false }) as { accountId: string };
  const account = useQuery(accountQuery(householdId, accountId));
  const balances = useQuery(balancesQuery(householdId, accountId));

  if (account.isPending) {
    return (
      <LoadingRegion label="Loading account">
        <div className="mx-auto max-w-4xl space-y-3 px-4 py-6 md:px-8">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32" />
        </div>
      </LoadingRegion>
    );
  }
  if (account.isError) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 md:px-8">
        <EmptyState icon={Landmark} title="Account not found">
          <p>It may have been removed, or you don’t have access to it.</p>
          <Link to={`/h/${householdId}/accounts`} className="font-medium text-accent-text">
            Back to accounts
          </Link>
        </EmptyState>
      </div>
    );
  }
  const a = account.data;
  const owner = a.yourAccess === 'owner';

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:px-8">
      <div>
        <Link
          to={`/h/${householdId}/accounts`}
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" /> Accounts
        </Link>
        <div className="mt-2 flex flex-wrap items-end gap-4">
          <div className="mr-auto min-w-0">
            <h1 className="truncate text-2xl font-semibold">{a.name}</h1>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
              {members.length > 1 ? <span>{ownerLabel(a, members)} ·</span> : null}
              <span>{TYPE_LABELS[a.type]}</span>
              {a.mask ? <span>· •••• {a.mask}</span> : null}
              {owner && members.length > 1 ? <Badge>{VISIBILITY[a.visibility].label}</Badge> : null}
              {a.closedAt ? <Badge tone="warning">Closed</Badge> : null}
            </p>
          </div>
          <div className="text-right">
            {a.balance ? (
              <>
                <Amount
                  minor={a.balance.amountMinor}
                  currency={a.currency}
                  kind={balanceKind(a.type)}
                  className="text-3xl font-semibold tracking-tight"
                />
                <p className="text-xs text-muted">
                  as of <DateText value={a.balance.asOf} />
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">No balance yet</p>
            )}
          </div>
        </div>
      </div>

      <Tabs>
        <TabList aria-label="Account">
          <Tab id="history">History</Tab>
          <Tab id="settings">{owner ? 'Settings' : 'Details'}</Tab>
        </TabList>
        <TabPanel id="history" className="space-y-4">
          {owner ? <UpdateBalance account={a} householdId={householdId} /> : null}
          <BalanceHistory account={a} points={balances.data} />
        </TabPanel>
        <TabPanel id="settings">
          {owner ? (
            <AccountSettings account={a} household={household} members={members} />
          ) : (
            <AccountDetails account={a} members={members} />
          )}
        </TabPanel>
      </Tabs>
    </div>
  );
}

function BalanceHistory({
  account,
  points,
}: {
  account: Account;
  points: import('@fiscus/shared').BalancePoint[] | undefined;
}) {
  if (!points) return <Skeleton className="h-40" />;
  if (points.length === 0) {
    return <p className="text-sm text-muted">No balances in the last 12 months.</p>;
  }
  const rows = [...points].reverse();
  return (
    <Card className="space-y-4">
      <Sparkline values={points.map((p) => p.amountMinor)} />
      <div className="-mx-5 overflow-x-auto">
        <Table aria-label={`${account.name} balance history`}>
          <TableHeader>
            <Column id="date" isRowHeader>
              Date
            </Column>
            <Column id="source">Source</Column>
            <Column id="amount" align="end">
              Balance
            </Column>
          </TableHeader>
          <TableBody items={rows.map((p) => ({ id: p.asOf, ...p }))}>
            {(p) => (
              <Row id={p.id}>
                <Cell>
                  <DateText value={p.asOf} />
                </Cell>
                <Cell className="text-muted">
                  {p.source === 'manual'
                    ? 'Entered'
                    : p.source === 'provider'
                      ? 'Bank'
                      : 'Calculated'}
                </Cell>
                <Cell align="end">
                  <Amount
                    minor={p.amountMinor}
                    currency={account.currency}
                    kind={balanceKind(account.type)}
                  />
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function UpdateBalance({ account, householdId }: { account: Account; householdId: string }) {
  const today = useToday();
  const liability = isLiability(account.type);
  const invalidate = useInvalidateAccounts(householdId);
  const [amount, setAmount] = useState<number | null>(
    account.balance ? Math.abs(account.balance.amountMinor) : null,
  );
  const [asOf, setAsOf] = useState(today);
  const save = useMutation({
    mutationFn: () =>
      api('PUT', `${base(householdId)}/accounts/${account.id}/balances/${asOf}`, {
        body: { amountMinor: liability ? -(amount ?? 0) : (amount ?? 0) },
      }),
    onSuccess: async () => {
      await invalidate();
      toast('Balance updated.');
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  return (
    <DialogTrigger>
      <Button variant="secondary">Update balance</Button>
      <Dialog title="Update balance" size="sm">
        {(close) => (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(undefined, { onSuccess: close });
            }}
          >
            <AmountInput
              label={liability ? 'Amount owed' : 'Balance'}
              currency={account.currency}
              value={amount}
              onChange={setAmount}
              isRequired
              autoFocus
            />
            <DatePicker
              label="As of"
              value={asOf}
              maxValue={today}
              onChange={(d) => d && setAsOf(d)}
            />
            <DialogActions>
              <Button variant="secondary" onPress={close}>
                Cancel
              </Button>
              <Button type="submit" isPending={save.isPending} isDisabled={amount === null}>
                Save
              </Button>
            </DialogActions>
          </Form>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function OwnersList({ account, members }: { account: Account; members: HouseholdMember[] }) {
  return (
    <ul className="space-y-2">
      {account.owners.map((o) => {
        const m = members.find((x) => x.id === o.memberId);
        return (
          <li key={o.memberId} className="flex items-center gap-2 text-sm">
            {m ? <Avatar name={m.displayName} color={m.color} size="sm" /> : null}
            <span className="flex-1">
              {m?.displayName ?? 'Former member'}
              {m?.isYou ? ' (you)' : ''}
            </span>
            {account.owners.length > 1 ? (
              <span className="text-muted">{(o.shareBps / 100).toLocaleString()}%</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** What a non-owner sees: who owns it and how it's shared, plus notes at view-only and above. */
function AccountDetails({ account, members }: { account: Account; members: HouseholdMember[] }) {
  return (
    <Card className="space-y-5">
      <div>
        <h2 className="mb-2 text-sm font-medium">Owners</h2>
        <OwnersList account={account} members={members} />
      </div>
      <div>
        <h2 className="mb-1 text-sm font-medium">What you can see</h2>
        <p className="text-sm text-muted">{VISIBILITY[account.visibility].description}</p>
      </div>
      {'notes' in account && account.notes ? (
        <div>
          <h2 className="mb-1 text-sm font-medium">Notes</h2>
          <p className="whitespace-pre-wrap text-sm">{account.notes}</p>
        </div>
      ) : null}
      <p className="text-xs text-muted">Only the account’s owners can change it.</p>
    </Card>
  );
}

function AccountSettings({
  account,
  household,
  members,
}: {
  account: Account;
  household: Household;
  members: HouseholdMember[];
}) {
  const householdId = household.id;
  const me = household.you.memberId;
  const invalidate = useInvalidateAccounts(householdId);
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: account.name,
    notes: account.notes ?? '',
    visibility: account.visibility,
    includeInNetWorth: account.includeInNetWorth,
    isBusiness: account.isBusiness,
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const allowPrivate = privateAllowed(account.owners.length, members.length);

  const changes = Object.fromEntries(
    Object.entries(form).filter(([k, v]) => {
      const current = k === 'notes' ? (account.notes ?? '') : account[k as keyof Account];
      return v !== current;
    }),
  );
  const save = useMutation({
    mutationFn: () =>
      api<Data<Account>>('PATCH', `${base(householdId)}/accounts/${account.id}`, {
        body: { ...changes, ...('notes' in changes ? { notes: form.notes || null } : {}) },
        headers: { 'if-match': `"v${account.version}"` },
      }),
    onSuccess: async () => {
      await invalidate();
      toast('Account saved.');
    },
    onError: async (e) => {
      const err = e as ApiError;
      if (err.code === 'edit_conflict') {
        toast('Someone else changed this first', {
          tone: 'error',
          description: 'Their changes are loaded now. Apply yours again if still needed.',
        });
        await invalidate();
      }
    },
  });
  const err = save.error as ApiError | null;

  const [owners, setOwners] = useState(account.owners.map((o) => o.memberId));
  const othersBefore = account.owners.map((o) => o.memberId).filter((id) => id !== me);
  const setOwnersMutation = useMutation({
    mutationFn: () =>
      api('PUT', `${base(householdId)}/accounts/${account.id}/owners`, {
        body: { owners: owners.map((memberId) => ({ memberId })) },
      }),
    onSuccess: async () => {
      await invalidate();
      toast(owners.includes(me) ? 'Owners updated.' : 'You’re no longer an owner.');
      if (!owners.includes(me)) await navigate({ to: `/h/${householdId}/accounts` });
    },
    onError: (e) => toast((e as ApiError).detail ?? (e as ApiError).title, { tone: 'error' }),
  });

  const close = useMutation({
    mutationFn: (closed: boolean) =>
      api('POST', `${base(householdId)}/accounts/${account.id}/${closed ? 'close' : 'reopen'}`),
    onSuccess: async (_, closed) => {
      await invalidate();
      toast(closed ? 'Account closed.' : 'Account reopened.');
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          validationErrors={err?.fieldErrors()}
        >
          {err?.formError && err.code !== 'edit_conflict' ? <Alert>{err.formError}</Alert> : null}
          <TextField
            label="Name"
            name="name"
            value={form.name}
            onChange={(name) => set({ name })}
            isRequired
            maxLength={120}
          />
          {members.length > 1 ? (
            <VisibilityPicker
              value={form.visibility}
              onChange={(visibility) => set({ visibility })}
              allowPrivate={allowPrivate}
            />
          ) : null}
          <div className="space-y-1">
            <Switch
              isSelected={form.includeInNetWorth}
              onChange={(includeInNetWorth) => set({ includeInNetWorth })}
            >
              Count in net worth
            </Switch>
            <Switch isSelected={form.isBusiness} onChange={(isBusiness) => set({ isBusiness })}>
              Business account
            </Switch>
          </div>
          <TextField
            label="Notes"
            name="notes"
            multiline
            value={form.notes}
            onChange={(notes) => set({ notes })}
            maxLength={5000}
            description={
              account.visibility === 'balance_only' || account.visibility === 'private'
                ? 'Only owners see notes on this account.'
                : 'Everyone who can see this account sees its notes.'
            }
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              isPending={save.isPending}
              isDisabled={Object.keys(changes).length === 0}
            >
              Save changes
            </Button>
          </div>
        </Form>
      </Card>

      {members.filter((m) => m.role !== 'viewer').length > 1 ? (
        <Card className="space-y-4">
          <h2 className="font-semibold">Owners</h2>
          <OwnersPicker
            members={members}
            selected={owners}
            onChange={setOwners}
            lockedIds={othersBefore.concat(owners.length === 1 ? owners : [])}
          />
          <p className="text-xs text-muted">
            You can add owners, or remove yourself. Other owners remove themselves.
          </p>
          <div className="flex justify-end">
            <Button
              variant="secondary"
              isPending={setOwnersMutation.isPending}
              isDisabled={
                owners.length === 0 ||
                (owners.length === account.owners.length &&
                  owners.every((id) => account.owners.some((o) => o.memberId === id)))
              }
              onPress={() => setOwnersMutation.mutate()}
            >
              Update owners
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="font-semibold">{account.closedAt ? 'Reopen account' : 'Close account'}</h2>
          <p className="text-sm text-muted">
            {account.closedAt
              ? 'It will count in totals again.'
              : 'Its history is kept, and it stops counting in totals from today.'}
          </p>
        </div>
        {account.closedAt ? (
          <Button
            variant="secondary"
            onPress={() => close.mutate(false)}
            isPending={close.isPending}
          >
            Reopen
          </Button>
        ) : (
          <DialogTrigger>
            <Button variant="danger">Close account</Button>
            <ConfirmDialog
              title={`Close ${account.name}?`}
              confirmLabel="Close account"
              destructive
              onConfirm={() => close.mutateAsync(true)}
            >
              Its history is kept, and you can reopen it later. Other owners are told in the
              activity feed.
            </ConfirmDialog>
          </DialogTrigger>
        )}
      </Card>
    </div>
  );
}
