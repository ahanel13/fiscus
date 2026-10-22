// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  AccountLayout,
  AccountLayoutInput,
  AccountType,
  AccountVisibility,
  Household,
  HouseholdMember,
} from '@fiscus/shared';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Landmark,
  MoreHorizontal,
  Pencil,
  Plus,
  Upload,
} from 'lucide-react';
import { Text, useLocale } from 'react-aria-components';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  accountLayoutQuery,
  accountQuery,
  accountsQuery,
  balancesQuery,
  categoriesQuery,
  householdQuery,
  membersQuery,
  netWorthRangeQuery,
  plaidAvailabilityQuery,
} from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { BankConnections } from '../components/BankConnections.js';
import { CardDetails } from '../components/CardDetails.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { BalanceChart } from '../components/BalanceChart.js';
import { Sparkline } from '../components/Sparkline.js';
import {
  Alert,
  AmountInput,
  Avatar,
  Badge,
  Button,
  ButtonLink,
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
  Menu,
  MenuItem,
  MenuTrigger,
  RadioCard,
  RadioGroup,
  Row,
  Select,
  SelectItem,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableHeader,
  TextField,
  toast,
  useToday,
} from '../components/ui.js';
import {
  balanceKind,
  buildSections,
  DEFAULT_VISIBILITY,
  deleteGroup,
  GROUPS,
  isLiability,
  layoutFrom,
  moveGroup,
  moveTo,
  moveWithin,
  ownerLabel,
  privateAllowed,
  renameGroup,
  type Section,
  sectionTotal,
  trend,
  TYPE_LABELS,
  typeSectionKey,
  VISIBILITY,
} from '../lib/accounts.js';
import { leaveTo, takeFlash } from '../lib/flash.js';
import { type Lens, lensVisible, parseLens } from '../lib/lens.js';
import { formatSpan, type RangeSelection, rangeParams, selectionLabel } from '../lib/ranges.js';
import { useRange } from '../lib/use-range.js';
import { RangeChips } from '../components/RangeControls.js';
import { AddTransactionDialog, TransactionDrawer, TransactionList } from './transactions.js';
import { MakeJointOffer } from './make-joint.js';

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
  // One range for the page: net worth's trend and each account's change over it (#353).
  const range = useRange(household, 'net-worth', 'last_12m');
  const accounts = useQuery({
    ...accountsQuery(householdId, lens, 'open', rangeParams(range.selection)),
    placeholderData: keepPreviousData,
  });
  const [adding, setAdding] = useState(false);
  const canAdd = household.you.role !== 'viewer';
  const arrange = useArrange(householdId);
  // Viewers can't connect banks (ACC-01), and the entry shows only where Plaid is set up (#79).
  const plaid = useQuery({ ...plaidAvailabilityQuery(householdId), enabled: canAdd }).data;
  // Coming back from connecting a bank (a full page load): how it went.
  useEffect(() => {
    const flash = takeFlash();
    if (flash) {
      toast(flash.title, {
        tone: flash.tone,
        ...(flash.description ? { description: flash.description } : {}),
      });
    }
  }, []);
  // One way in, which asks how: from the bank, by hand, or from a file (walkthrough §1).
  // In the header it's an icon on a phone, as on Transactions; the empty state keeps its label.
  const addMenu = (compact: boolean) => (
    <MenuTrigger>
      <Button className={compact ? 'px-2.5 sm:px-3.5' : undefined}>
        <Plus aria-hidden className="size-4" />
        <span className={compact ? 'sr-only sm:not-sr-only' : undefined}>Add account</span>
      </Button>
      <Menu placement="bottom end" aria-label="Add an account" className="max-w-xs">
        {plaid?.available ? (
          // A full page load, never the router: only the connect page may run Plaid's script.
          <MenuItem
            textValue="Connect a bank"
            onAction={() => leaveTo(`/h/${householdId}/connect/plaid`)}
          >
            <AddOption icon={<Landmark aria-hidden />} label="Connect a bank">
              Sign in through Plaid. Updates several times a day.
            </AddOption>
          </MenuItem>
        ) : null}
        <MenuItem textValue="Enter it yourself" onAction={() => setAdding(true)}>
          <AddOption icon={<Pencil aria-hidden />} label="Enter it yourself">
            For cash, a house, a car, or a bank without a feed.
          </AddOption>
        </MenuItem>
        <MenuItem textValue="Import from Monarch or a bank file" href={`/h/${householdId}/import`}>
          <AddOption icon={<Upload aria-hidden />} label="Import from Monarch or a bank file">
            A Monarch export, CSV, OFX or QFX.
          </AddOption>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );

  return (
    <>
      <PageHeader
        title="Accounts"
        range={range}
        showLens={showLens}
        members={members}
        action={canAdd ? addMenu(true) : undefined}
      />
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
        <MakeJointOffer householdId={householdId} />
        <BankConnections
          householdId={householdId}
          accounts={accounts.data ?? []}
          members={members}
        />
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
              you own, like a home or a car.{' '}
              {plaid?.available
                ? 'Connect your bank, enter them yourself, or import them from a Monarch export or a bank’s file.'
                : 'Enter them yourself, or import them from a Monarch export or a bank’s file.'}
            </p>
            {canAdd ? addMenu(false) : null}
          </EmptyState>
        ) : (
          <>
            <NetWorthCard household={household} lens={lens} range={range} />
            <div className="flex flex-wrap items-center justify-end gap-2">
              {arrange.draft ? (
                <>
                  <p className="mr-auto text-sm text-muted" role="status">
                    Only you see how you arrange your list. It doesn’t change what anyone else can
                    see.
                  </p>
                  <Button variant="secondary" size="sm" onPress={() => arrange.name(null)}>
                    <Plus aria-hidden className="size-4" /> New group
                  </Button>
                  <Button size="sm" onPress={arrange.stop}>
                    Done
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() =>
                    arrange.start(
                      buildSections(accounts.data, arrange.layout, { keepEmptyGroups: true }),
                    )
                  }
                >
                  <ArrowUpDown aria-hidden className="size-4" /> Arrange
                </Button>
              )}
            </div>
            {(arrange.draft ?? buildSections(accounts.data, arrange.layout)).map(
              (section, _, all) => (
                <AccountGroup
                  key={section.key}
                  section={section}
                  members={members}
                  householdId={householdId}
                  currency={household.baseCurrency}
                  range={{ from: range.resolved.from, label: selectionLabel(range.selection) }}
                  arrange={arrange.draft ? { sections: all, ...arrange } : undefined}
                />
              ),
            )}
          </>
        )}
      </div>
      {arrange.naming ? (
        <GroupNameDialog
          initial={arrange.naming.label}
          onClose={() => arrange.name(undefined)}
          onSave={(name) => {
            const naming = arrange.naming!;
            arrange.name(undefined);
            if (naming.groupId) arrange.change(renameGroup(arrange.draft!, naming.groupId, name));
            else arrange.change(arrange.draft!, name);
          }}
        />
      ) : null}
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

/** One way to add an account, with what it's for (walkthrough §1). */
function AddOption({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: string;
}) {
  return (
    <span className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5">{icon}</span>
      <span className="flex flex-col">
        <Text slot="label">{label}</Text>
        <Text slot="description" className="text-xs text-muted">
          {children}
        </Text>
      </span>
    </span>
  );
}

/** Net worth "visible to you" (F3), with one-click ranges for its trend (ADR 0011 §2). */
/**
 * Net worth and its trend. On its own (Accounts) it has its own range; given the page's `range`
 * (the dashboard), it follows that instead, so one page doesn't have two time controls.
 */
export function NetWorthCard({
  household,
  lens,
  range: pageRange,
}: {
  household: Household;
  lens: Lens;
  range?: ReturnType<typeof useRange>;
}) {
  const ownRange = useRange(household, 'net-worth', 'last_12m');
  const range = pageRange ?? ownRange;
  const query = useQuery(netWorthRangeQuery(household.id, lens, rangeParams(range.selection)));
  const data = query.data;
  if (!data) return <Skeleton className="h-36" />;
  const values = trend(data.series.map((p) => p.netWorthMinor));
  return (
    <Card className="grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
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
      <div className="space-y-2 md:w-72">
        {pageRange ? null : <RangeChips state={range} label="Net worth range" />}
        <Sparkline values={values} />
        {values.length > 1 ? (
          <p className="text-right text-xs text-muted">
            {formatSpan(data.range.from, data.range.to)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** Arranging your accounts list (#48): a draft of the sections, saved as you change it. */
function useArrange(householdId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAccounts(householdId);
  const layout = useQuery(accountLayoutQuery(householdId)).data;
  const [draft, setDraft] = useState<Section[] | null>(null);
  /** The group being named: `null` for a new one. */
  const [naming, setNaming] = useState<{ groupId: string | null; label: string } | undefined>();
  const save = useMutation({
    mutationFn: async (body: AccountLayoutInput) =>
      (await api<Data<AccountLayout>>('PUT', `${base(householdId)}/account-layout`, { body })).data,
    onSuccess: (saved) => {
      queryClient.setQueryData(accountLayoutQuery(householdId).queryKey, saved);
      // A new group gets its id from the api: add it to the draft.
      setDraft((d) => {
        if (!d) return d;
        const added = saved.groups
          .filter((g) => !d.some((s) => s.groupId === g.id))
          .map((g) => ({ key: `group:${g.id}`, label: g.name, groupId: g.id, accounts: [] }));
        const groups = d.filter((s) => s.groupId !== null);
        return [...groups, ...added, ...d.filter((s) => s.groupId === null)];
      });
      void invalidate();
    },
    onError: (e) => {
      toast((e as ApiError).title, { tone: 'error' });
      setDraft(null);
    },
  });
  return {
    layout,
    draft,
    naming,
    pending: save.isPending,
    start: (sections: Section[]) => setDraft(sections),
    stop: () => setDraft(null),
    name: (group: Section | null | undefined) =>
      setNaming(
        group === undefined
          ? undefined
          : { groupId: group?.groupId ?? null, label: group?.label ?? '' },
      ),
    change: (next: Section[], newGroup?: string) => {
      setDraft(next);
      save.mutate(layoutFrom(next, layout, newGroup));
    },
  };
}

type Arrange = ReturnType<typeof useArrange> & { sections: Section[] };

function GroupNameDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Dialog
      title={initial ? 'Rename group' : 'New group'}
      size="sm"
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim());
        }}
        className="space-y-4"
      >
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          maxLength={60}
          isRequired
          autoFocus
          placeholder="Everyday"
          description="Only you see your groups."
        />
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" isDisabled={!name.trim()}>
            {initial ? 'Rename' : 'Add group'}
          </Button>
        </DialogActions>
      </Form>
    </Dialog>
  );
}

function AccountGroup({
  section,
  members,
  householdId,
  currency,
  range,
  arrange,
}: {
  section: Section;
  members: HouseholdMember[];
  householdId: string;
  currency: string;
  /** The page's range, for each account's change over it. */
  range: { from: string; label: string };
  /** While you arrange the list. */
  arrange?: Arrange;
}) {
  const { accounts, label } = section;
  const sameCurrency = accounts.every((a) => a.currency === currency);
  const total = sectionTotal(section);
  const headingId = `section-${section.key}`;
  const groupIndex = arrange
    ? arrange.sections.filter((s) => s.groupId !== null).findIndex((s) => s.key === section.key)
    : -1;
  const groupCount = arrange?.sections.filter((s) => s.groupId !== null).length ?? 0;
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 px-1">
        <h2 id={headingId} className="font-semibold">
          {label}
        </h2>
        {arrange && section.groupId ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move group ${label} up`}
              isDisabled={arrange.pending || groupIndex === 0}
              onPress={() => arrange.change(moveGroup(arrange.sections, section.groupId!, -1))}
            >
              <ArrowUp aria-hidden className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move group ${label} down`}
              isDisabled={arrange.pending || groupIndex === groupCount - 1}
              onPress={() => arrange.change(moveGroup(arrange.sections, section.groupId!, 1))}
            >
              <ArrowDown aria-hidden className="size-4" />
            </Button>
            <Button variant="ghost" size="sm" onPress={() => arrange.name(section)}>
              Rename
            </Button>
            <Button
              variant="ghost"
              size="sm"
              isDisabled={arrange.pending}
              onPress={() => {
                arrange.change(deleteGroup(arrange.sections, section.groupId!));
                toast(`Group “${label}” deleted.`, {
                  description: accounts.length
                    ? 'Its accounts are back in their sections.'
                    : undefined,
                });
              }}
            >
              Delete
            </Button>
          </div>
        ) : accounts.length && sameCurrency ? (
          <Amount
            minor={total.minor}
            currency={currency}
            kind={total.kind}
            className="text-sm text-muted"
          />
        ) : null}
      </div>
      {arrange && accounts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted">
          Empty. Use “Move to” on an account to put it here.
        </p>
      ) : null}
      {/* Not a Card: its padding would double the rows' own and squeeze the names. */}
      {accounts.length ? (
        <div className="rounded-xl border border-border bg-surface">
          <ul className="divide-y divide-border">
            {accounts.map((a, i) => (
              <li key={a.id}>
                {arrange ? (
                  <ArrangeRow
                    account={a}
                    section={section}
                    first={i === 0}
                    last={i === accounts.length - 1}
                    arrange={arrange}
                  />
                ) : (
                  <Link
                    to={`/h/${householdId}/accounts/${a.id}`}
                    className="flex items-center gap-3 hover:bg-surface-2"
                    style={{ minHeight: 'var(--row-h)', paddingInline: 'var(--cell-px)' }}
                  >
                    <span className="min-w-0 flex-1 py-2">
                      {/* Long bank names wrap to a second line on a phone rather than cutting off. */}
                      <span className="line-clamp-2 text-sm font-medium break-words sm:line-clamp-1">
                        {a.name}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                        {members.length > 1 ? <span>{ownerLabel(a, members)}</span> : null}
                        {a.mask ? <span>•••• {a.mask}</span> : null}
                        {a.yourAccess === 'owner' && a.visibility !== 'full' ? (
                          <Badge>{VISIBILITY[a.visibility].label}</Badge>
                        ) : null}
                        {a.closedAt ? <Badge>Closed</Badge> : null}
                      </span>
                    </span>
                    {/* The change over the page's range, then the balance and when it's from. */}
                    {a.change && a.change.amountMinor !== 0 ? (
                      <span className="hidden text-right text-xs sm:block">
                        <Amount minor={a.change.amountMinor} currency={a.currency} />
                        {/* An account that began during the range counts from its first balance. */}
                        <span className="block text-muted">
                          {a.change.from === range.from ? (
                            range.label
                          ) : (
                            <>
                              since <DateText value={a.change.from} format="short" />
                            </>
                          )}
                        </span>
                      </span>
                    ) : null}
                    <span className="shrink-0 text-right sm:w-32">
                      {a.balance ? (
                        <>
                          <Amount
                            minor={a.balance.amountMinor}
                            currency={a.currency}
                            kind={balanceKind(a.type)}
                            className="block text-sm font-medium"
                          />
                          <span className="block text-xs text-muted">
                            as of <DateText value={a.balance.asOf} format="short" />
                          </span>
                        </>
                      ) : (
                        <span className="block text-sm text-muted">No balance</span>
                      )}
                    </span>
                    <ChevronRight
                      aria-hidden
                      className="hidden size-4 shrink-0 text-muted sm:block"
                    />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** An account while you arrange: up, down, and "Move to" another section. */
function ArrangeRow({
  account: a,
  section,
  first,
  last,
  arrange,
}: {
  account: Account;
  section: Section;
  first: boolean;
  last: boolean;
  arrange: Arrange;
}) {
  const home = typeSectionKey(a);
  const targets = [
    ...arrange.sections
      .filter((s) => s.groupId !== null && s.key !== section.key)
      .map((s) => ({ key: s.key, label: s.label })),
    ...(section.groupId !== null
      ? [{ key: home, label: `Back to ${GROUPS.find((g) => `type:${g.id}` === home)!.label}` }]
      : []),
  ];
  return (
    <div
      className="flex items-center gap-2"
      style={{ minHeight: 'var(--row-h)', paddingInline: 'var(--cell-px)' }}
    >
      <span className="min-w-0 flex-1 py-2 text-sm font-medium break-words">{a.name}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Move ${a.name} up`}
        isDisabled={arrange.pending || first}
        onPress={() => arrange.change(moveWithin(arrange.sections, a.id, -1))}
      >
        <ArrowUp aria-hidden className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Move ${a.name} down`}
        isDisabled={arrange.pending || last}
        onPress={() => arrange.change(moveWithin(arrange.sections, a.id, 1))}
      >
        <ArrowDown aria-hidden className="size-4" />
      </Button>
      {targets.length ? (
        <MenuTrigger>
          <Button variant="secondary" size="sm" isDisabled={arrange.pending}>
            Move to…
          </Button>
          <Menu placement="bottom end" aria-label={`Move ${a.name} to`}>
            {targets.map((t) => (
              <MenuItem
                key={t.key}
                onAction={() => arrange.change(moveTo(arrange.sections, a.id, t.key))}
              >
                {t.label}
              </MenuItem>
            ))}
          </Menu>
        </MenuTrigger>
      ) : null}
    </div>
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
              description="Optional. Your balance at the end of that day, including that day’s transactions."
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
  // The chart and the Balances tab follow one range (#353).
  const range = useRange(household, 'account', 'last_12m');
  const params = rangeParams(range.selection);
  const balances = useQuery(balancesQuery(householdId, accountId, params));
  const chart = useQuery(balancesQuery(householdId, accountId, params, true));
  const [dialog, setDialog] = useState<'balance' | 'history' | 'settings' | null>(null);

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
  const points = chart.data;
  const opening = points?.[0];
  const latest = points?.at(-1);
  const change = opening && latest ? latest.amountMinor - opening.amountMinor : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:px-8">
      {/* As Monarch lays it out (F5): the balance and its change, the chart, then what's in it. */}
      <div>
        <Link
          to={`/h/${householdId}/accounts`}
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" /> Accounts
        </Link>
        <div className="mt-2 flex items-start gap-2">
          <div className="mr-auto min-w-0">
            <h1 className="truncate text-2xl font-semibold">{a.name}</h1>
            {/* One line on a phone: the account type gives way. */}
            <p className="flex min-w-0 items-center gap-2 text-sm whitespace-nowrap text-muted">
              {members.length > 1 ? (
                <span className="shrink-0">{ownerLabel(a, members)} ·</span>
              ) : null}
              <span className="min-w-0 truncate">{TYPE_LABELS[a.type]}</span>
              {a.mask ? <span className="shrink-0">· •••• {a.mask}</span> : null}
              {owner && members.length > 1 ? (
                <Badge className="shrink-0">{VISIBILITY[a.visibility].label}</Badge>
              ) : null}
              {a.closedAt ? (
                <Badge tone="warning" className="shrink-0">
                  Closed
                </Badge>
              ) : null}
            </p>
          </div>
          <MenuTrigger>
            <Button variant="ghost" size="icon" aria-label="Account actions">
              <MoreHorizontal aria-hidden className="size-5" />
            </Button>
            <Menu placement="bottom end">
              {owner && !a.closedAt ? (
                <MenuItem onAction={() => setDialog('balance')}>Update balance</MenuItem>
              ) : null}
              <MenuItem onAction={() => setDialog('history')}>Balance history</MenuItem>
              {owner ? (
                <MenuItem onAction={() => setDialog('settings')}>Account settings</MenuItem>
              ) : null}
            </Menu>
          </MenuTrigger>
        </div>
        <div className="mt-4">
          {a.balance ? (
            <>
              <Amount
                minor={a.balance.amountMinor}
                currency={a.currency}
                kind={balanceKind(a.type)}
                className="block text-3xl font-semibold tracking-tight"
              />
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
                {opening && change !== 0 ? (
                  <span className="inline-flex items-center gap-1">
                    {change > 0 ? (
                      <ArrowUpRight aria-hidden className="size-4 text-positive" />
                    ) : (
                      <ArrowDownRight aria-hidden className="size-4 text-muted" />
                    )}
                    <Amount minor={change} currency={a.currency} className="font-medium" />
                    {opening.amountMinor !== 0 ? (
                      <span className="text-muted">
                        (<Percent value={change / Math.abs(opening.amountMinor)} />)
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {/* An account that began during the range changed since its first balance. */}
                <span className="text-muted">
                  {opening && opening.asOf > range.resolved.from ? (
                    <>
                      since <DateText value={opening.asOf} format="short" />
                    </>
                  ) : (
                    rangeName(range.selection)
                  )}
                </span>
                {/* On its own line on a phone. */}
                <span className="w-full text-xs text-muted sm:w-auto sm:text-sm">
                  <span className="hidden sm:inline">· </span>as of{' '}
                  <DateText value={a.balance.asOf} />
                </span>
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">No balance yet</p>
          )}
        </div>
      </div>

      {/* Edge to edge on a phone, as in Monarch; a card on wider screens. */}
      <div className="-mx-4 space-y-4 border-y border-border bg-surface px-3 py-5 sm:mx-0 sm:rounded-xl sm:border sm:px-5">
        {points ? (
          <BalanceChart
            points={points}
            // The whole range, empty before an account's first balance; "All" starts at it.
            from={
              points[0] && points[0].asOf < range.resolved.from
                ? points[0].asOf
                : range.resolved.from
            }
            to={range.resolved.to}
            currency={a.currency}
            kind={balanceKind(a.type)}
            label={`${a.name} balance`}
          />
        ) : (
          <Skeleton className="h-44 sm:h-56" />
        )}
        <div className="flex justify-center sm:justify-start">
          <RangeChips state={range} label="Balance range" />
        </div>
      </div>

      {/* Bank-style accounts list their transactions; hand-valued assets their balances. */}
      {a.balanceMode === 'transactions' ? (
        <section aria-labelledby="account-transactions" className="space-y-3">
          <h2 id="account-transactions" className="font-semibold">
            Transactions
          </h2>
          <AccountTransactions householdId={householdId} account={a} members={members} />
        </section>
      ) : (
        <section aria-labelledby="account-balances" className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id="account-balances" className="font-semibold">
              Balances
            </h2>
            {owner && !a.closedAt ? (
              <Button variant="secondary" size="sm" onPress={() => setDialog('balance')}>
                Update balance
              </Button>
            ) : null}
          </div>
          <BalanceHistory account={a} points={balances.data} />
        </section>
      )}

      <CardDetails account={a} />

      <section aria-labelledby="account-summary" className="space-y-3">
        <h2 id="account-summary" className="font-semibold">
          Summary
        </h2>
        <AccountDetails account={a} members={members} />
      </section>

      {owner ? (
        <UpdateBalance
          account={a}
          householdId={householdId}
          isOpen={dialog === 'balance'}
          onOpenChange={(open) => setDialog(open ? 'balance' : null)}
        />
      ) : null}
      <Dialog
        title="Balance history"
        isOpen={dialog === 'history'}
        onOpenChange={(open) => setDialog(open ? 'history' : null)}
      >
        <BalanceHistory account={a} points={balances.data} />
      </Dialog>
      {owner ? (
        <Dialog
          title="Account settings"
          isOpen={dialog === 'settings'}
          onOpenChange={(open) => setDialog(open ? 'settings' : null)}
        >
          <AccountSettings account={a} household={household} members={members} />
        </Dialog>
      ) : null}
    </div>
  );
}

/** A signed share in the viewer's language: "+12.5%", "−53.2%". */
function Percent({ value }: { value: number }) {
  const { locale } = useLocale();
  const text = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }).format(value);
  return <>{text.replace('-', '−')}</>;
}

/** The chips' ranges as Monarch words them: "1 month", "1 year". */
function rangeName(s: RangeSelection): string {
  const names: Partial<Record<string, string>> = {
    last_30d: '1 month',
    last_90d: '3 months',
    last_6m: '6 months',
    ytd: 'Year to date',
    last_12m: '1 year',
    all_time: 'All time',
  };
  return names[s.range] ?? selectionLabel(s);
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
    return <p className="text-sm text-muted">No balances in this range.</p>;
  }
  const rows = [...points].reverse();
  return (
    <Card>
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

function UpdateBalance({
  account,
  householdId,
  isOpen,
  onOpenChange,
}: {
  account: Account;
  householdId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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
    <Dialog title="Update balance" size="sm" isOpen={isOpen} onOpenChange={onOpenChange}>
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
            description="At the end of that day, including that day’s transactions. Other days are worked out from your transactions."
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
            <Button type="submit" isPending={save.isPending}>
              Save
            </Button>
          </DialogActions>
        </Form>
      )}
    </Dialog>
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

/** Who owns it and how it's shared, plus its notes for owners and at view-only and above. */
function AccountDetails({ account, members }: { account: Account; members: HouseholdMember[] }) {
  const owner = account.yourAccess === 'owner';
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
      {owner ? null : (
        <p className="text-xs text-muted">Only the account’s owners can change it.</p>
      )}
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

function AccountTransactions({
  householdId,
  account,
  members,
}: {
  householdId: string;
  account: Account;
  members: HouseholdMember[];
}) {
  const groups = useQuery(categoriesQuery(householdId)).data ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const canAdd = account.yourAccess === 'owner' && !account.closedAt;
  return (
    <>
      <TransactionList
        householdId={householdId}
        filters={{ lens: 'all', accounts: [account.id] }}
        members={members}
        groups={groups}
        onOpen={setOpen}
        showAccount={false}
        empty={
          <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm">
            <p className="font-medium">No transactions yet</p>
            {canAdd ? (
              <>
                <p className="mt-1 text-muted">
                  Enter them as they happen, or import a file from your bank or Monarch.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <Button variant="secondary" size="sm" onPress={() => setAdding(true)}>
                    <Plus aria-hidden className="size-4" /> Add a transaction
                  </Button>
                  <ButtonLink
                    variant="secondary"
                    size="sm"
                    to="/h/$householdId/import"
                    params={{ householdId }}
                  >
                    <Upload aria-hidden className="size-4" /> Import a file
                  </ButtonLink>
                </div>
              </>
            ) : null}
          </div>
        }
      />
      {adding ? (
        <AddTransactionDialog
          householdId={householdId}
          isOpen
          onOpenChange={(o) => !o && setAdding(false)}
          accounts={[account]}
          groups={groups}
        />
      ) : null}
      {open ? (
        <TransactionDrawer
          householdId={householdId}
          transactionId={open}
          members={members}
          groups={groups}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
