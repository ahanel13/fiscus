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
  reviewCards,
  type SuggestionGroup,
  withoutTransactions,
} from '../lib/transfers.js';
import { useRangeSelect } from '../lib/range-select.js';
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

/**
 * Why a pair wasn't linked automatically, when the rows don't already say: the dates, the Likely
 * badge, and the choice itself carry the rest.
 */
function reasonText(
  { reason, transaction: out, candidates, rivals }: SuggestionData,
  hint: Hint | null,
): string | null {
  switch (reason) {
    case 'identical':
      return 'Identical transfers, like round-ups: any pairing is right, so “Link the clear pairs” takes them.';
    case 'several': {
      // Same day and amount in different accounts (Roth IRA, Brokerage): only you know (#332).
      const alike = hint ? null : lookAlikes(candidates, out.date);
      return alike
        ? `The same amount on the same day into ${andList(alike)}, and nothing in the names says which.`
        : null;
    }
    case 'rivals': {
      // Its rival is further down the list (or past the first thousand), so say it here.
      const r = rivals[0]!;
      const more = rivals.length > 1 ? ` and ${rivals.length - 1} more` : '';
      return `This deposit could also be from ${accountOf(r)}’s ${r.displayName} (${formatDay(r.date)})${more}.`;
    }
    case 'far_apart':
    case 'one_match':
      return null;
  }
}

const formatDay = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

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

type Linking = { out: string; into: string } | null;

/**
 * One side of a transfer (#332): which way the money went, the account (banks name transfers after
 * accounts, so the account is what tells sides apart), the amount, then when and what the bank
 * called it. `from` is the date it's compared to.
 */
function SideRow({
  dir,
  t,
  from,
  badge,
  action,
}: {
  dir: 'From' | 'To';
  t: TransferReviewTransaction;
  from?: string;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    // On a phone the Link button takes its own line, so the account and the bank's words, which
    // tell the sides apart, aren't cut off.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span className="w-9 shrink-0 self-start pt-0.5 text-xs font-semibold tracking-wide text-muted uppercase">
        {dir}
      </span>
      <span className="min-w-48 flex-1">
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 font-medium break-words">{accountOf(t)}</span>
          <Amount minor={t.amountMinor} currency={t.currency} className="shrink-0 font-medium" />
        </span>
        <span className="block text-xs break-words text-muted">
          <DateText value={t.date} />
          {from ? ` · ${apart(from, t.date)}` : ''} · {t.displayName}
        </span>
        {badge}
      </span>
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

function LinkButton({
  out,
  into,
  linking,
  onLink,
}: {
  out: TransferReviewTransaction;
  into: TransferReviewTransaction;
  linking: Linking;
  onLink: (out: string, into: string) => void;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      className="shrink-0"
      aria-label={`Link ${accountOf(out)} ${out.displayName} ${out.date} to ${accountOf(into)} ${into.displayName} ${into.date}`}
      onPress={() => onLink(out.id, into.id)}
      isPending={linking?.out === out.id && linking.into === into.id}
    >
      <Link2 aria-hidden className="size-4" /> Link
    </Button>
  );
}

/** The ways out of linking: it was spending, or its other side is outside Fiscus. */
function Decline({
  list,
  categories,
  names,
  onRecategorize,
  onOutside,
}: {
  list: TransferReviewTransaction[];
  categories: CategoryGroup[];
  names: Map<string, string>;
  onRecategorize: (t: TransferReviewTransaction, categoryId: string) => void;
  onOutside: (t: TransferReviewTransaction) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <p className="text-muted">
        If it isn’t a transfer, give it its real category. If its other side is in an account you
        don’t track here, it goes outside Fiscus, and the review stops asking.
      </p>
      {list.map((t) => (
        <div key={t.id} className="flex flex-wrap items-center gap-2">
          {list.length > 1 ? (
            <span className="min-w-40 flex-1 text-xs">
              <span className="font-medium">{t.displayName}</span> · <DateText value={t.date} />
            </span>
          ) : null}
          <div className="w-48">
            <RowCategory
              groups={categories}
              names={names}
              t={t}
              onChange={(categoryId) => onRecategorize(t, categoryId)}
            />
          </div>
          <Button size="sm" variant="secondary" onPress={() => onOutside(t)}>
            Outside Fiscus
          </Button>
        </div>
      ))}
    </div>
  );
}

const note = (text: string | null) =>
  text ? (
    <p className="flex gap-1.5 text-xs text-muted">
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {text}
    </p>
  ) : null;

/**
 * Money going out and its possible other sides (#332), flat enough to read on a phone. A pair is
 * one box, From and To. With several possible deposits, it asks which: the one a hint points to
 * first, the rest a tap away. **Don't link** offers what the rows with no other side have.
 */
function OutCard({
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
  onLink: (out: string, into: string) => void;
  linking: Linking;
  groups: CategoryGroup[];
  names: Map<string, string>;
  onRecategorize: (t: TransferReviewTransaction, categoryId: string) => void;
  onOutside: (t: TransferReviewTransaction) => void;
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
  const identical = count > 1 ? <Badge className="mt-1">×{count} identical</Badge> : null;
  const to = (group: TransferReviewTransaction[], withLink = true) => {
    const c = group[0]!;
    return (
      <SideRow
        dir="To"
        t={c}
        from={out.date}
        badge={
          c.id === hint?.id ? (
            <Badge tone="accent" className="mt-1">
              Likely: {hint.label}
            </Badge>
          ) : group.length > 1 ? (
            <Badge className="mt-1">×{group.length} identical</Badge>
          ) : null
        }
        action={
          withLink ? <LinkButton out={out} into={c} linking={linking} onLink={onLink} /> : null
        }
      />
    );
  };
  return (
    <li className="space-y-2 px-3 py-3">
      {groups.length === 1 ? (
        // A pair: both sides, then its Link, so the amounts line up.
        <div
          role="group"
          aria-label={`${out.displayName} and its other side`}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface-2 py-2 pr-2 pl-3"
        >
          <div className="min-w-0 flex-1 basis-80 space-y-2">
            <SideRow dir="From" t={out} badge={identical} />
            {to(groups[0]!, false)}
          </div>
          <span className="ml-auto">
            <LinkButton out={out} into={groups[0]![0]!} linking={linking} onLink={onLink} />
          </span>
        </div>
      ) : (
        <>
          <SideRow dir="From" t={out} badge={identical} />
          <p className="text-xs font-medium text-muted">Which deposit was it?</p>
          <ul aria-label={`Possible other sides of ${out.displayName}`} className="space-y-1.5">
            {shown.map((group) => (
              <li key={group[0]!.id} className="rounded-lg bg-surface-2 py-2 pr-2 pl-3">
                {to(group)}
              </li>
            ))}
          </ul>
          {!more ? (
            <Button variant="ghost" size="sm" onPress={() => setMore(true)}>
              Show {groups.length - 1} other {groups.length === 2 ? 'match' : 'matches'}
            </Button>
          ) : null}
        </>
      )}
      {note(reasonText(suggestion, hint))}
      {declining ? (
        <Decline
          list={[out]}
          categories={categories}
          names={names}
          onRecategorize={onRecategorize}
          onOutside={onOutside}
        />
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
 * A deposit that could be the other side of more than one transfer out (#332): one choice, led by
 * the deposit, rather than a card for each transfer pointing at the others.
 */
function InCard({
  into,
  options,
  hint,
  onLink,
  linking,
  groups: categories,
  names,
  onRecategorize,
  onOutside,
}: {
  into: TransferReviewTransaction;
  /** The likely one first, then the closest date. */
  options: SuggestionData[];
  hint: Hint | null;
  onLink: (out: string, into: string) => void;
  linking: Linking;
  groups: CategoryGroup[];
  names: Map<string, string>;
  onRecategorize: (t: TransferReviewTransaction, categoryId: string) => void;
  onOutside: (t: TransferReviewTransaction) => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [more, setMore] = useState(false);
  const outs = options.map((s) => s.transaction);
  // The closest few; a recurring transfer can have many the same amount within the window.
  const shown = more ? outs : outs.slice(0, 3);
  return (
    <li className="space-y-2 px-3 py-3">
      <SideRow dir="To" t={into} />
      <p className="text-xs font-medium text-muted">Which transfer out was it?</p>
      <ul aria-label={`Possible other sides of ${into.displayName}`} className="space-y-1.5">
        {shown.map((out) => (
          <li key={out.id} className="rounded-lg bg-surface-2 py-2 pr-2 pl-3">
            <SideRow
              dir="From"
              t={out}
              from={into.date}
              badge={
                out.id === hint?.id ? (
                  <Badge tone="accent" className="mt-1">
                    Likely: {hint.label}
                  </Badge>
                ) : null
              }
              action={<LinkButton out={out} into={into} linking={linking} onLink={onLink} />}
            />
          </li>
        ))}
      </ul>
      {outs.length > shown.length ? (
        <Button variant="ghost" size="sm" onPress={() => setMore(true)}>
          Show {outs.length - shown.length} more
        </Button>
      ) : null}
      {declining ? (
        <Decline
          list={outs}
          categories={categories}
          names={names}
          onRecategorize={onRecategorize}
          onOutside={onOutside}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Neither: don’t link ${into.displayName} ${into.date}`}
          onPress={() => setDeclining(true)}
        >
          Neither
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
  const range = useRangeSelect();
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

  const cardProps = {
    onLink: (out: string, into: string) => link.mutate({ out, into }),
    linking: link.isPending ? (link.variables ?? null) : null,
    groups,
    names,
    onRecategorize: (t: TransferReviewTransaction, categoryId: string) =>
      categoryId !== t.categoryId && patch.mutate({ t, body: { categoryId } }),
    onOutside: (t: TransferReviewTransaction) =>
      patch.mutate({ t, body: { transferExternal: true } }),
  };
  const allSelected = unmatched.length > 0 && unmatched.every((t) => selected.has(t.id));
  const unmatchedGroups = groupUnmatched(unmatched);
  const isOpen = (g: (typeof unmatchedGroups)[number], all: unknown[]) =>
    all.length === 1 || openGroups.has(`u:${g.key}`);
  // The rows on screen, in order: a shift-click range covers only what you can see.
  const shown = unmatchedGroups.flatMap((g) =>
    isOpen(g, unmatchedGroups) ? g.items.map((t) => t.id) : [],
  );
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
            own. Link each to its other side, or say it has none.
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
                      {reviewCards(g.items).map((card) =>
                        card.kind === 'out' ? (
                          <OutCard
                            key={card.suggestion.transaction.id}
                            suggestion={card.suggestion}
                            count={card.count}
                            hint={hinted.get(card.suggestion.transaction.id) ?? null}
                            {...cardProps}
                          />
                        ) : (
                          <InCard
                            key={card.into.id}
                            into={card.into}
                            options={card.options}
                            hint={card.hint}
                            {...cardProps}
                          />
                        ),
                      )}
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
            {unmatchedGroups.map((g, _, all) => {
              const open = isOpen(g, all);
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
                          <span className="select-none" {...range.capture}>
                            <Checkbox
                              aria-label={`Select ${t.displayName}`}
                              isSelected={selected.has(t.id)}
                              onChange={(on) =>
                                setSelected(range.toggle(shown, selected, t.id, on))
                              }
                            />
                          </span>
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
