// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useCallback, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { Alert, Button, Dialog, DialogActions, Form, TextField } from './ui.js';

/** The person closed "Confirm your password" instead: nothing happened, and nothing to report. */
export class ReauthCancelled extends Error {
  constructor() {
    super('Re-authentication cancelled');
    this.name = 'ReauthCancelled';
  }
}

function ConfirmPasswordDialog({
  onConfirmed,
  onCancel,
}: {
  onConfirmed: () => Promise<void>;
  onCancel: () => void;
}) {
  const confirm = useMutation({
    mutationFn: (password: string) => api('POST', '/api/v1/auth/reauth', { body: { password } }),
    onSuccess: onConfirmed,
  });
  const err = confirm.error as ApiError | null;
  return (
    <Dialog
      title="Confirm your password"
      size="sm"
      isOpen
      onOpenChange={(open) => !open && !confirm.isPending && onCancel()}
    >
      <Form
        validationErrors={
          err?.code === 'invalid_credentials' ? { password: 'That password isn’t right' } : {}
        }
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          confirm.mutate(String(new FormData(e.currentTarget).get('password')));
        }}
      >
        {err && err.code !== 'invalid_credentials' ? <Alert>{err.title}</Alert> : null}
        <p className="text-sm text-muted">
          It’s been a few minutes since you signed in. Enter your password again to make this
          change.
        </p>
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          isRequired
          autoFocus
        />
        <DialogActions>
          <Button variant="secondary" onPress={onCancel} isDisabled={confirm.isPending}>
            Cancel
          </Button>
          <Button type="submit" isPending={confirm.isPending}>
            Confirm
          </Button>
        </DialogActions>
      </Form>
    </Dialog>
  );
}

interface Pending {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * For actions that need a recent sign-in (API conventions §7): `withRecentAuth(fn)` runs `fn`, and
 * if the server answers `reauth_required`, asks for the password, then runs it again. Render
 * `dialog` somewhere in the component. Cancelling rejects with ReauthCancelled.
 */
export function useRecentAuth(): {
  withRecentAuth: <T>(fn: () => Promise<T>) => Promise<T>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const withRecentAuth = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'reauth_required')) throw err;
      return new Promise<T>((resolve, reject) =>
        setPending({ run: fn, resolve: resolve as (v: unknown) => void, reject }),
      );
    }
  }, []);
  const dialog = pending ? (
    <ConfirmPasswordDialog
      onConfirmed={async () => {
        setPending(null);
        try {
          pending.resolve(await pending.run());
        } catch (err) {
          pending.reject(err);
        }
      }}
      onCancel={() => {
        setPending(null);
        pending.reject(new ReauthCancelled());
      }}
    />
  ) : null;
  return { withRecentAuth, dialog };
}
