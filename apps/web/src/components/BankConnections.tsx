// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account, Connection, HouseholdMember, RefreshTooSoon } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { Landmark, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { connectionsQuery } from '../api/queries.js';
import { leaveTo } from '../lib/flash.js';
import { relativeTime } from '../lib/relative-time.js';
import { useInvalidateLedger } from '../routes/transactions.js';
import {
  Badge,
  type BadgeTone,
  Button,
  buttonStyles,
  ConfirmDialog,
  DateText,
  toast,
} from './ui.js';

// A household's bank connections (the bank connections walkthrough §5–§7, D10–D14): at the top of
// Accounts, each with how fresh it is, "Refresh now" for its owner, and what's wrong when
// something is; on the dashboard, only the broken ones; in Household settings → Connections, all
// of them with who linked them and "Disconnect". Whoever sees its accounts sees it, with whose it
// is: only its owner fixes it (D11), and the accounts it leaves stale are named (D12).

type Data<T> = { data: T };
const base = (householdId: string) => `/api/v1/households/${householdId}`;

const PROVIDER: Record<Connection['provider'], string> = { plaid: 'Plaid', simplefin: 'SimpleFIN' };

/** What's wrong with a connection, when something is that its accounts should say (D12, D13). */
export type ConnectionTrouble = 'needs_sign_in' | 'not_working';

export const TROUBLE: Record<ConnectionTrouble, { label: string; tone: BadgeTone }> = {
  needs_sign_in: { label: 'Needs sign-in', tone: 'warning' },
  not_working: { label: 'Not working', tone: 'danger' },
};

/** A sign-in it needs, or 3 days of failures. A failure Fiscus is still retrying isn't one yet. */
export function connectionTrouble(c: Connection): ConnectionTrouble | null {
  if (c.status === 'login_required') return 'needs_sign_in';
  if (c.status === 'error' && c.notWorking) return 'not_working';
  return null;
}

/** Each account's connection trouble, for the badge on its row (D13). */
export function useAccountTrouble(householdId: string): Map<string, ConnectionTrouble> {
  const data = useQuery(connectionsQuery(householdId)).data;
  return useMemo(
    () =>
      new Map(
        (data ?? []).flatMap((c) => {
          const trouble = connectionTrouble(c);
          return trouble ? c.accountIds.map((id) => [id, trouble] as const) : [];
        }),
      ),
    [data],
  );
}

/**
 * The connections, or nothing when there are none. `dashboard` shows only the broken ones;
 * `settings` adds who linked each, how many accounts, and "Disconnect" for its owner (D14).
 */
export function BankConnections({
  householdId,
  accounts,
  members,
  variant = 'accounts',
}: {
  householdId: string;
  accounts: Account[];
  members: HouseholdMember[];
  variant?: 'accounts' | 'dashboard' | 'settings';
}) {
  const data = useQuery(connectionsQuery(householdId)).data;
  const connections = useMemo(() => data ?? [], [data]);
  const invalidate = useInvalidateLedger(householdId);
  // A sync that just finished brings balances and transactions: show them.
  const synced = useRef(new Map<string, string | null>());
  useEffect(() => {
    let changed = false;
    for (const c of connections) {
      const before = synced.current.get(c.id);
      if (before !== undefined && before !== c.lastSyncedAt) changed = true;
      synced.current.set(c.id, c.lastSyncedAt);
    }
    if (changed) void invalidate();
  }, [connections, invalidate]);

  const shown =
    variant === 'dashboard'
      ? connections.filter((c) => c.status === 'login_required' || c.status === 'error')
      : connections;
  if (shown.length === 0) return null;
  const me = members.find((m) => m.isYou)?.id;
  return (
    <section
      aria-label={variant === 'dashboard' ? 'Bank connections to fix' : 'Bank connections'}
      className="space-y-2"
    >
      {shown.map((c) => (
        <ConnectionLine
          key={c.id}
          householdId={householdId}
          connection={c}
          accounts={accounts.filter((a) => c.accountIds.includes(a.id))}
          yours={c.owner.memberId === me}
          manage={variant === 'settings'}
        />
      ))}
    </section>
  );
}

function ConnectionLine({
  householdId,
  connection: c,
  accounts,
  yours,
  manage,
}: {
  householdId: string;
  connection: Connection;
  accounts: Account[];
  yours: boolean;
  /** In Household settings: who linked it, how many accounts, and "Disconnect" any time. */
  manage: boolean;
}) {
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState(false);
  // A clock that ticks every few seconds, so "2 minutes ago" and "Syncing…" keep up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  const bank = c.institutionName ?? 'Your bank';
  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: connectionsQuery(householdId).queryKey });

  const refresh = useMutation({
    mutationFn: () =>
      api<Data<Connection>>('POST', `${base(householdId)}/connections/${c.id}/refresh`),
    onSuccess: async () => {
      toast(`Syncing ${bank} now.`, {
        description: 'New transactions show up here in a minute or two.',
      });
      await refetch();
    },
    onError: async (e) => {
      const err = e as ApiError;
      const at = (err.body as Partial<RefreshTooSoon>).availableAt;
      toast(err.title, {
        tone: 'error',
        description: at ? `You can refresh it again ${relativeTime(at)}.` : (err.detail ?? ''),
      });
      await refetch();
    },
  });

  const signIn = () =>
    leaveTo(`/h/${householdId}/connect/plaid?connection=${encodeURIComponent(c.id)}`);

  const broken = c.status === 'login_required' || c.status === 'error';
  // Due now, or within the minute: the worker picks it up on its next pass.
  const due = c.nextSyncAt !== null && Date.parse(c.nextSyncAt) - now < 60_000;
  const waitUntil = c.refreshAvailableAt && Date.parse(c.refreshAvailableAt) > now;
  const stale =
    broken && accounts.length ? <StaleAccounts accounts={accounts} since={c.lastSyncedAt} /> : null;

  let status: React.ReactNode;
  if (c.status === 'setup') {
    status = 'Being set up: choose its accounts to start syncing.';
  } else if (c.status === 'login_required') {
    status = yours
      ? `${bank} needs you to sign in again before it can sync.`
      : `${bank} needs signing in again. ${c.owner.name} connected it, so ${c.owner.name} signs in again to fix it.`;
  } else if (c.status === 'error' && c.notWorking) {
    status = (
      <>
        Not working since <DateText value={c.failingSince!} format="short" />.{' '}
        {yours
          ? 'Fiscus keeps trying, but you can disconnect it and connect the bank again.'
          : `Fiscus keeps trying. ${c.owner.name} can disconnect it.`}
      </>
    );
  } else if (c.status === 'error') {
    status = (
      <>
        Not syncing right now
        {c.failingSince ? <> since {relativeTime(c.failingSince, now)}</> : null}. Fiscus tries
        again {c.nextSyncAt ? relativeTime(c.nextSyncAt, now) : 'soon'}.
      </>
    );
  } else if (due) {
    status = 'Syncing…';
  } else {
    status = (
      <>
        {c.lastSyncedAt ? `Synced ${relativeTime(c.lastSyncedAt, now)}` : 'Not synced yet'}
        {c.nextSyncAt ? ` · next ${relativeTime(c.nextSyncAt, now)}` : null}
      </>
    );
  }
  // An empty or recent-only first sync is normal while the bank sends the rest (TXN-008).
  const importing =
    c.importingHistory && c.status === 'ok' ? (
      <p className="text-xs text-muted">
        Still bringing in older transactions. That usually takes a few minutes after connecting.
      </p>
    ) : null;

  const trouble = connectionTrouble(c);
  const linked = manage ? (
    <p className="text-xs text-muted">
      Linked by {yours ? 'you' : c.owner.name} · {c.accountCount}{' '}
      {c.accountCount === 1 ? 'account' : 'accounts'}
    </p>
  ) : null;

  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3',
        broken ? 'border-warning/40 bg-warning-soft' : 'border-border bg-surface',
      )}
    >
      {broken ? (
        <TriangleAlert aria-hidden className="size-5 shrink-0 text-warning" />
      ) : (
        <Landmark aria-hidden className="size-5 shrink-0 text-muted" />
      )}
      {/* At least 14rem wide: on a phone the buttons wrap below instead of squeezing it. */}
      <div className="min-w-0 flex-[1_1_14rem] text-sm">
        <p className="font-medium">
          {bank}
          <span className="font-normal text-muted">
            {' '}
            · {PROVIDER[c.provider]}
            {yours ? null : ` · ${c.owner.name}’s`}
          </span>
        </p>
        {linked}
        <p className={clsx('text-xs', broken ? 'text-fg' : 'text-muted')} role="status">
          {manage && trouble ? (
            <Badge tone={TROUBLE[trouble].tone} className="mr-1.5">
              {TROUBLE[trouble].label}
            </Badge>
          ) : null}
          {status}
        </p>
        {importing}
        {stale}
      </div>
      {yours ? (
        <div className="flex flex-wrap gap-2">
          {c.status === 'setup' ? (
            <Link
              to="/h/$householdId/connect/setup/$connectionId"
              params={{ householdId, connectionId: c.id }}
              className={buttonStyles({ size: 'sm' })}
            >
              Choose accounts
            </Link>
          ) : null}
          {c.status === 'login_required' && c.provider === 'plaid' ? (
            <Button size="sm" onPress={signIn}>
              Sign in again
            </Button>
          ) : null}
          {(c.status === 'error' && c.notWorking) || manage ? (
            <Button size="sm" variant="secondary" onPress={() => setDisconnecting(true)}>
              Disconnect
            </Button>
          ) : null}
          {c.status === 'ok' || c.status === 'error' ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => refresh.mutate()}
              isPending={refresh.isPending}
              isDisabled={Boolean(waitUntil) || due}
              aria-label={`Refresh ${bank} now`}
            >
              <RefreshCw aria-hidden className="size-4" />
              {waitUntil ? `Refresh ${relativeTime(c.refreshAvailableAt!, now)}` : 'Refresh now'}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        title={`Disconnect ${bank}?`}
        isOpen={disconnecting}
        onOpenChange={setDisconnecting}
        confirmLabel="Disconnect"
        destructive
        onConfirm={async () => {
          await api('DELETE', `${base(householdId)}/connections/${c.id}`);
          toast(`${bank} was disconnected.`, {
            description: 'Its accounts and their history stay. Connect the bank again any time.',
          });
          await refetch();
        }}
      >
        Its accounts and their history stay here, and stop syncing. You can connect the bank again
        and link them back.
      </ConfirmDialog>
    </div>
  );
}

/** The accounts a broken connection leaves stale, and since when (D12). */
function StaleAccounts({ accounts, since }: { accounts: Account[]; since: string | null }) {
  const names = accounts.map((a) => a.name);
  const shown =
    names.length <= 2
      ? names.join(' and ')
      : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return (
    <p className="text-xs text-muted">
      {shown} {names.length === 1 ? 'shows' : 'show'} balances
      {since ? (
        <>
          {' '}
          as of <DateText value={since} format="short" />
        </>
      ) : (
        ' from before it broke'
      )}
      .
    </p>
  );
}
