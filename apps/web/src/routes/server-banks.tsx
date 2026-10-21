// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BankConnectionsOverview,
  InstanceSettings,
  UpdateInstanceSettings,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api, type ApiError } from '../api/client.js';
import { bankConnectionsQuery } from '../api/queries.js';
import { ReauthCancelled, useRecentAuth } from '../components/RecentAuth.js';
import {
  Alert,
  Badge,
  Card,
  LoadingRegion,
  Select,
  SelectItem,
  Skeleton,
  Switch,
  toast,
} from '../components/ui.js';

type Data<T> = { data: T };

/** The intervals offered; any whole number of hours from 1 to 24 is allowed. */
const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];
const hours = (n: number) => (n === 1 ? 'Every hour' : `Every ${n} hours`);

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
 * never content (D16); connection counts come with bank sync itself (#78). Changing a setting
 * takes effect at once, and needs a recent sign-in.
 */
export function BankConnectionsSection() {
  const queryClient = useQueryClient();
  const overview = useQuery(bankConnectionsQuery);
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
          <ProviderCard
            title="SimpleFIN"
            status={data.simplefin.enabled ? <Badge tone="positive">On</Badge> : <Badge>Off</Badge>}
          >
            <p>Nothing to configure: each household brings its own SimpleFIN Bridge token.</p>
            <Switch
              isSelected={shown('simplefin.enabled') ?? false}
              onChange={(v) => set({ 'simplefin.enabled': v })}
            >
              Households may connect banks through SimpleFIN
            </Switch>
          </ProviderCard>
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
