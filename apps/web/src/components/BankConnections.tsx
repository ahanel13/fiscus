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
import { BankLogo } from './BankLogo.js';
import { BRIDGE } from './SimpleFinDialog.js';

// A household's bank connections (the bank connections walkthrough §5–§7, D10–D14): at the top of
// Accounts, the ones that need someone (to finish setup, sign in again, choose new accounts, or
// that are failing or still bringing in history) and one line for the rest; on the dashboard,
// only the broken ones; in Household settings → Connections, all of them with how fresh each is,
// "Refresh now", who linked them and "Disconnect". Whoever sees its accounts sees it, with whose it
// is: only its owner fixes it (D11), and the accounts it leaves stale are named (D12), as are the
// ones a working connection isn't updating: the bank stopped sending them.

type Data<T> = { data: T };
const base = (householdId: string) => `/api/v1/households/${householdId}`;

const PROVIDER: Record<Connection['provider'], string> = { plaid: 'Plaid', simplefin: 'SimpleFIN' };

/** What's wrong with a connection, when something is that its accounts should say (D12, D13). */
export type ConnectionTrouble = 'needs_sign_in' | 'not_working' | 'not_updating';

export const TROUBLE: Record<ConnectionTrouble, { label: string; tone: BadgeTone }> = {
  needs_sign_in: { label: 'Needs sign-in', tone: 'warning' },
  not_working: { label: 'Not working', tone: 'danger' },
  not_updating: { label: 'Not updating', tone: 'warning' },
};

/** A sign-in it needs, or 3 days of failures. A failure Fiscus is still retrying isn't one yet. */
export function connectionTrouble(c: Connection): ConnectionTrouble | null {
  if (c.status === 'login_required') return 'needs_sign_in';
  if (c.status === 'error' && c.notWorking) return 'not_working';
  return null;
}

/** Worth a row on Accounts: something to do or wait for. The rest sync on their own. */
function needsAttention(c: Connection): boolean {
  return (
    c.status === 'setup' ||
    c.status === 'login_required' ||
    c.status === 'error' ||
    c.newAccountsAvailable ||
    c.importingHistory ||
    c.onOldKeys ||
    c.staleAccounts.length > 0 ||
    (c.status === 'ok' && c.lastSyncedAt === null)
  );
}

/** Each account's connection trouble, for the badge on its row (D13), or that it isn't updating. */
export function useAccountTrouble(householdId: string): Map<string, ConnectionTrouble> {
  const data = useQuery(connectionsQuery(householdId)).data;
  return useMemo(
    () =>
      new Map(
        (data ?? []).flatMap((c) => {
          const trouble = connectionTrouble(c);
          return trouble
            ? c.accountIds.map((id) => [id, trouble] as const)
            : c.staleAccounts.map((a) => [a.accountId, 'not_updating'] as const);
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
      ? connections.filter(
          (c) => c.status === 'login_required' || c.status === 'error' || c.staleAccounts.length,
        )
      : variant === 'accounts'
        ? connections.filter(needsAttention)
        : connections;
  // On Accounts, the ones that sync on their own are one line, to settings.
  const quiet = variant === 'accounts' ? connections.length - shown.length : 0;
  if (shown.length === 0 && quiet === 0) return null;
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
      {quiet ? (
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
          <Landmark aria-hidden className="size-4 shrink-0" />
          <span>
            {shown.length ? `${quiet} more` : quiet} bank{' '}
            {quiet === 1 ? 'connection syncs' : 'connections sync'} on{' '}
            {quiet === 1 ? 'its' : 'their'} own.
          </span>
          <Link
            to="/h/$householdId/settings/connections"
            params={{ householdId }}
            className="font-medium text-accent-text underline-offset-2 hover:underline"
          >
            Manage connections
          </Link>
        </p>
      ) : null}
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
  // Connected again with the keys new banks use, keeping its accounts (#83, D15).
  const move = () =>
    leaveTo(`/h/${householdId}/connect/plaid?replaces=${encodeURIComponent(c.id)}`);
  const movable = manage && c.onOldKeys && c.status !== 'setup';

  const broken = c.status === 'login_required' || c.status === 'error';
  // Due now, or within the minute: the worker picks it up on its next pass.
  const due = c.nextSyncAt !== null && Date.parse(c.nextSyncAt) - now < 60_000;
  const waitUntil = c.refreshAvailableAt && Date.parse(c.refreshAvailableAt) > now;
  const stale =
    broken && accounts.length ? <StaleAccounts accounts={accounts} since={c.lastSyncedAt} /> : null;
  const notUpdating = c.staleAccounts.length ? (
    <NotUpdating connection={c} accounts={accounts} yours={yours} />
  ) : null;
  const attention = broken || notUpdating !== null;

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

  const oldKeys = movable ? (
    <p className="text-xs text-muted">
      On Plaid keys this household doesn’t connect new banks with.{' '}
      {yours
        ? 'Moving it signs in to the bank again; its accounts and their history stay.'
        : `${c.owner.name} can move it to the new ones.`}
    </p>
  ) : null;

  // The bank offers accounts nobody chose about yet (a SimpleFIN account added at the Bridge).
  const unchosen = c.newAccountsAvailable ? (
    <p className="text-xs text-fg">
      {bank} has accounts you haven’t chosen about yet.{' '}
      {yours ? 'Choose accounts to track them.' : `${c.owner.name} can add them.`}
    </p>
  ) : null;
  // Choosing again: track more, move some here, or stop tracking some (D18).
  const choosable = c.status === 'ok' || c.status === 'error';

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
        attention ? 'border-warning/40 bg-warning-soft' : 'border-border bg-surface',
      )}
    >
      {attention ? (
        <TriangleAlert aria-hidden className="size-5 shrink-0 text-warning" />
      ) : c.institution ? (
        <BankLogo institution={c.institution} name={bank} />
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
        {unchosen}
        {oldKeys}
        {stale}
        {notUpdating}
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
          ) : choosable ? (
            <Link
              to="/h/$householdId/connect/setup/$connectionId"
              params={{ householdId, connectionId: c.id }}
              className={buttonStyles({
                size: 'sm',
                variant: c.newAccountsAvailable ? 'primary' : 'secondary',
              })}
            >
              Choose accounts
            </Link>
          ) : null}
          {c.status === 'login_required' && c.provider === 'plaid' ? (
            <Button size="sm" onPress={signIn}>
              Sign in again
            </Button>
          ) : null}
          {movable ? (
            <Button size="sm" variant="secondary" onPress={move}>
              Move to new keys
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

/**
 * The accounts a working connection isn't updating (D12): the provider said it couldn't, or no
 * balance has come from the bank for days. Usually the bank wants signing in again at the
 * provider, so it says where, and whose that is (D11).
 */
function NotUpdating({
  connection: c,
  accounts,
  yours,
}: {
  connection: Connection;
  accounts: Account[];
  yours: boolean;
}) {
  const names = c.staleAccounts.map(
    (s) => accounts.find((a) => a.id === s.accountId)?.name ?? 'An account',
  );
  const one = names.length === 1;
  const shown =
    names.length <= 2
      ? names.join(' and ')
      : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  // The oldest balance any of them has from the bank.
  const asOf = c.staleAccounts
    .map((s) => s.asOf)
    .filter((d) => d !== null)
    .sort()[0];
  const fix =
    c.provider === 'simplefin' ? (
      <>
        {yours ? 'Check it at the ' : `${c.owner.name} can check it at the `}
        <a href={BRIDGE} target="_blank" rel="noreferrer" className="text-accent-text underline">
          SimpleFIN Bridge
        </a>
        : the bank may want signing in to again there.
      </>
    ) : yours ? (
      'Try Refresh now. If it stays, disconnect the bank and connect it again.'
    ) : (
      `${c.owner.name} connected it, so ${c.owner.name} can connect it again.`
    );
  return (
    <p className="text-xs text-fg">
      {shown} {one ? 'isn’t' : 'aren’t'} updating
      {asOf ? (
        <>
          : the latest balance from the bank is from <DateText value={asOf} format="short" />
        </>
      ) : null}
      . {fix}
    </p>
  );
}
