// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HouseholdPlaidKeys, PlaidKeysInput } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { plaidKeysQuery } from '../api/queries.js';
import { ReauthCancelled, useRecentAuth } from './RecentAuth.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DateText,
  Dialog,
  DialogActions,
  Form,
  LoadingRegion,
  Select,
  SelectItem,
  Skeleton,
  TextField,
  toast,
} from './ui.js';

// A household's own Plaid keys (#83, ADR 0008 §Credentials 2–5, bank connections D15): household
// owners enter them, Plaid checks them, and banks connected afterwards use them. Banks connected
// before keep the keys they were made with until each is connected again. The secret is
// write-only: it's sent once and never shown, and the form forgets it once saved.

type Data<T> = { data: T };
type Connections = HouseholdPlaidKeys['connections'];

const ENV_LABELS = { sandbox: 'Sandbox', production: 'Production' } as const;

/** Where a connection's keys come from, from the household's side. */
const KEYS_LABELS: Record<Connections[number]['keys'], string> = {
  current: 'Your current keys',
  server: 'The server’s keys',
  previous: 'Your earlier keys',
};

/** "Chase · Sam · 3 accounts", for a connection in a list. */
function ConnectionLine({ c }: { c: Connections[number] }) {
  const accounts = `${c.accountCount} ${c.accountCount === 1 ? 'account' : 'accounts'}`;
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span>
        <span className="font-medium text-fg">{c.institutionName ?? 'A bank'}</span>
        <span className="text-muted">
          {' '}
          · {c.owner.name} · {accounts}
        </span>
      </span>
      <span className="text-xs text-muted">{KEYS_LABELS[c.keys]}</span>
    </li>
  );
}

/**
 * Entering keys, new or replacing: what changes before anything does (D15). The banks already
 * connected stay on their keys, and the dialog lists them.
 */
function KeysDialog({
  householdId,
  data,
  isOpen,
  onOpenChange,
}: {
  householdId: string;
  data: HouseholdPlaidKeys;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { withRecentAuth, dialog } = useRecentAuth();
  const empty: PlaidKeysInput = { clientId: '', secret: '', env: 'production' };
  const [keys, setKeys] = useState(empty);
  const save = useMutation({
    mutationFn: () =>
      withRecentAuth(() =>
        api<Data<HouseholdPlaidKeys>>(
          'PUT',
          `/api/v1/households/${householdId}/plaid-credentials`,
          {
            body: { clientId: keys.clientId.trim(), secret: keys.secret.trim(), env: keys.env },
          },
        ),
      ),
    onSuccess: (r) => {
      queryClient.setQueryData(plaidKeysQuery(householdId).queryKey, r.data);
      setKeys(empty);
      onOpenChange(false);
      toast(data.keys ? 'Your Plaid keys were replaced.' : 'Your Plaid keys were saved.');
    },
  });
  const err = save.error instanceof ReauthCancelled ? null : (save.error as ApiError | null);
  const set = (changes: Partial<PlaidKeysInput>) => {
    setKeys((k) => ({ ...k, ...changes }));
    if (save.error) save.reset();
  };
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (keys.clientId.trim() && keys.secret.trim()) save.mutate();
  };
  // Every connection stays on the keys it was made with: after this, none is on the new ones.
  const staying = data.connections;

  return (
    <>
      <Dialog
        title={data.keys ? 'Replace your Plaid keys' : 'Add your Plaid keys'}
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setKeys(empty);
            save.reset();
          }
          onOpenChange(open);
        }}
      >
        {(close) => (
          <Form onSubmit={onSubmit}>
            <p className="text-sm text-muted">
              From Plaid’s dashboard, under Developers → Keys. Fiscus checks them with Plaid before
              saving, keeps the secret encrypted with this household’s key, and never shows it
              again.
            </p>
            {err ? (
              <Alert>
                {err.title}
                {err.detail ? ` ${err.detail}` : null}
              </Alert>
            ) : null}
            <TextField
              label="Client ID"
              name="clientId"
              isRequired
              autoFocus
              value={keys.clientId}
              onChange={(clientId) => set({ clientId })}
              spellCheck="false"
              autoComplete="off"
              inputClassName="font-mono text-sm"
            />
            <TextField
              label="Secret"
              name="secret"
              type="password"
              isRequired
              value={keys.secret}
              onChange={(secret) => set({ secret })}
              autoComplete="off"
              inputClassName="font-mono text-sm"
            />
            <Select
              label="Environment"
              value={keys.env}
              onChange={(env) => env && set({ env: env as PlaidKeysInput['env'] })}
              description={
                keys.env === 'sandbox'
                  ? 'Sandbox connects only to Plaid’s test banks: nothing real syncs.'
                  : 'Production connects your real banks. The secret must be the production one.'
              }
            >
              <SelectItem id="production">Production</SelectItem>
              <SelectItem id="sandbox">Sandbox</SelectItem>
            </Select>
            {staying.length ? (
              <div className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm">
                <p className="text-muted">
                  {staying.length === 1
                    ? 'This bank keeps syncing with the keys it was connected with.'
                    : `These ${staying.length} banks keep syncing with the keys they were connected with.`}{' '}
                  To move one to the new keys, the person who connected it connects it again.
                </p>
                <ul className="space-y-1" aria-label="Banks that keep their keys">
                  {staying.map((c) => (
                    <ConnectionLine key={c.id} c={c} />
                  ))}
                </ul>
              </div>
            ) : null}
            <DialogActions>
              <Button variant="secondary" onPress={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                isPending={save.isPending}
                isDisabled={!keys.clientId.trim() || !keys.secret.trim()}
              >
                {data.keys ? 'Replace keys' : 'Save keys'}
              </Button>
            </DialogActions>
          </Form>
        )}
      </Dialog>
      {dialog}
    </>
  );
}

/**
 * Household settings → Connections: the household's own Plaid keys, for its owners (HH-08). Shows
 * which keys are in place, which banks aren't on them yet, and lets an owner add, replace or
 * remove them. When the server's admin has turned household keys off, it says so.
 */
export function PlaidKeysCard({ householdId }: { householdId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery(plaidKeysQuery(householdId));
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { withRecentAuth, dialog } = useRecentAuth();
  const remove = useMutation({
    mutationFn: () =>
      withRecentAuth(() => api('DELETE', `/api/v1/households/${householdId}/plaid-credentials`)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: plaidKeysQuery(householdId).queryKey });
      toast('Your Plaid keys were removed.');
    },
    onError: (e) => {
      if (!(e instanceof ReauthCancelled)) {
        const err = e as ApiError;
        toast(err.title, { tone: 'error', ...(err.detail ? { description: err.detail } : {}) });
      }
    },
  });

  const data = query.data;
  if (query.isPending) {
    return (
      <LoadingRegion label="Loading your Plaid keys">
        <Skeleton className="h-24" />
      </LoadingRegion>
    );
  }
  if (!data) return query.error ? <Alert>{(query.error as ApiError).title}</Alert> : null;

  const notOnYours = data.keys ? data.connections.filter((c) => c.keys !== 'current') : [];
  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold">Your own Plaid keys</h2>
        {data.keys ? (
          <Badge tone={data.keys.env === 'sandbox' ? 'warning' : 'accent'}>
            {ENV_LABELS[data.keys.env]}
          </Badge>
        ) : null}
      </div>
      <div className="space-y-3 text-sm text-muted">
        <p>
          {data.serverKeys
            ? 'Banks connect through this server’s Plaid account unless you add keys from your own. With yours, the banks you connect afterwards use your Plaid account.'
            : 'This server has no Plaid keys of its own: to connect banks through Plaid, add keys from your own Plaid account.'}
        </p>
        {!data.allowed ? (
          <Alert tone="warning">
            This server’s admin has turned off households’ own Plaid keys
            {data.keys
              ? ', so you can’t add or replace them. Banks connected with them keep syncing, and you can still remove them.'
              : '.'}
          </Alert>
        ) : null}
        {data.keys ? (
          <dl className="space-y-1">
            <div className="flex flex-wrap justify-between gap-x-4">
              <dt>Client ID</dt>
              <dd className="font-mono text-fg">ending {data.keys.clientIdEnding}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4">
              <dt>Added</dt>
              <dd className="text-fg">
                <DateText value={data.keys.addedAt} />
              </dd>
            </div>
          </dl>
        ) : null}
        {notOnYours.length ? (
          <div className="space-y-2">
            <p>
              {notOnYours.length === 1
                ? 'This bank isn’t on your keys yet.'
                : `These ${notOnYours.length} banks aren’t on your keys yet.`}{' '}
              Each keeps syncing on the keys it was connected with until the person who connected it
              connects it again.
            </p>
            <ul className="space-y-1" aria-label="Banks not on your keys">
              {notOnYours.map((c) => (
                <ConnectionLine key={c.id} c={c} />
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {data.allowed ? (
            <Button variant={data.keys ? 'secondary' : 'primary'} onPress={() => setEditing(true)}>
              {data.keys ? 'Replace keys' : 'Add your keys'}
            </Button>
          ) : null}
          {data.keys ? (
            <Button variant="secondary" onPress={() => setRemoving(true)}>
              Remove keys
            </Button>
          ) : null}
        </div>
      </div>
      <KeysDialog
        householdId={householdId}
        data={data}
        isOpen={editing}
        onOpenChange={setEditing}
      />
      <ConfirmDialog
        isOpen={removing}
        onOpenChange={setRemoving}
        title="Remove your Plaid keys?"
        confirmLabel="Remove keys"
        destructive
        onConfirm={() => remove.mutateAsync()}
      >
        Banks you connect afterwards use the server’s keys
        {data.serverKeys ? '' : ', and this server has none'}. Keys that banks still sync with can’t
        be removed: connect those banks again with other keys, or disconnect them, first.
      </ConfirmDialog>
      {dialog}
    </Card>
  );
}
