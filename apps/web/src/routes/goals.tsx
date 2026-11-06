// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  formatMoney,
  type Goal,
  type GoalAccount,
  type GoalClaim,
  type GoalIconName,
  type GoalShortfall,
  type GoalsOverview,
  type HouseholdMember,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Eye, EyeOff, Goal as GoalIcon, Plus } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { goalsQuery, householdQuery, membersQuery } from '../api/queries.js';
import { EmptyState } from '../components/EmptyState.js';
import { PicturePicker, shrinkPhoto } from '../components/GoalPicture.js';
import { claimLabel, GoalRow, lookOf } from '../components/GoalRow.js';
import { PageHeader } from '../components/PageHeader.js';
import {
  Alert,
  AmountInput,
  Badge,
  Button,
  ConfirmDialog,
  DatePicker,
  Dialog,
  DialogActions,
  LoadingRegion,
  Radio,
  RadioGroup,
  SegmentedControl,
  Skeleton,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
  toast,
} from '../components/ui.js';
import { DebtDialog, ManageDebts, PayDown } from './goals-pay-down.js';

// Goals (#132, #134, #136, #137, #138; goals walkthrough §1–§5, §8): savings goals that draw on
// accounts by claims, a fixed amount or a percentage of each (G2), and paying down loans and cards
// (G9), on two tabs. Progress is what the claims are worth, or how far a debt has come down; the
// status says whether its plan gets there by its date. Each wears a photo, or an icon on a color,
// and can be put away when it's done with. Goals in budgets and spending from goals come later
// (G22).

const base = (householdId: string) => `/api/v1/households/${householdId}`;
type Scope = 'all' | 'household' | 'mine';
type Kind = 'save' | 'pay_down';

/** "May 2027", from a date. */
const monthYear = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
/** How a claim reads: "$14,000.00", or "40%" with what it's worth now. */
function claimAmount(c: GoalClaim, currency: string): string {
  return c.percentBps !== null
    ? `${c.percentBps / 100}% · ${formatMoney(c.valueMinor, currency)}`
    : formatMoney(c.amountMinor ?? 0, currency);
}

export function GoalsPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const query = useQuery(goalsQuery(householdId));
  const [scope, setScope] = useState<Scope>('all');
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const [archiving, setArchiving] = useState<Goal | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [resolving, setResolving] = useState<GoalShortfall | null>(null);
  const [tab, setTab] = useState<Kind>('save');
  const [managing, setManaging] = useState(false);
  const queryClient = useQueryClient();
  const currency = household.baseCurrency;
  const shared = members.length > 1;
  // A goal's plan and archiving show in its budget too (G16).
  const invalidate = () =>
    Promise.all(
      ['goals', 'budgets'].map((k) =>
        queryClient.invalidateQueries({ queryKey: ['households', householdId, k] }),
      ),
    );

  const order = useMutation({
    mutationFn: (ids: string[]) =>
      api('PUT', `${base(householdId)}/goals/order`, { body: { ids } }),
    onSuccess: invalidate,
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const remove = useMutation({
    mutationFn: (g: Goal) => api('DELETE', `${base(householdId)}/goals/${g.id}`),
    onSuccess: async (_, g) => {
      await invalidate();
      toast(`${g.name} deleted. The money stays where it is.`);
      setDeleting(null);
    },
  });

  const archive = useMutation({
    mutationFn: ({ g, archived }: { g: Goal; archived: boolean }) =>
      api('PUT', `${base(householdId)}/goals/${g.id}/archived`, { body: { archived } }),
    onSuccess: async (_, { g, archived }) => {
      await invalidate();
      toast(
        !archived
          ? `${g.name} is back.`
          : g.kind === 'pay_down'
            ? `${g.name} is put away.`
            : `${g.name} is put away. Its money is unclaimed now.`,
      );
      setArchiving(null);
    },
    onError: (e) => {
      const err = e as ApiError;
      toast(err.title, { tone: 'error', description: err.detail ?? '' });
      setArchiving(null);
    },
  });

  const data = query.data;
  const ofKind = (kind: Kind) =>
    (data?.goals ?? []).filter((g) => g.kind === kind && (scope === 'all' || g.scope === scope));
  const shown = ofKind('save');
  const saving = (data?.goals ?? []).filter((g) => g.kind === 'save');
  const archived = (data?.archived ?? []).filter((g) => g.kind === tab);
  // Priority among savings goals: swap with the next one up or down, wherever debts sit between.
  const move = (g: Goal, by: number) => {
    const ids = data!.goals.map((x) => x.id);
    const i = ids.indexOf(g.id);
    const k = saving.findIndex((x) => x.id === g.id) + by;
    if (k < 0 || k >= saving.length) return;
    const j = ids.indexOf(saving[k]!.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    order.mutate(ids);
  };

  return (
    <>
      <PageHeader title="Goals" showLens={false} members={members} />
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-4 sm:py-6 md:px-8">
        {query.isPending ? (
          <LoadingRegion label="Loading your goals">
            <div className="space-y-3">
              <Skeleton className="h-20" />
              <div className="grid gap-3 md:grid-cols-3">
                <Skeleton className="h-40" />
                <Skeleton className="h-40" />
                <Skeleton className="h-40" />
              </div>
            </div>
          </LoadingRegion>
        ) : query.isError || !data ? (
          <Alert>Couldn’t load your goals. Try again in a moment.</Alert>
        ) : data.goals.length === 0 && data.archived.length === 0 && data.debts.length === 0 ? (
          <Empty data={data} currency={currency} onNew={() => setEditing('new')} />
        ) : (
          <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as Kind)}>
            <TabList aria-label="Kind of goal">
              <Tab id="save">Save up</Tab>
              <Tab id="pay_down">Pay down</Tab>
            </TabList>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {shared ? (
                <SegmentedControl
                  aria-label="Whose goals"
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'household', label: 'Ours' },
                    { value: 'mine', label: 'Mine' },
                  ]}
                  value={scope}
                  onChange={setScope}
                />
              ) : (
                <span />
              )}
              {!data.canCreate ? null : tab === 'save' ? (
                <Button size="sm" onPress={() => setEditing('new')}>
                  <Plus aria-hidden className="size-4" /> New goal
                </Button>
              ) : data.debts.length ? (
                <Button size="sm" variant="secondary" onPress={() => setManaging(true)}>
                  Manage debts
                </Button>
              ) : null}
            </div>

            <TabPanel id="save" className="space-y-5">
              {data.shortfalls.map((s) => (
                <Alert key={s.accountId} tone="warning">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1">
                      {s.accountName ?? 'An account'} is {formatMoney(s.shortMinor, currency)} short
                      of what goals have earmarked. Nothing moves until{' '}
                      {s.canResolve ? 'you choose' : 'its owners choose'} which goal gives way.
                    </span>
                    {s.canResolve ? (
                      <Button size="sm" variant="secondary" onPress={() => setResolving(s)}>
                        Choose which goal gives way
                      </Button>
                    ) : null}
                  </span>
                </Alert>
              ))}

              <section
                aria-label="Save up"
                className="overflow-hidden rounded-xl border border-border bg-surface"
              >
                <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-3 sm:px-5">
                  <h2 className="text-lg font-semibold">Save up</h2>
                  <p className="text-lg font-semibold tabular-nums">
                    {formatMoney(
                      shown.reduce((sum, g) => sum + g.progressMinor, 0),
                      currency,
                    )}
                  </p>
                </header>
                {shown.length === 0 ? (
                  <p className="px-6 py-10 text-center text-sm text-muted">
                    {saving.length === 0 && data.archived.some((g) => g.kind === 'save')
                      ? 'Every goal is put away.'
                      : saving.length === 0
                        ? 'No savings goals yet. Start one with New goal.'
                        : scope === 'mine'
                          ? 'You have no goals of your own.'
                          : 'No shared goals yet.'}
                  </p>
                ) : (
                  <ul className="divide-y divide-border" aria-label="Goals, by priority">
                    {shown.map((g) => {
                      const i = saving.findIndex((x) => x.id === g.id);
                      const editable = g.canEdit || g.claims.some((c) => c.yours);
                      return (
                        <li key={g.id}>
                          <GoalRow
                            householdId={householdId}
                            goal={g}
                            currency={currency}
                            members={members}
                            shared={shared}
                            onOpen={editable ? () => setEditing(g) : undefined}
                            onArchive={g.canEdit ? () => setArchiving(g) : undefined}
                            onDelete={g.canEdit ? () => setDeleting(g) : undefined}
                            onUp={data.canCreate && i > 0 ? () => move(g, -1) : undefined}
                            onDown={
                              data.canCreate && i < saving.length - 1 ? () => move(g, 1) : undefined
                            }
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              {data.accounts.length ? (
                <p className="px-1 text-sm text-muted">
                  {formatMoney(data.totals.unclaimedMinor, currency)} in your savings and investment
                  accounts isn’t earmarked for any goal.
                </p>
              ) : null}
              <p className="px-1 text-xs text-muted">
                Goals are in priority order. When an account falls short, the lowest gives way
                first, and only when its owners say so. Status and dates are estimates from each
                goal’s monthly plan and today’s balances, so they move as those do.
              </p>
            </TabPanel>
            <TabPanel id="pay_down" className="space-y-5">
              <PayDown
                householdId={householdId}
                data={data}
                goals={ofKind('pay_down')}
                currency={currency}
                members={members}
                shared={shared}
                onEdit={setEditing}
                onArchive={setArchiving}
                onDelete={setDeleting}
                onManage={() => setManaging(true)}
              />
            </TabPanel>
            {archived.length ? (
              <div className="overflow-hidden rounded-xl border border-border bg-surface">
                <button
                  type="button"
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived((v) => !v)}
                  className="flex w-full items-center gap-2 px-4 py-3 text-sm text-muted hover:text-fg sm:px-5"
                >
                  {showArchived ? (
                    <EyeOff aria-hidden className="size-4" />
                  ) : (
                    <Eye aria-hidden className="size-4" />
                  )}
                  {showArchived ? 'Hide' : 'Show'} {archived.length} archived{' '}
                  {archived.length === 1 ? 'goal' : 'goals'}
                </button>
                {showArchived ? (
                  <ul
                    className="divide-y divide-border border-t border-border"
                    aria-label="Archived goals"
                  >
                    {archived.map((g) => (
                      <li key={g.id} className="opacity-75">
                        <GoalRow
                          householdId={householdId}
                          goal={g}
                          currency={currency}
                          members={members}
                          shared={shared}
                          onRestore={
                            g.canEdit ? () => archive.mutate({ g, archived: false }) : undefined
                          }
                          onDelete={g.canEdit ? () => setDeleting(g) : undefined}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </Tabs>
        )}
      </div>
      {editing && editing !== 'new' && editing.kind === 'pay_down' ? (
        <DebtDialog
          householdId={householdId}
          goal={editing}
          currency={currency}
          onClose={() => setEditing(null)}
        />
      ) : editing && data ? (
        <GoalDialog
          householdId={householdId}
          goal={editing === 'new' ? null : editing}
          accounts={data.accounts}
          members={members}
          shared={shared}
          currency={currency}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {managing && data ? (
        <ManageDebts
          householdId={householdId}
          data={data}
          shared={shared}
          currency={currency}
          onClose={() => setManaging(false)}
        />
      ) : null}
      {resolving && data ? (
        <GiveWayDialog
          householdId={householdId}
          shortfall={resolving}
          currency={currency}
          onClose={() => setResolving(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete goal"
          destructive
          isOpen
          onOpenChange={(open) => (open ? null : setDeleting(null))}
          onConfirm={() => remove.mutateAsync(deleting)}
        >
          {deleting.kind === 'pay_down'
            ? 'Its history goes. The debt and its account stay as they are.'
            : 'Its claims end and its history goes. The money stays in its accounts, unclaimed.'}
        </ConfirmDialog>
      ) : null}
      {archiving ? (
        <ConfirmDialog
          title={`Put ${archiving.name} away?`}
          confirmLabel="Archive goal"
          isOpen
          onOpenChange={(open) => (open ? null : setArchiving(null))}
          onConfirm={() => archive.mutateAsync({ g: archiving, archived: true })}
        >
          {archiving.kind === 'pay_down' ? (
            <>
              It moves to archived goals, showing the{' '}
              {formatMoney(archiving.progressMinor, currency)} it had paid down. The debt stays
              where it is. Bring it back any time.
            </>
          ) : (
            <>
              It moves to archived goals, showing the{' '}
              {formatMoney(archiving.progressMinor, currency)} it had. Its claims end, so that money
              is unclaimed again. Bring it back any time; it starts without accounts.
            </>
          )}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Walkthrough §11: what a goal is, and how much is there to draw on. */
function Empty({
  data,
  currency,
  onNew,
}: {
  data: GoalsOverview;
  currency: string;
  onNew: () => void;
}) {
  return (
    <EmptyState icon={GoalIcon} title="Save up for something">
      <p className="text-sm text-muted">
        A goal draws on money in your accounts, all of one or part of it, so it’s always as real as
        the balances behind it. Give it a date, and Fiscus works out what to put in each month.
      </p>
      {data.accounts.length ? (
        <p className="text-sm text-muted">
          You have {formatMoney(data.totals.unclaimedMinor, currency)} in savings and investment
          accounts that no goal has earmarked yet.
        </p>
      ) : (
        <p className="text-sm text-muted">
          Add a savings account first, or start a goal and fund it later.
        </p>
      )}
      {data.canCreate ? <Button onPress={onNew}>New goal</Button> : null}
    </EmptyState>
  );
}

interface ClaimDraft {
  on: boolean;
  kind: 'amount' | 'percent';
  amountMinor: number | null;
  percent: string;
}

/**
 * A new claim starts as the whole account: 100%, so it grows and falls with the balance. When
 * other goals already have part of it, all that's still free, as its share of the balance.
 */
function wholeAccount(a: GoalAccount): ClaimDraft {
  const off = { on: false, amountMinor: null };
  if (a.unclaimedMinor >= a.balanceMinor) return { ...off, kind: 'percent', percent: '100' };
  if (a.unclaimedMinor <= 0) return { ...off, kind: 'amount', percent: '' };
  const bps = Math.floor((a.unclaimedMinor * 10_000) / a.balanceMinor);
  return { ...off, kind: 'percent', percent: String(bps / 100) };
}

/**
 * New goal, or changing one (walkthrough §2): its name, whose, target, date and plan, and the
 * accounts it draws on. Claims are yours to set on accounts you own (G7); another's show as they
 * are.
 */
function GoalDialog({
  householdId,
  goal,
  accounts,
  members,
  shared,
  currency,
  onClose,
}: {
  householdId: string;
  goal: Goal | null;
  accounts: GoalAccount[];
  members: HouseholdMember[];
  shared: boolean;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const canEdit = goal === null || goal.canEdit;
  const [name, setName] = useState(goal?.name ?? '');
  const [scope, setScope] = useState<'household' | 'mine'>(
    goal?.scope ?? (shared ? 'household' : 'mine'),
  );
  const [target, setTarget] = useState<number | null>(goal?.targetMinor ?? null);
  const [date, setDate] = useState<string | null>(goal?.targetDate ?? null);
  const [plan, setPlan] = useState<number | null>(goal?.planMinor ?? null);
  const [icon, setIcon] = useState<GoalIconName | null>(goal?.icon ?? null);
  const [color, setColor] = useState<string | null>(goal?.color ?? null);
  // A photo chosen and not yet sent, or the one it has taken off; null: as it was.
  const [photo, setPhoto] = useState<{ previewUrl: string; dataBase64: string } | 'remove' | null>(
    null,
  );
  const shownPhoto =
    photo === 'remove'
      ? null
      : (photo?.previewUrl ?? (goal ? lookOf(householdId, goal).photo : null));
  const choosePhoto = (file: File) =>
    shrinkPhoto(file).then(setPhoto, () =>
      toast('That photo couldn’t be read', {
        tone: 'error',
        description: 'Choose a JPEG, PNG or WebP picture.',
      }),
    );
  // Picking an icon or a color means the icon shows: the photo goes.
  const plain = () => setPhoto(shownPhoto ? 'remove' : null);
  const existing = new Map(goal?.claims.map((c) => [c.accountId, c]));
  const [claims, setClaims] = useState<Record<string, ClaimDraft>>(() =>
    Object.fromEntries(
      accounts.map((a) => {
        const c = existing.get(a.accountId);
        return [
          a.accountId,
          c
            ? {
                on: true,
                kind: c.percentBps !== null ? 'percent' : 'amount',
                amountMinor: c.amountMinor,
                percent: c.percentBps ? String(c.percentBps / 100) : '',
              }
            : wholeAccount(a),
        ];
      }),
    ),
  );
  const others = goal?.claims.filter((c) => !c.yours) ?? [];
  const set = (id: string, patch: Partial<ClaimDraft>) =>
    setClaims((all) => ({ ...all, [id]: { ...all[id]!, ...patch } }));
  const claimBody = (d: ClaimDraft) =>
    d.kind === 'percent'
      ? { percentBps: Math.round(Number(d.percent) * 100) }
      : { amountMinor: d.amountMinor ?? 0 };
  const worth = (a: GoalAccount, d: ClaimDraft) =>
    d.kind === 'percent'
      ? Math.floor((a.balanceMinor * Math.round(Number(d.percent) * 100)) / 10_000)
      : (d.amountMinor ?? 0);

  // What it would have, and what makes its date: from this month to the date's month.
  const funded =
    accounts.reduce(
      (s, a) => s + (claims[a.accountId]!.on ? worth(a, claims[a.accountId]!) : 0),
      0,
    ) + others.reduce((s, c) => s + c.valueMinor, 0);
  const months = (() => {
    if (!date) return null;
    const now = new Date();
    const [y, m] = date.split('-').map(Number) as [number, number];
    const n = (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth()) + 1;
    return n >= 1 ? n : null;
  })();
  const toMake = target && months ? Math.max(0, Math.ceil((target - funded) / months)) : null;

  const save = useMutation({
    mutationFn: async () => {
      const chosen = accounts.filter((a) => claims[a.accountId]!.on);
      const sendPhoto = async (goalId: string) => {
        const url = `${base(householdId)}/goals/${goalId}/image`;
        if (photo === 'remove') await api('DELETE', url);
        else if (photo) {
          await api('PUT', url, { body: { type: 'image/jpeg', dataBase64: photo.dataBase64 } });
        }
      };
      if (!goal) {
        const made = await api<{ data: Goal }>('POST', `${base(householdId)}/goals`, {
          body: {
            name,
            ...(shared ? { scope } : {}),
            targetMinor: target,
            targetDate: date,
            planMinor: plan,
            icon,
            color,
            claims: chosen.map((a) => ({
              accountId: a.accountId,
              ...claimBody(claims[a.accountId]!),
            })),
          },
        });
        await sendPhoto(made.data.id);
        return;
      }
      if (canEdit) {
        const patch = {
          ...(name !== goal.name ? { name } : {}),
          ...(target !== goal.targetMinor ? { targetMinor: target } : {}),
          ...(date !== goal.targetDate ? { targetDate: date } : {}),
          ...(plan !== goal.planMinor ? { planMinor: plan } : {}),
          ...(icon !== goal.icon ? { icon } : {}),
          ...(color !== goal.color ? { color } : {}),
        };
        if (Object.keys(patch).length) {
          await api('PATCH', `${base(householdId)}/goals/${goal.id}`, {
            body: patch,
            headers: { 'if-match': `"v${goal.version}"` },
          });
        }
        await sendPhoto(goal.id);
      }
      for (const a of accounts) {
        const d = claims[a.accountId]!;
        const had = existing.get(a.accountId);
        const url = `${base(householdId)}/goals/${goal.id}/claims/${a.accountId}`;
        if (!d.on && had) await api('DELETE', url);
        else if (d.on) {
          const body = claimBody(d);
          const same =
            had &&
            (('percentBps' in body && had.percentBps === body.percentBps) ||
              ('amountMinor' in body && had.amountMinor === body.amountMinor));
          if (!same) await api('PUT', url, { body });
        }
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'goals'] });
      // Its plan is its budget line (G16).
      void queryClient.invalidateQueries({ queryKey: ['households', householdId, 'budgets'] });
      toast(goal ? `${name} saved.` : `${name} created.`);
      onClose();
    },
    onError: () =>
      queryClient.invalidateQueries({ queryKey: ['households', householdId, 'goals'] }),
  });
  const err = save.error as ApiError | null;
  const valid =
    name.trim() &&
    target &&
    target > 0 &&
    accounts.every((a) => {
      const d = claims[a.accountId]!;
      if (!d.on) return true;
      return d.kind === 'percent'
        ? Number(d.percent) > 0 && Number(d.percent) <= 100
        : (d.amountMinor ?? 0) > 0;
    });

  return (
    <Dialog
      title={goal ? goal.name : 'New goal'}
      size="lg"
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <PicturePicker
          look={{ icon, color, photo: shownPhoto }}
          isDisabled={!canEdit}
          onIcon={(i) => {
            setIcon(i);
            plain();
          }}
          onColor={(c) => {
            setColor(c);
            plain();
          }}
          onPhoto={(file) => void choosePhoto(file)}
          onRemovePhoto={() => setPhoto(goal?.imageVersion ? 'remove' : null)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Name"
            value={name}
            onChange={setName}
            isDisabled={!canEdit}
            placeholder="A trip, a house, a cushion"
          />
          {shared && !goal ? (
            <RadioGroup
              label="Whose"
              value={scope}
              onChange={(v) => setScope(v as typeof scope)}
              orientation="horizontal"
            >
              <Radio value="household">Ours</Radio>
              <Radio value="mine">Mine, only you see it</Radio>
            </RadioGroup>
          ) : null}
          <AmountInput
            label="Target"
            currency={currency}
            value={target}
            onChange={setTarget}
            isDisabled={!canEdit}
          />
          <DatePicker
            label="By (optional)"
            value={date ?? undefined}
            onChange={setDate}
            isDisabled={!canEdit}
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">
            Funded by{' '}
            <span className="font-normal text-muted">· money already there counts as progress</span>
          </p>
          {accounts.length === 0 && others.length === 0 ? (
            <p className="text-sm text-muted">
              You have no savings or investment accounts of your own. A goal can start without one,
              and draw on one later.
            </p>
          ) : null}
          <ul className="divide-y divide-border rounded-xl border border-border">
            {accounts.map((a) => {
              const d = claims[a.accountId]!;
              const had = existing.get(a.accountId);
              // What's free for this goal: what no goal has, plus what this one has already.
              const free = a.unclaimedMinor + (had?.valueMinor ?? 0);
              const over = d.on && worth(a, d) > free;
              return (
                <li key={a.accountId} className="space-y-2 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <Switch isSelected={d.on} onChange={(on) => set(a.accountId, { on })}>
                      <span className="font-medium">{a.name}</span>
                    </Switch>
                    <span className="text-xs text-muted">
                      {formatMoney(a.balanceMinor, currency)} · {formatMoney(free, currency)} free
                    </span>
                  </div>
                  {d.on ? (
                    <div className="flex flex-wrap items-end gap-2 pl-1">
                      <SegmentedControl
                        aria-label={`${a.name}: a fixed amount or a percentage`}
                        options={[
                          { value: 'amount', label: 'Amount' },
                          { value: 'percent', label: 'Percent' },
                        ]}
                        value={d.kind}
                        onChange={(kind) => set(a.accountId, { kind })}
                      />
                      {d.kind === 'amount' ? (
                        <AmountInput
                          aria-label={`${a.name}: amount for this goal`}
                          currency={currency}
                          value={d.amountMinor}
                          onChange={(amountMinor) => set(a.accountId, { amountMinor })}
                          className="w-36"
                        />
                      ) : (
                        <TextField
                          aria-label={`${a.name}: percent for this goal`}
                          value={d.percent}
                          inputMode="decimal"
                          onChange={(percent) =>
                            set(a.accountId, { percent: percent.replace(/[^0-9.]/g, '') })
                          }
                          className="w-24"
                        />
                      )}
                      {over ? (
                        <span className="text-xs text-danger">
                          {a.name} has {formatMoney(free, currency)} free for this goal.
                        </span>
                      ) : d.kind === 'percent' && d.percent ? (
                        <span className="text-xs text-muted">
                          {formatMoney(worth(a, d), currency)} now; it grows and falls with the
                          balance
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
            {others.map((c) => (
              <li key={c.accountId} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">{claimLabel(c, members)}</span>
                <span className="text-muted">{claimAmount(c, currency)}</span>
                <span className="text-xs text-muted">its owners change it</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <AmountInput
            label="Each month (optional)"
            currency={currency}
            value={plan}
            onChange={setPlan}
            isDisabled={!canEdit}
          />
          {toMake !== null && date ? (
            <p className="text-sm text-muted">
              {toMake === 0 ? (
                'It’s funded already.'
              ) : (
                <>
                  To make {monthYear(date)}: <b>{formatMoney(toMake, currency)} a month</b>.{' '}
                  {canEdit && plan !== toMake ? (
                    <button
                      type="button"
                      className="font-medium text-accent-text underline"
                      onClick={() => setPlan(toMake)}
                    >
                      Use it
                    </button>
                  ) : null}
                </>
              )}
            </p>
          ) : null}
        </div>
        {shared && scope === 'household' ? (
          <p className="text-xs text-muted">
            Everyone in the household sees this goal. A claim on an account they can’t see shows
            only the claim, never its balance.
          </p>
        ) : null}
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button isDisabled={!valid} isPending={save.isPending} onPress={() => save.mutate()}>
            {goal ? 'Save' : 'Create goal'}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

/**
 * A shortfall (walkthrough §5, G3, G19): take it from one goal, split it by their claims, or leave
 * it short. Priority suggests; nothing moves until you choose.
 */
function GiveWayDialog({
  householdId,
  shortfall: s,
  currency,
  onClose,
}: {
  householdId: string;
  shortfall: GoalShortfall;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const money = (minor: number) => formatMoney(minor, currency);
  const total = s.goals.reduce((sum, g) => sum + g.amountMinor, 0);
  // Split by claims: each its share, the last one taking what rounding left.
  const split = s.goals.map((g, i, all) => ({
    goalId: g.goalId,
    amountMinor:
      i === all.length - 1
        ? s.shortMinor -
          all
            .slice(0, -1)
            .reduce((sum, x) => sum + Math.floor((s.shortMinor * x.amountMinor) / total), 0)
        : Math.floor((s.shortMinor * g.amountMinor) / total),
  }));
  const options: {
    id: string;
    title: string;
    detail: string;
    take: GoalShortfall['suggestion'];
  }[] = [
    {
      id: 'suggested',
      title:
        s.suggestion.length === 1
          ? `Take it from ${s.goals.find((g) => g.goalId === s.suggestion[0]!.goalId)?.name}`
          : 'Take it from the lowest priorities',
      detail: s.suggestion
        .map((t) => `${s.goals.find((g) => g.goalId === t.goalId)?.name} −${money(t.amountMinor)}`)
        .join(', '),
      take: s.suggestion,
    },
    ...s.goals
      .filter((g) => g.amountMinor >= s.shortMinor)
      .filter((g) => !(s.suggestion.length === 1 && s.suggestion[0]!.goalId === g.goalId))
      .map((g) => ({
        id: g.goalId,
        title: `Take it from ${g.name}`,
        detail: `${money(g.amountMinor)} → ${money(g.amountMinor - s.shortMinor)}`,
        take: [{ goalId: g.goalId, amountMinor: s.shortMinor }],
      })),
    ...(s.goals.length > 1
      ? [
          {
            id: 'split',
            title: 'Split it by their claims',
            detail: split
              .map(
                (t) =>
                  `${s.goals.find((g) => g.goalId === t.goalId)?.name} −${money(t.amountMinor)}`,
              )
              .join(', '),
            take: split.filter((t) => t.amountMinor > 0),
          },
        ]
      : []),
  ];
  const [choice, setChoice] = useState('suggested');
  const save = useMutation({
    mutationFn: () =>
      api('POST', `${base(householdId)}/goals/give-way`, {
        body: { accountId: s.accountId, take: options.find((o) => o.id === choice)!.take },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'goals'] });
      toast('Done. The goals show what’s really there.');
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  return (
    <Dialog
      title={`${s.accountName ?? 'The account'} is ${money(s.shortMinor)} short`}
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <p className="text-sm text-muted">
          Goals have more of it earmarked than it holds. Nothing moves until you choose; the
          suggestion follows priority.
        </p>
        <RadioGroup label="Which goal gives way" value={choice} onChange={setChoice}>
          {options.map((o) => (
            <Radio key={o.id} value={o.id}>
              <span className="block font-medium">
                {o.title}
                {o.id === 'suggested' ? <Badge className="ml-2">Suggested</Badge> : null}
              </span>
              <span className="block text-xs text-muted">{o.detail}</span>
            </Radio>
          ))}
        </RadioGroup>
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Leave it short for now
          </Button>
          <Button isPending={save.isPending} onPress={() => save.mutate()}>
            Give way
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
