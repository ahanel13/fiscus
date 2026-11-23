// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  formatMoney,
  MOVE_OUT_BLOCKER_TEXT,
  type MemberMove,
  type MoveOutPreview,
} from '@fiscus/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { House, Link2, Tag, Truck } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { ReauthCancelled, useRecentAuth } from '../components/RecentAuth.js';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  ConfirmDialog,
  DialogTrigger,
  Form,
  LoadingRegion,
  Skeleton,
  TextField,
  toast,
} from '../components/ui.js';

// Moving out (#253, ADR 0012 step 3, HH-20, budgeting walkthrough D37): a member starts a
// household of their own and takes what's theirs, with its history. Nobody can stop it. What
// they're shown here is the plan the move follows.

type Data<T> = { data: T };

export const moveOutPreviewQuery = (householdId: string) =>
  queryOptions({
    queryKey: ['households', householdId, 'move-out'],
    queryFn: async () =>
      (await api<Data<MoveOutPreview>>('GET', `/api/v1/households/${householdId}/move-out/preview`))
        .data,
  });

/** In the new household: the move into it, or null when there wasn't one. */
export const moveInQuery = (householdId: string) =>
  queryOptions({
    queryKey: ['households', householdId, 'move-in'],
    queryFn: async () => {
      try {
        return (await api<Data<MemberMove>>('GET', `/api/v1/households/${householdId}/move-in`))
          .data;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === 'pending' || q.state.data.status === 'moving')
        ? 2000
        : false,
  });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const percent = (bps: number) =>
  `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

/** Household settings → Members: the way to the preview, for anyone in a household of two or more. */
export function MoveOutCard({ householdId }: { householdId: string }) {
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Move out</h2>
      <div className="space-y-3 text-sm text-muted">
        <p>
          Start a household of your own and take what’s yours with you: the accounts you own alone,
          with all their history, your own budget, goals and rules. Joint accounts stay here. Nobody
          can stop it; the owners are told.
        </p>
        <ButtonLink
          variant="secondary"
          to="/h/$householdId/settings/move-out"
          params={{ householdId }}
        >
          <Truck aria-hidden className="size-4" /> See what would move
        </ButtonLink>
      </div>
    </Card>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <h2 className="mb-3 flex items-center gap-2 font-semibold">
        {icon}
        {title}
      </h2>
      <div className="space-y-3 text-sm">{children}</div>
    </Card>
  );
}

function List({ items, empty }: { items: ReactNode[]; empty: string }) {
  if (items.length === 0) return <p className="text-muted">{empty}</p>;
  return <ul className="divide-y divide-border">{items}</ul>;
}

const Item = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
    <span className="min-w-0 flex-1 basis-48">{children}</span>
    {aside}
  </li>
);

/** Household settings → Move out: the preview, and starting it. */
export function MoveOutPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const preview = useQuery(moveOutPreviewQuery(householdId));
  if (!preview.data) {
    return (
      <LoadingRegion label="Working out what would move">
        <Skeleton className="h-40" />
      </LoadingRegion>
    );
  }
  return <MoveOutPlan householdId={householdId} p={preview.data} />;
}

export function MoveOutPlan({ householdId, p }: { householdId: string; p: MoveOutPreview }) {
  const { moves, stays, copied } = p;
  return (
    <>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Move out to a household of your own</h2>
        <p className="text-sm text-muted">
          Here’s what would happen if you moved out now. Nothing changes until you start it.
        </p>
      </div>
      {p.blockers.map((b) => (
        <Alert key={b} tone="warning">
          {MOVE_OUT_BLOCKER_TEXT[b]}
        </Alert>
      ))}
      {p.moving ? (
        <Alert tone="info">
          You’re already moving out.{' '}
          <ButtonLink
            size="sm"
            variant="ghost"
            to="/h/$householdId/settings/members"
            params={{ householdId: p.moving.householdId }}
          >
            Go to your household
          </ButtonLink>
        </Alert>
      ) : null}

      <Section title="Goes with you" icon={<Truck aria-hidden className="size-4 text-accent" />}>
        <List
          empty="You don’t own any accounts on your own."
          items={moves.accounts.map((a) => (
            <Item
              key={a.id}
              aside={
                a.connection === 'relink' ? (
                  <Badge tone="warning">Re-link the bank there</Badge>
                ) : a.connection === 'moves' ? (
                  <Badge>Bank connection too</Badge>
                ) : null
              }
            >
              <span className="font-medium">{a.name}</span>
              <span className="block text-muted">
                {plural(a.transactionCount, 'transaction')}, with their notes, tags and balances
              </span>
            </Item>
          ))}
        />
        {moves.connections.length > 0 ? (
          <p className="text-muted">
            {moves.connections
              .map((c) =>
                c.outcome === 'moves'
                  ? `Your ${c.institutionName ?? 'bank'} connection moves with you.`
                  : `Your ${c.institutionName ?? 'bank'} connection uses this household’s own Plaid keys, so it ends here and you link the bank again there. Its accounts keep their history.`,
              )
              .join(' ')}
          </p>
        ) : null}
        <ul className="list-disc space-y-1 pl-5 text-muted">
          {moves.budget ? <li>Your own budget (Mine), with its months</li> : null}
          {moves.goals.map((g) => (
            <li key={g.id}>
              Goal: {g.name}
              {g.wasHousehold ? ' (the household’s, on a debt that moves: yours from now on)' : ''}
            </li>
          ))}
          {moves.rules.map((r) => (
            <li key={r.id}>Rule: {r.name ?? 'Unnamed rule'}</li>
          ))}
          {moves.forOthers > 0 ? (
            <li>
              {plural(moves.forOthers, 'purchase')} on your accounts that were for someone else
              count as yours there. Settle-up below covers what they owed.
            </li>
          ) : null}
        </ul>
      </Section>

      <Section title="Stays here" icon={<House aria-hidden className="size-4 text-muted" />}>
        <List
          empty="You don’t share any accounts."
          items={stays.jointAccounts.map((a) => (
            <Item
              key={a.id}
              aside={a.relink ? <Badge tone="warning">They re-link the bank</Badge> : null}
            >
              <span className="font-medium">{a.name}</span>
              <span className="block text-muted">
                Joint: you stop being an owner, and your share goes to{' '}
                {a.owners.map((o) => `${o.displayName} (${percent(o.shareBps)})`).join(', ')}.
              </span>
            </Item>
          ))}
        />
        <ul className="list-disc space-y-1 pl-5 text-muted">
          {stays.attributedElsewhere > 0 ? (
            <li>
              {plural(stays.attributedElsewhere, 'purchase')} on other people’s accounts that were
              for you: they’re the payer’s.
            </li>
          ) : null}
          <li>Shared budgets and goals, and everything in the household’s activity</li>
          {stays.goalsLeft.map((g) => (
            <li key={g.id}>Your goal {g.name} ends: its debt is joint, so it stays here</li>
          ))}
          {stays.rulesLeft.map((r) => (
            <li key={r.id}>
              Your rule {r.name ?? 'Unnamed rule'} ends: it’s only for accounts that stay
            </li>
          ))}
          {stays.claimsEnding > 0 ? (
            <li>
              {plural(stays.claimsEnding, 'goal claim')} between what moves and what stays end
            </li>
          ) : null}
        </ul>
      </Section>

      <Section title="Copied" icon={<Tag aria-hidden className="size-4 text-muted" />}>
        <p className="text-muted">
          The categories and tags your data uses, so your new household starts out matching. They
          stay here too. Merchant names come with their transactions.
        </p>
        {copied.categories.length > 0 ? (
          <p>
            <span className="text-muted">Categories: </span>
            {copied.categories.map((c) => c.name).join(', ')}
          </p>
        ) : null}
        {copied.tags.length > 0 ? (
          <p>
            <span className="text-muted">Tags: </span>
            {copied.tags.map((t) => t.name).join(', ')}
          </p>
        ) : null}
      </Section>

      <Section title="Settle-up" icon={<Link2 aria-hidden className="size-4 text-muted" />}>
        {p.settleUp.length === 0 ? (
          <p className="text-muted">You’re square with everyone.</p>
        ) : (
          <List
            empty=""
            items={p.settleUp.map((b) => (
              <Item key={b.memberId}>
                {b.amountMinor > 0
                  ? `${b.displayName} owes you ${formatMoney(b.amountMinor, b.currency)}`
                  : `You owe ${b.displayName} ${formatMoney(-b.amountMinor, b.currency)}`}
              </Item>
            ))}
          />
        )}
        <p className="text-muted">
          This is recorded in both households when you move, so either of you can settle it later.
        </p>
      </Section>

      {p.blockers.length === 0 && !p.moving ? (
        <StartMoveOut householdId={householdId} p={p} />
      ) : null}
    </>
  );
}

function StartMoveOut({ householdId, p }: { householdId: string; p: MoveOutPreview }) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { withRecentAuth, dialog } = useRecentAuth();
  const start = useMutation({
    mutationFn: () =>
      withRecentAuth(() =>
        api<Data<{ householdId: string }>>('POST', `/api/v1/households/${householdId}/move-out`, {
          body: { name: name.trim() },
        }),
      ),
    onSuccess: async ({ data }) => {
      toast('Your household is ready. Your things are on their way.');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await navigate({
        to: '/h/$householdId/settings/members',
        params: { householdId: data.householdId },
      });
    },
    onError: (e) => {
      if (e instanceof ReauthCancelled) return;
      const err = e as ApiError;
      toast(err.title, { tone: 'error', ...(err.detail ? { description: err.detail } : {}) });
    },
  });
  return (
    <Card>
      <h2 className="mb-3 font-semibold">Your new household</h2>
      <Form onSubmit={(e: FormEvent<HTMLFormElement>) => e.preventDefault()} className="space-y-3">
        <TextField label="Name" value={name} onChange={setName} isRequired maxLength={80} />
        <p className="text-sm text-muted">
          It starts with this household’s settings ({p.household.baseCurrency},{' '}
          {p.household.timezone}); you can change them there. You’ll be asked for your password.
        </p>
        <DialogTrigger>
          <Button isDisabled={!name.trim()}>Move out</Button>
          <ConfirmDialog
            title="Move out of this household?"
            confirmLabel="Move out"
            onConfirm={() => start.mutateAsync()}
          >
            What’s listed under Goes with you moves to {name.trim() || 'your new household'}, and
            you leave this household. The owners are told, and it’s in both households’ activity.
            You can’t undo it, but you can invite each other again.
          </ConfirmDialog>
        </DialogTrigger>
      </Form>
      {dialog}
    </Card>
  );
}

/** In the new household (Members): how the move is going, and the settle-up it recorded. */
export function MoveInCard({ householdId }: { householdId: string }) {
  const move = useQuery(moveInQuery(householdId)).data;
  if (!move) return null;
  const done = move.status === 'done';
  return (
    <Card>
      <h2 className="mb-2 font-semibold">
        {done
          ? 'You’ve moved in'
          : move.status === 'failed'
            ? 'Your move didn’t go ahead'
            : 'Moving your things in'}
      </h2>
      <div className="space-y-3 text-sm text-muted" role="status">
        {done ? (
          <p>
            Your accounts, budget, goals and rules are here, with their history. You’ve left the
            household you moved out of.
          </p>
        ) : move.status === 'failed' ? (
          <p>
            Nothing moved, and you’re still in the household you were leaving.{' '}
            {move.errorCode && move.errorCode in MOVE_OUT_BLOCKER_TEXT
              ? MOVE_OUT_BLOCKER_TEXT[move.errorCode as keyof typeof MOVE_OUT_BLOCKER_TEXT]
              : ''}
          </p>
        ) : (
          <>
            <p>
              Step {move.step} of {move.steps}. This usually takes a minute. You can keep using
              Fiscus meanwhile.
            </p>
            <progress
              className="h-2 w-full accent-accent"
              max={move.steps}
              value={move.step}
              aria-label="Moving"
            />
          </>
        )}
        {move.finalBalances.length > 0 ? (
          <div>
            <p className="font-medium text-fg">Settle-up when you moved</p>
            <ul className="list-disc pl-5">
              {move.finalBalances.map((b) => (
                <li key={b.memberId}>
                  {b.amountMinor > 0
                    ? `${b.displayName} owed you ${formatMoney(b.amountMinor, b.currency)}`
                    : `You owed ${b.displayName} ${formatMoney(-b.amountMinor, b.currency)}`}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
