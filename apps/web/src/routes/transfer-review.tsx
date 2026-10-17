// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BulkUpdateResult,
  CategoryGroup,
  HouseholdMember,
  LinkTransfersResult,
  TransferReview,
  TransferReviewTransaction,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCheck, ChevronDown, ChevronRight, Info, Link2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { transferReviewQuery } from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  controlStyles,
  DateText,
  LoadingRegion,
  Skeleton,
  toast,
} from '../components/ui.js';
import {
  andList,
  groupSuggestions,
  groupUnmatched,
  type Hint,
  hints,
  lookAlikes,
  type SuggestionGroup,
  withoutTransactions,
} from '../lib/transfers.js';
import { categoryIndex } from '../lib/transactions.js';
import { CategorySelect, TransactionDrawer, useInvalidateLedger } from './transactions.js';

type Data<T> = { data: T };

const accountOf = (t: TransferReviewTransaction) => t.account.name;

/** What this check is for: a reconciliation, so nothing falls through the cracks. */
function WhyTransfers() {
  return (
    <details className="group rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-sm">
      <summary className="cursor-pointer font-medium marker:text-muted">
        Why check transfers?
      </summary>
      <div className="mt-2 space-y-1 text-muted">
        <p>
          Money moving between your own accounts isn’t spending or income, so transfers are left out
          of your totals. That only works when each one really is a transfer: every transfer should
          have its other side, the same amount arriving in another of your accounts, or go to an
          account you don’t track here.
        </p>
        <p>
          One with no other side is worth a look: the money may not have arrived, or it may be
          spending filed as a transfer (a payment to a friend, someone else’s card), which quietly
          drops out of what you spent.
        </p>
      </div>
    </details>
  );
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const apart = (from: string, to: string) => {
  const d = daysBetween(from, to);
  if (d === 0) return 'same day';
  const n = Math.abs(d);
  return `${n} ${n === 1 ? 'day' : 'days'} ${d > 0 ? 'later' : 'earlier'}`;
};

type SuggestionData = TransferReview['suggested'][number];

/** Why a pair wasn't linked automatically, in words. */
function reasonText(
  { reason, transaction: out, candidates, rivals }: SuggestionData,
  hint: Hint | null,
): string {
  const first = candidates[0]!;
  switch (reason) {
    case 'identical':
      return `Identical transfers, like round-ups: any pairing is right, so “Link the clear pairs” takes them.`;
    case 'several': {
      // Same day and amount in different accounts (Roth IRA, Brokerage): only you know (#332).
      const alike = hint ? null : lookAlikes(candidates, out.date);
      if (alike) {
        return `The same amount on the same day into ${andList(alike)}. Nothing in the names says which it went to, so link the one it really did.`;
      }
      return hint?.label === 'closest date'
        ? `${candidates.length} possible matches, like a recurring transfer; this one is the closest date both ways.`
        : hint
          ? `${candidates.length} possible matches, and the names point to this one. Linking one can settle others.`
          : `${candidates.length} possible matches: link the one that’s really the other side. Linking one can settle others.`;
    }
    case 'rivals': {
      const r = rivals[0]!;
      const more = rivals.length > 1 ? ` and ${rivals.length - 1} more` : '';
      return `The only match, but it could also be the other side of ${accountOf(r)}’s ${r.displayName} (${formatDay(r.date)})${more}.`;
    }
    case 'far_apart':
      return `${Math.abs(daysBetween(out.date, first.date))} days apart, more than the 3 business days Fiscus links on its own.`;
    case 'one_match':
      return 'The only match either way, so “Link the clear pairs” takes it.';
  }
}

const formatDay = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Identical round-ups show once, with how many: same account, amount, day, and name going out,
 * and the same identical candidates. Linking one links one pair; "Link the clear pairs" takes all.
 */
function mergeIdentical(list: SuggestionData[]): { suggestion: SuggestionData; count: number }[] {
  const key = (x: SuggestionData) =>
    x.reason === 'identical'
      ? `${x.transaction.account.id}|${x.transaction.date}|${x.transaction.amountMinor}|${x.transaction.displayName.toLowerCase()}`
      : x.transaction.id;
  return [...Map.groupBy(list, key).values()].map((group) => ({
    suggestion: group[0]!,
    count: group.length,
  }));
}

/** "3 transfers linked, and 2 more they settled." */
function linkedText(linked: number, settled: number): string {
  const head =
    linked === 1
      ? 'Linked as a transfer'
      : `${linked} ${linked === 1 ? 'transfer' : 'transfers'} linked`;
  return settled
    ? `${head}, and ${settled} more ${linked === 1 ? 'it' : 'they'} settled.`
    : `${head}.`;
}

/** Opens and closes a group of the review. */
function GroupToggle({
  open,
  onToggle,
  controls,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <ChevronRight
        aria-hidden
        className={`size-4 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`}
      />
      {children}
    </button>
  );
}

/**
 * A suggested pair, flat enough to read on a phone (#332): the money going out, then its best
 * match (the one a hint points to, else the closest date) with the others a tap away, and why it
 * wasn't linked automatically. Each side names its account, since the group's heading scrolls away
 * and banks name transfers after accounts ("From Checking Balance"). **Don't link**
 * offers the ways out the rows with no other side have: it was spending, or its other side is in an
 * account outside Fiscus.
 */
function Suggestion({
  suggestion,
  count,
  hint,
  onLink,
  linking,
  groups: categories,
  names,
  onRecategorize,
  onOutside,
}: {
  suggestion: SuggestionData;
  /** Identical transfers out shown as this one. */
  count: number;
  hint: Hint | null;
  onLink: (into: string) => void;
  linking: string | null;
  groups: CategoryGroup[];
  names: Map<string, string>;
  onRecategorize: (categoryId: string) => void;
  onOutside: () => void;
}) {
  const [more, setMore] = useState(false);
  const [declining, setDeclining] = useState(false);
  const out = suggestion.transaction;
  const same = (c: TransferReviewTransaction) =>
    `${c.account.id}|${c.date}|${c.amountMinor}|${c.displayName.toLowerCase()}`;
  // The hinted one first; the rest keep their order (nearest date first).
  const groups = [...Map.groupBy(suggestion.candidates, same).values()].sort(
    (a, b) => Number(b[0]!.id === hint?.id) - Number(a[0]!.id === hint?.id),
  );
  const shown = more ? groups : groups.slice(0, 1);
  return (
    <li className="space-y-2 px-3 py-3">
      <div className="flex items-baseline gap-3 text-sm">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {out.displayName}
            {count > 1 ? <span className="font-normal text-muted"> ×{count} identical</span> : null}
          </span>
          <span className="block text-xs text-muted">
            Out of <span className="font-medium text-fg">{accountOf(out)}</span> ·{' '}
            <DateText value={out.date} />
          </span>
        </span>
        <Amount minor={out.amountMinor} currency={out.currency} className="shrink-0 font-medium" />
      </div>
      <ul aria-label={`Possible other sides of ${out.displayName}`} className="space-y-1.5">
        {shown.map((group) => {
          const c = group[0]!;
          return (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded-lg bg-surface-2 py-2 pr-2 pl-3 text-sm"
            >
              <ArrowRight aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{c.displayName}</span>
                <span className="block text-xs text-muted">
                  Into <span className="font-medium text-fg">{accountOf(c)}</span> ·{' '}
                  <DateText value={c.date} /> · {apart(out.date, c.date)}
                  {group.length > 1 ? ` · ×${group.length} identical` : ''}
                </span>
                {c.id === hint?.id ? (
                  <Badge tone="accent" className="mt-1">
                    Likely: {hint.label}
                  </Badge>
                ) : null}
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="shrink-0"
                aria-label={`Link ${accountOf(out)} ${out.displayName} ${out.date} to ${accountOf(c)} ${c.displayName} ${c.date}`}
                onPress={() => onLink(c.id)}
                isPending={linking === c.id}
              >
                <Link2 aria-hidden className="size-4" /> Link
              </Button>
            </li>
          );
        })}
      </ul>
      {groups.length > 1 && !more ? (
        <Button variant="ghost" size="sm" onPress={() => setMore(true)}>
          Show {groups.length - 1} other {groups.length === 2 ? 'match' : 'matches'}
        </Button>
      ) : null}
      <p className="flex gap-1.5 text-xs text-muted">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {reasonText(suggestion, hint)}
      </p>
      {declining ? (
        <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <p className="text-muted">
            If it isn’t a transfer, give it its real category. If its other side is in an account
            you don’t track here, it goes outside Fiscus, and the review stops asking.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-48">
              <RowCategory groups={categories} names={names} t={out} onChange={onRecategorize} />
            </div>
            <Button size="sm" variant="secondary" onPress={onOutside}>
              Outside Fiscus
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Don’t link ${out.displayName} ${out.date}`}
          onPress={() => setDeclining(true)}
        >
          Don’t link
        </Button>
      )}
    </li>
  );
}

/**
 * A row's category: a plain button until it's pressed, then the picker, open (#332). Each picker
 * holds every category, and an account's transfers with no other side can run to hundreds of rows.
 */
function RowCategory({
  groups,
  names,
  t,
  onChange,
}: {
  groups: CategoryGroup[];
  names: Map<string, string>;
  t: TransferReviewTransaction;
  onChange: (categoryId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const label = `Recategorize ${t.displayName}`;
  if (picking) {
    return (
      <CategorySelect
        groups={groups}
        label={label}
        hideLabel
        value={t.categoryId}
        onChange={onChange}
        autoOpen
      />
    );
  }
  const name = names.get(t.categoryId ?? '') ?? 'Uncategorized';
  return (
    // Drawn like the picker's own button, so nothing moves when it takes over.
    <button
      type="button"
      aria-label={`${name} ${label}`}
      onClick={() => setPicking(true)}
      className={`${controlStyles} flex items-center gap-2 text-left`}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <ChevronDown aria-hidden className="size-4 text-muted" />
    </button>
  );
}

/**
 * The transfer review (docs/design/transfers.md §2): pairs detection didn't link, to confirm, and
 * transfers with no other side, which are money in transit, a payment to an account outside
 * Fiscus, or spending filed as a transfer.
 */
export function TransferReviewList({
  householdId,
  members,
  groups,
}: {
  householdId: string;
  members: HouseholdMember[];
  groups: CategoryGroup[];
}) {
  const query = useQuery(transferReviewQuery(householdId));
  const queryClient = useQueryClient();
  const invalidateLedger = useInvalidateLedger(householdId);
  // Refetches in the background: the list has already changed (`drop`), and the refetch brings in
  // anything the change settled or unblocked.
  const invalidate = () => void invalidateLedger();
  /** Takes transactions off the list at once, without waiting for the review to be worked out. */
  const drop = async (ids: string[]) => {
    const key = transferReviewQuery(householdId).queryKey;
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData(key, (r) => (r ? withoutTransactions(r, new Set(ids)) : r));
  };
  const base = `/api/v1/households/${householdId}/transactions`;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const onError = (e: unknown) => {
    toast((e as ApiError).title, { tone: 'error' });
    invalidate();
  };

  // Undo unlinks every transfer a link made, the ones it settled too (#332).
  const unlink = useMutation({
    mutationFn: (groups: string[]) =>
      api<Data<{ unlinked: number }>>('POST', `${base}/transfer-review/unlink`, {
        body: { groups },
      }),
    onSuccess: (r) => {
      invalidate();
      toast(
        `Undone: ${r.data.unlinked} ${r.data.unlinked === 1 ? 'transfer' : 'transfers'} unlinked.`,
      );
    },
    onError,
  });
  const undoable = (groups: string[]) =>
    groups.length ? { actions: [{ label: 'Undo', onAction: () => unlink.mutate(groups) }] } : {};

  const link = useMutation({
    mutationFn: ({ out, into }: { out: string; into: string }) =>
      api<{ meta: { settled: number; groups: string[] } }>('POST', `${base}/${out}/transfer`, {
        body: { transactionId: into },
      }),
    onMutate: ({ out, into }) => drop([out, into]),
    onSuccess: (r) => {
      invalidate();
      toast(linkedText(1, r.meta.settled), undoable(r.meta.groups));
    },
    onError,
  });
  // A group's clear and likely pairs (#332), once confirmed.
  const linkGroup = useMutation({
    mutationFn: (pairs: { out: string; into: string }[]) =>
      api<Data<LinkTransfersResult>>('POST', `${base}/transfer-review/link`, { body: { pairs } }),
    onMutate: (pairs) => drop(pairs.flatMap((p) => [p.out, p.into])),
    onSuccess: (r) => {
      setConfirming(null);
      invalidate();
      const { linked, settled, refused, groups } = r.data;
      toast(linkedText(linked, settled), {
        ...undoable(groups),
        ...(refused.length
          ? { description: `${refused.length} couldn’t be linked; they stay on the list.` }
          : {}),
      });
    },
    onError,
  });
  const [confirming, setConfirming] = useState<SuggestionGroup | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpenGroups((open) => {
      const next = new Set(open);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const linkAll = useMutation({
    mutationFn: () =>
      api<Data<{ linked: number; groups: string[] }>>('POST', `${base}/transfer-review/link-all`),
    onSuccess: (r) => {
      invalidate();
      toast(
        `${r.data.linked} ${r.data.linked === 1 ? 'transfer' : 'transfers'} linked.`,
        undoable(r.data.groups),
      );
    },
    onError,
  });
  const patch = useMutation({
    mutationFn: ({ t, body }: { t: TransferReviewTransaction; body: Record<string, unknown> }) =>
      api('PATCH', `${base}/${t.id}`, { body, headers: { 'if-match': `"v${t.version}"` } }),
    // Outside Fiscus takes it off the list; a new category may too, which the refetch shows.
    onMutate: ({ t, body }) => (body.transferExternal ? drop([t.id]) : undefined),
    onSuccess: invalidate,
    onError,
  });
  const external = useMutation({
    mutationFn: (ids: string[]) =>
      api<Data<BulkUpdateResult>>('PATCH', base, {
        body: { ids, changes: { transferExternal: true } },
      }),
    onMutate: (ids) => drop(ids),
    onSuccess: (r) => {
      setSelected(new Set());
      invalidate();
      toast(`${r.data.updated.length} marked as going outside Fiscus.`);
    },
    onError,
  });

  if (query.isPending) {
    return (
      <LoadingRegion label="Checking transfers">
        <Skeleton className="h-32" />
      </LoadingRegion>
    );
  }
  if (query.isError) return <Alert>Couldn’t check transfers. Try again in a moment.</Alert>;
  const { suggested, unmatched, counts } = query.data;
  // What points to each pair's other side: the names, or the closest date both ways.
  const hinted = hints(suggested);
  const { names } = categoryIndex(groups);
  if (suggested.length === 0 && unmatched.length === 0) {
    return (
      <div className="space-y-6">
        <WhyTransfers />
        <EmptyState icon={CheckCheck} title="Transfers add up">
          <p>
            Every transfer between your accounts has its other side, or goes to an account outside
            Fiscus.
          </p>
        </EmptyState>
      </div>
    );
  }

  const allSelected = unmatched.length > 0 && unmatched.every((t) => selected.has(t.id));
  return (
    <div className="space-y-8">
      <WhyTransfers />
      {suggested.length ? (
        <section aria-labelledby="suggested-transfers" className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="suggested-transfers" className="mr-auto text-base font-semibold">
              Suggested pairs ({counts.suggested})
            </h2>
            {counts.unique ? (
              <Button
                variant="secondary"
                size="sm"
                onPress={() => linkAll.mutate()}
                isPending={linkAll.isPending}
              >
                Link the {counts.unique} clear {counts.unique === 1 ? 'pair' : 'pairs'}
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted">
            Money out of one account and the same amount into another that Fiscus didn’t link on its
            own. Why is under each.
          </p>
          {/* By account pair (#332): a large import reads as a few groups, not hundreds of cards. */}
          <ul className="space-y-3">
            {groupSuggestions(suggested).map((g, _, all) => {
              const open = all.length === 1 || openGroups.has(g.key);
              return (
                <li key={g.key} className="rounded-xl border border-border bg-surface">
                  <div className="flex flex-wrap items-center gap-2 p-2">
                    <GroupToggle
                      open={open}
                      onToggle={() => toggle(g.key)}
                      controls={`group-${g.key}`}
                    >
                      <span className="font-medium">{g.from}</span>
                      <ArrowRight aria-hidden className="size-4 shrink-0 text-muted" />
                      <span className="font-medium">{g.to ?? 'more than one account'}</span>
                      <Badge>{g.items.length}</Badge>
                    </GroupToggle>
                    {g.ready.length ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="ml-auto"
                        onPress={() => setConfirming(g)}
                      >
                        <Link2 aria-hidden className="size-4" /> Link {g.ready.length}
                      </Button>
                    ) : null}
                  </div>
                  {open ? (
                    <ul
                      id={`group-${g.key}`}
                      className="divide-y divide-border border-t border-border"
                    >
                      {mergeIdentical(g.items).map(({ suggestion: s, count }) => (
                        <Suggestion
                          key={s.transaction.id}
                          suggestion={s}
                          count={count}
                          hint={hinted.get(s.transaction.id) ?? null}
                          onLink={(into) => link.mutate({ out: s.transaction.id, into })}
                          linking={link.isPending ? (link.variables?.into ?? null) : null}
                          groups={groups}
                          names={names}
                          onRecategorize={(categoryId) =>
                            categoryId !== s.transaction.categoryId &&
                            patch.mutate({ t: s.transaction, body: { categoryId } })
                          }
                          onOutside={() =>
                            patch.mutate({ t: s.transaction, body: { transferExternal: true } })
                          }
                        />
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {counts.suggested > suggested.length ? (
            <p className="text-sm text-muted">
              Showing the latest {suggested.length}; link these to see more.
            </p>
          ) : null}
          <ConfirmDialog
            isOpen={confirming !== null}
            onOpenChange={(isOpen) => !isOpen && setConfirming(null)}
            title={`Link ${confirming?.ready.length ?? 0} ${confirming?.ready.length === 1 ? 'pair' : 'pairs'}?`}
            confirmLabel="Link them"
            onConfirm={async () => {
              if (confirming) await linkGroup.mutateAsync(confirming.ready);
            }}
          >
            From {confirming?.from} to {confirming?.to ?? 'more than one account'}: the clear pairs
            and the likely ones (the names, or the closest date both ways). Pairs with more than one
            possible match stay for you to choose. You can undo it from the message that follows.
          </ConfirmDialog>
        </section>
      ) : null}

      {unmatched.length ? (
        <section aria-labelledby="unmatched-transfers" className="space-y-3">
          <h2 id="unmatched-transfers" className="text-base font-semibold">
            No other side ({counts.unmatched})
          </h2>
          <p className="text-sm text-muted">
            Filed as transfers, over a week old, with nothing coming into (or out of) another of
            your accounts. Either the other account isn’t in Fiscus, or it was really spending,
            which doesn’t count while it’s a transfer.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox
              isSelected={allSelected}
              isIndeterminate={selected.size > 0 && !allSelected}
              onChange={(on) => setSelected(on ? new Set(unmatched.map((t) => t.id)) : new Set())}
            >
              Select all shown
            </Checkbox>
            {selected.size ? (
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                onPress={() => external.mutate([...selected])}
                isPending={external.isPending}
              >
                {selected.size} go to accounts outside Fiscus
              </Button>
            ) : null}
          </div>
          {/* By account (#332), so a card's or a bank's unpaired transfers can be handled together. */}
          <ul className="space-y-3">
            {groupUnmatched(unmatched).map((g, _, all) => {
              const open = all.length === 1 || openGroups.has(`u:${g.key}`);
              const every = g.items.every((t) => selected.has(t.id));
              const some = g.items.some((t) => selected.has(t.id));
              return (
                <li key={g.key} className="rounded-xl border border-border bg-surface">
                  <div className="flex flex-wrap items-center gap-2 p-2">
                    <GroupToggle
                      open={open}
                      onToggle={() => toggle(`u:${g.key}`)}
                      controls={`unmatched-${g.key}`}
                    >
                      <span className="font-medium">{g.account}</span>
                      <Badge>{g.items.length}</Badge>
                    </GroupToggle>
                    <Checkbox
                      className="ml-auto"
                      isSelected={every}
                      isIndeterminate={some && !every}
                      onChange={(on) => {
                        const next = new Set(selected);
                        for (const t of g.items) {
                          if (on) next.add(t.id);
                          else next.delete(t.id);
                        }
                        setSelected(next);
                      }}
                    >
                      Select all {g.items.length}
                    </Checkbox>
                  </div>
                  {open ? (
                    <ul
                      id={`unmatched-${g.key}`}
                      className="divide-y divide-border border-t border-border"
                    >
                      {g.items.map((t) => (
                        <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                          <Checkbox
                            aria-label={`Select ${t.displayName}`}
                            isSelected={selected.has(t.id)}
                            onChange={(on) => {
                              const next = new Set(selected);
                              if (on) next.add(t.id);
                              else next.delete(t.id);
                              setSelected(next);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setOpen(t.id)}
                            className="min-w-40 flex-1 text-left text-sm"
                          >
                            <span className="font-medium">{t.displayName}</span>
                            <span className="block text-xs text-muted">
                              <DateText value={t.date} /> · {accountOf(t)}
                            </span>
                          </button>
                          <Amount minor={t.amountMinor} currency={t.currency} className="text-sm" />
                          <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
                            <div className="w-48">
                              <RowCategory
                                groups={groups}
                                names={names}
                                t={t}
                                onChange={(categoryId) =>
                                  categoryId !== t.categoryId &&
                                  patch.mutate({ t, body: { categoryId } })
                                }
                              />
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              onPress={() => patch.mutate({ t, body: { transferExternal: true } })}
                            >
                              Outside Fiscus
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
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
    </div>
  );
}
