// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Account, Connection, HouseholdMember, RefreshTooSoon } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Landmark, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { connectionsQuery } from '../api/queries.js';
import { leaveTo } from '../lib/flash.js';
import { relativeTime } from '../lib/relative-time.js';
import { useInvalidateLedger } from '../routes/transactions.js';
import { Button, ConfirmDialog, DateText, toast } from './ui.js';

// A household's bank connections, at the top of Accounts (the bank connections walkthrough §5–§6,
// D10–D13): each with how fresh it is, "Refresh now" for its owner, and what's wrong when
// something is. Whoever sees its accounts sees it, with whose it is: only its owner fixes it
// (D11), and the accounts it leaves stale are named (D12).

type Data<T> = { data: T };
const base = (householdId: string) => `/api/v1/households/${householdId}`;

const PROVIDER: Record<Connection['provider'], string> = { plaid: 'Plaid', simplefin: 'SimpleFIN' };

/** The connections, or nothing when there are none. */
export function BankConnections({
  householdId,
  accounts,
  members,
}: {
  householdId: string;
  accounts: Account[];
  members: HouseholdMember[];
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

  if (connections.length === 0) return null;
  const me = members.find((m) => m.isYou)?.id;
  return (
    <section aria-label="Bank connections" className="space-y-2">
      {connections.map((c) => (
        <ConnectionLine
          key={c.id}
          householdId={householdId}
          connection={c}
          accounts={accounts.filter((a) => c.accountIds.includes(a.id))}
          yours={c.owner.memberId === me}
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
}: {
  householdId: string;
  connection: Connection;
  accounts: Account[];
  yours: boolean;
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
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">
          {bank}
          <span className="font-normal text-muted">
            {' '}
            · {PROVIDER[c.provider]}
            {yours ? null : ` · ${c.owner.name}’s`}
          </span>
        </p>
        <p className={clsx('text-xs', broken ? 'text-fg' : 'text-muted')} role="status">
          {status}
        </p>
        {stale}
      </div>
      {yours ? (
        <div className="flex flex-wrap gap-2">
          {c.status === 'login_required' && c.provider === 'plaid' ? (
            <Button size="sm" onPress={signIn}>
              Sign in again
            </Button>
          ) : null}
          {c.status === 'error' && c.notWorking ? (
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
