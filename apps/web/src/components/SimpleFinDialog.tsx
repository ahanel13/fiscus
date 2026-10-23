// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionSetup } from '@fiscus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { connectionSetupQuery, connectionsQuery } from '../api/queries.js';
import { Alert, Button, Dialog, DialogActions, Form, TextField } from './ui.js';

// Connecting the SimpleFIN Bridge (#91, the bank connections walkthrough D3): the person makes a
// setup token at the Bridge and pastes it here. The server claims it, once, and keeps only the
// access it gives, encrypted; then the same choose step as Plaid's (D4).

type Data<T> = { data: T };
const BRIDGE = 'https://beta-bridge.simplefin.org';

export function SimpleFinDialog({
  householdId,
  isOpen,
  onOpenChange,
}: {
  householdId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const connect = useMutation({
    mutationFn: () =>
      api<Data<ConnectionSetup>>('POST', `/api/v1/households/${householdId}/simplefin/connect`, {
        body: { setupToken: token.trim() },
      }),
    onSuccess: async ({ data: setup }) => {
      queryClient.setQueryData(
        connectionSetupQuery(householdId, setup.connectionId).queryKey,
        setup,
      );
      setToken('');
      onOpenChange(false);
      await navigate({
        to: '/h/$householdId/connect/setup/$connectionId',
        params: { householdId, connectionId: setup.connectionId },
      });
    },
    onError: () =>
      queryClient.invalidateQueries({ queryKey: connectionsQuery(householdId).queryKey }),
  });
  const err = connect.error as ApiError | null;
  // Claimed, but the Bridge didn't answer: the connection is kept, to finish from Accounts.
  const kept = typeof err?.body.connectionId === 'string';

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (token.trim()) connect.mutate();
  };

  return (
    <Dialog title="Connect with SimpleFIN" isOpen={isOpen} onOpenChange={onOpenChange}>
      {(close) => (
        <Form onSubmit={onSubmit}>
          <div className="space-y-2 text-sm text-muted">
            <p>
              At the{' '}
              <a
                href={BRIDGE}
                target="_blank"
                rel="noreferrer"
                className="text-accent-text underline"
              >
                SimpleFIN Bridge
              </a>
              , connect your banks, then create a setup token for Fiscus and paste it here.
            </p>
            <p>
              Fiscus claims it once and keeps only the read-only access it gives, encrypted with
              this household’s key. Next you choose which accounts to track; nothing syncs until you
              do.
            </p>
          </div>
          {err ? (
            <Alert>
              {err.title}
              {err.detail ? ` ${err.detail}` : null}
            </Alert>
          ) : null}
          <TextField
            label="Setup token"
            name="setupToken"
            multiline
            isRequired
            autoFocus
            value={token}
            onChange={(value) => {
              setToken(value);
              // A new token: the last one's error no longer applies.
              if (connect.error) connect.reset();
            }}
            spellCheck="false"
            autoComplete="off"
            inputClassName="font-mono text-xs"
          />
          <DialogActions>
            <Button variant="secondary" onPress={close}>
              {kept ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" isPending={connect.isPending} isDisabled={!token.trim()}>
              Connect
            </Button>
          </DialogActions>
        </Form>
      )}
    </Dialog>
  );
}
