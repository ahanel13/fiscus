// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BankConnectionStats,
  BankConnectionsOverview,
  InstanceSettings,
  PlaidTestWebhook,
  PlaidWebhookHealth,
  UpdateInstanceSettings,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { bankConnectionsQuery } from '../api/queries.js';
import { ReauthCancelled, useRecentAuth } from '../components/RecentAuth.js';
import {
  Alert,
  Badge,
  type BadgeTone,
  Button,
  Card,
  LoadingRegion,
  Select,
  SelectItem,
  Skeleton,
  Switch,
  toast,
} from '../components/ui.js';
import { relativeTime } from '../lib/relative-time.js';

type Data<T> = { data: T };

/** The intervals offered; any whole number of hours from 1 to 24 is allowed. */
const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];
const hours = (n: number) => (n === 1 ? 'Every hour' : `Every ${n} hours`);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 connections in 2 households", or "None" (D16: numbers, never names). */
export function usage({ households, connections }: BankConnectionStats['simplefin']) {
  if (connections === 0) return 'None';
  return `${plural(connections, 'connection', 'connections')} in ${plural(households, 'household', 'households')}`;
}

/** Connections by status, the ones needing attention first; statuses with none are left out. */
const STATUSES: { key: keyof BankConnectionStats['byStatus']; label: string; tone: BadgeTone }[] = [
  { key: 'error', label: 'Failing', tone: 'danger' },
  { key: 'login_required', label: 'Need sign-in', tone: 'warning' },
  { key: 'setup', label: 'Being set up', tone: 'neutral' },
  { key: 'ok', label: 'Working', tone: 'positive' },
];

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4">
      <dt>{label}</dt>
      <dd className="font-medium text-fg">{value}</dd>
    </div>
  );
}

/** The page's clock, so "5 minutes ago" stays true while it's open; tests pass their own. */
function useClock(fixedNow?: number): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [fixedNow]);
  return fixedNow ?? clock;
}

/** Connections across the server, and how syncing has gone over the last day. */
export function ConnectionCounts({
  stats,
  now: fixedNow,
}: {
  stats: BankConnectionStats;
  now?: number;
}) {
  const now = useClock(fixedNow);
  const shown = STATUSES.filter((s) => stats.byStatus[s.key] > 0);
  const { synced, failing, lastSyncedAt } = stats.last24h;
  return (
    <Card>
      <h3 className="mb-2 font-semibold">Connections</h3>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">No household has connected a bank yet.</p>
      ) : (
        <div className="space-y-3 text-sm text-muted">
          <ul className="flex flex-wrap gap-2" aria-label="Connections by status">
            {shown.map((s) => (
              <li key={s.key}>
                <Badge tone={s.tone}>
                  {s.label}: {stats.byStatus[s.key]}
                </Badge>
              </li>
            ))}
          </ul>
          <dl className="space-y-1">
            <Stat label="Synced in the last 24 hours" value={synced} />
            <Stat label="Latest sync failed" value={failing} />
            <Stat
              label="Most recent sync"
              value={lastSyncedAt ? relativeTime(lastSyncedAt, now) : 'None yet'}
            />
          </dl>
        </div>
      )}
    </Card>
  );
}

/** The refusal reasons the panel lists on their own (#85); the rest are added up. */
const REFUSALS: { label: string; reasons: (keyof PlaidWebhookHealth['refusals']['last24h'])[] }[] =
  [
    { label: 'Signature didn’t verify', reasons: ['signature'] },
    { label: 'Too old (stale)', reasons: ['stale'] },
    { label: 'Body didn’t match its hash', reasons: ['body_hash'] },
    { label: 'Unknown key', reasons: ['unknown_key'] },
    { label: 'Unsigned or malformed', reasons: ['missing', 'malformed', 'algorithm'] },
  ];

/** How long the panel waits for a test webhook before saying it hasn't come. */
export const TEST_WEBHOOK_WAIT_MS = 2 * 60_000;

type TestState = { firedAt: string; gaveUp: boolean } | null;

/**
 * Plaid webhooks (#84, #85): on or off, where Plaid sends them, and how the receiver is doing.
 * Times and counts only (D16). In sandbox, a test webhook, and whether it arrived.
 */
export function WebhookHealth({
  plaid,
  now: fixedNow,
  test,
  onTest,
  testing = false,
}: {
  plaid: BankConnectionsOverview['plaid'];
  now?: number;
  test?: TestState;
  onTest?: () => void;
  testing?: boolean;
}) {
  const now = useClock(fixedNow);
  const w = plaid.webhooks;
  const on = plaid.webhookUrl !== null;
  const when = (iso: string | null) => (iso ? relativeTime(iso, now) : 'None yet');
  const sum = (period: 'last24h' | 'last7d', reasons: (keyof typeof w.refusals.last24h)[]) =>
    reasons.reduce((n, r) => n + w.refusals[period][r], 0);
  const refused7d = REFUSALS.reduce((n, r) => n + sum('last7d', r.reasons), 0);
  const arrived =
    test && w.lastVerifiedAt !== null && Date.parse(w.lastVerifiedAt) >= Date.parse(test.firedAt);
  return (
    <ProviderCard
      title="Plaid webhooks"
      status={on ? <Badge tone="positive">On</Badge> : <Badge>Off</Badge>}
    >
      {!on ? (
        <p>
          Off: Fiscus checks each bank on its schedule. To have Plaid say when there’s something
          new, make only the webhook path public (see the webhook guide in the docs), then set
          PLAID_WEBHOOK_URL to the server’s public https address.
        </p>
      ) : (
        <>
          <p>
            Plaid sends them to <code className="break-all text-fg">{plaid.webhookUrl}</code>{' '}
            (PLAID_WEBHOOK_URL).
          </p>
          <dl className="space-y-1">
            <Stat label="Last verified webhook" value={when(w.lastVerifiedAt)} />
            <Stat
              label="For a connection on the server’s keys"
              value={when(w.lastVerifiedByKeys.server)}
            />
            <Stat
              label="For a connection on a household’s own keys"
              value={when(w.lastVerifiedByKeys.household)}
            />
            <Stat
              label="Verified, for no connection here (24 h / 7 days)"
              value={`${w.unknownItems.last24h} / ${w.unknownItems.last7d}`}
            />
            <Stat
              label="Connections without a webhook"
              value={`${w.connections.withoutWebhook} of ${w.connections.plaid}`}
            />
            <Stat
              label="Polling"
              value={w.pollingRelaxed ? 'Relaxed to every 12 hours' : 'On its usual schedule'}
            />
          </dl>
          {refused7d === 0 ? (
            <p>No request was refused in the last 7 days.</p>
          ) : (
            <table className="w-full text-left">
              <caption className="mb-1 text-left font-medium text-fg">Refused requests</caption>
              <thead>
                <tr>
                  <th scope="col" className="font-normal">
                    Reason
                  </th>
                  <th scope="col" className="w-20 text-right font-normal">
                    24 hours
                  </th>
                  <th scope="col" className="w-20 text-right font-normal">
                    7 days
                  </th>
                </tr>
              </thead>
              <tbody>
                {REFUSALS.map((r) => (
                  <tr key={r.label}>
                    <th scope="row" className="font-normal">
                      {r.label}
                    </th>
                    <td className="text-right font-medium text-fg">{sum('last24h', r.reasons)}</td>
                    <td className="text-right font-medium text-fg">{sum('last7d', r.reasons)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs">
            {w.pollingRelaxed
              ? 'Webhooks are healthy: a verified one in the last 48 hours, and none refused in the last 24.'
              : 'Polling relaxes once webhooks are healthy: a verified one in the last 48 hours, and none refused in the last 24.'}
          </p>
          {w.testAvailable ? (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button variant="secondary" isPending={testing} onPress={onTest}>
                Send a test webhook
              </Button>
              <span role="status">
                {!test
                  ? 'Sandbox only: Plaid fires one at a test bank’s Item.'
                  : arrived
                    ? 'The test webhook arrived and was verified.'
                    : test.gaveUp
                      ? 'It hasn’t arrived. Check that Plaid can reach the webhook URL.'
                      : 'Sent. Waiting for it to arrive…'}
              </span>
            </div>
          ) : null}
        </>
      )}
    </ProviderCard>
  );
}

function ProviderCard({
  title,
  status,
  children,
}: {
  title: string;
  status: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-semibold">{title}</h3>
        {status}
      </div>
      <div className="space-y-2 text-sm text-muted">{children}</div>
    </Card>
  );
}

/**
 * Plaid's environment, prominently (D17): a server on sandbox keys has test banks only, and
 * mustn't be mistaken for one syncing real money.
 */
export function PlaidStatus({ plaid }: { plaid: BankConnectionsOverview['plaid'] }) {
  if (!plaid.configured) return <Badge>Not configured</Badge>;
  return (
    <>
      <Badge tone="positive">Configured</Badge>
      {plaid.environment === 'sandbox' ? (
        <Badge tone="warning">Sandbox</Badge>
      ) : plaid.environment === 'production' ? (
        <Badge tone="accent">Production</Badge>
      ) : null}
    </>
  );
}

/**
 * Server → Bank connections (walkthrough §8, #400): how this server connects to banks. Counts,
 * never content (D16). Changing a setting takes effect at once, and needs a recent sign-in.
 */
export function BankConnectionsSection() {
  const queryClient = useQueryClient();
  const [test, setTest] = useState<TestState>(null);
  const overview = useQuery(bankConnectionsQuery);
  const lastVerifiedAt = overview.data?.plaid.webhooks.lastVerifiedAt ?? null;
  const waiting =
    test !== null &&
    !test.gaveUp &&
    !(lastVerifiedAt && Date.parse(lastVerifiedAt) >= Date.parse(test.firedAt));
  // While a test webhook is on its way: ask again every few seconds, for two minutes at most.
  useEffect(() => {
    if (!waiting) return;
    const poll = setInterval(
      () => void queryClient.invalidateQueries({ queryKey: bankConnectionsQuery.queryKey }),
      3_000,
    );
    const stop = setTimeout(
      () => setTest((t) => (t ? { ...t, gaveUp: true } : t)),
      TEST_WEBHOOK_WAIT_MS,
    );
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [waiting, queryClient]);
  const fireTest = useMutation({
    mutationFn: () =>
      api<Data<PlaidTestWebhook>>('POST', '/api/v1/admin/bank-connections/test-webhook'),
    onSuccess: (r) => setTest({ firedAt: r.data.firedAt, gaveUp: false }),
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const { withRecentAuth, dialog } = useRecentAuth();
  const save = useMutation({
    mutationFn: (changes: UpdateInstanceSettings) =>
      withRecentAuth(() =>
        api<Data<InstanceSettings>>('PATCH', '/api/v1/admin/settings', { body: changes }),
      ),
    onSuccess: (r) => {
      queryClient.setQueryData(bankConnectionsQuery.queryKey, (old) =>
        old
          ? {
              ...old,
              simplefin: { enabled: r.data['simplefin.enabled'] },
              settings: r.data,
            }
          : old,
      );
      toast('Saved.');
    },
    onError: (e) => {
      if (!(e instanceof ReauthCancelled)) toast((e as ApiError).title, { tone: 'error' });
    },
  });

  const data = overview.data;
  const settings = data?.settings;
  /** What a control shows: the change being saved, else the saved value. */
  const shown = <K extends keyof InstanceSettings>(key: K): InstanceSettings[K] | undefined =>
    (save.isPending ? (save.variables[key] as InstanceSettings[K] | undefined) : undefined) ??
    settings?.[key];
  const set = (changes: UpdateInstanceSettings) => save.mutate(changes);
  const interval = shown('sync.intervalHours') ?? 4;

  return (
    <section aria-labelledby="bank-connections" className="space-y-3">
      <div>
        <h2 id="bank-connections" className="font-semibold">
          Bank connections
        </h2>
        <p className="text-sm text-muted">
          How households on this server connect their banks. You see settings and counts here, never
          anyone’s accounts or transactions.
        </p>
      </div>
      {overview.error ? (
        <Alert>{(overview.error as ApiError).title}</Alert>
      ) : !data ? (
        <LoadingRegion label="Loading bank connections">
          <Skeleton className="h-28 w-full rounded-xl" />
        </LoadingRegion>
      ) : (
        <>
          {data.plaid.environment === 'sandbox' ? (
            <Alert tone="warning">
              <strong className="font-semibold">Sandbox: no real banks.</strong> This server uses
              Plaid’s sandbox keys, which connect only to Plaid’s test banks. Nothing here syncs
              real money.
            </Alert>
          ) : null}
          <ProviderCard title="Plaid" status={<PlaidStatus plaid={data.plaid} />}>
            <p>
              {data.plaid.configured
                ? 'Keys come from PLAID_CLIENT_ID and PLAID_SECRET in the server’s environment.'
                : 'No Plaid keys are set in the server’s environment.'}
              {data.plaid.environment === 'production'
                ? ' Production: households connect their real banks.'
                : ''}
            </p>
            <dl className="space-y-1">
              <Stat label="On the server’s keys" value={usage(data.stats.plaidInstanceKeys)} />
              <Stat label="On households’ own keys" value={usage(data.stats.plaidHouseholdKeys)} />
            </dl>
            <Switch
              isSelected={shown('plaid.allowHouseholdKeys') ?? false}
              onChange={(v) => set({ 'plaid.allowHouseholdKeys': v })}
            >
              Households may use their own Plaid keys
            </Switch>
            <Switch
              isSelected={shown('plaid.refreshNowEnabled') ?? false}
              onChange={(v) => set({ 'plaid.refreshNowEnabled': v })}
            >
              Members may ask for a sync with “Refresh now”
            </Switch>
          </ProviderCard>
          {data.plaid.configured || data.plaid.webhookUrl ? (
            <WebhookHealth
              plaid={data.plaid}
              test={test}
              testing={fireTest.isPending}
              onTest={() => fireTest.mutate()}
            />
          ) : null}
          <ProviderCard
            title="SimpleFIN"
            status={data.simplefin.enabled ? <Badge tone="positive">On</Badge> : <Badge>Off</Badge>}
          >
            <p>Nothing to configure: each household brings its own SimpleFIN Bridge token.</p>
            <dl>
              <Stat label="In use" value={usage(data.stats.simplefin)} />
            </dl>
            <Switch
              isSelected={shown('simplefin.enabled') ?? false}
              onChange={(v) => set({ 'simplefin.enabled': v })}
            >
              Households may connect banks through SimpleFIN
            </Switch>
          </ProviderCard>
          <ConnectionCounts stats={data.stats} />
          <Card>
            <h3 className="mb-2 font-semibold">Schedule</h3>
            <Select
              label="Sync every"
              className="max-w-xs"
              value={String(interval)}
              onChange={(v) => v && set({ 'sync.intervalHours': Number(v) })}
              description="How often Fiscus checks every connection for new transactions."
            >
              {[...new Set([...INTERVALS, interval])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <SelectItem key={n} id={String(n)}>
                    {hours(n)}
                  </SelectItem>
                ))}
            </Select>
          </Card>
        </>
      )}
      {dialog}
    </section>
  );
}
