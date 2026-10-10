// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ServerInvite } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, UserPlus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { authStatusQuery, meQuery, serverInvitesQuery } from '../api/queries.js';
import {
  Alert,
  Button,
  Card,
  DateText,
  Dialog,
  DialogActions,
  Form,
  TextField,
  toast,
} from '../components/ui.js';
import { InviteLink } from './invites.js';

type Data<T> = { data: T };

/** Back to the household you were in (home picks the last one). */
export function BackHome() {
  return (
    <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
      <ChevronLeft aria-hidden className="size-4" /> Back
    </Link>
  );
}

/**
 * "Invite someone to this server" (ADM-08): an email makes a one-time link. They create their
 * account with it and start their own household; nothing of yours is shared with them.
 */
function ServerInviteDialog({
  isOpen,
  onOpenChange,
  initialEmail,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** A new link for someone already invited. */
  initialEmail?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (email: string) =>
      api<Data<{ invite: ServerInvite; url: string }>>('POST', '/api/v1/admin/invites', {
        body: { email },
      }),
    onSuccess: async (r) => {
      setUrl(r.data.url);
      await queryClient.invalidateQueries({ queryKey: serverInvitesQuery.queryKey });
    },
  });
  const err = create.error as ApiError | null;
  const close = (open: boolean) => {
    if (!open) {
      setUrl(null);
      create.reset();
    }
    onOpenChange(open);
  };
  return (
    <Dialog title="Invite someone to this server" isOpen={isOpen} onOpenChange={close}>
      {url ? (
        <div className="space-y-4">
          <InviteLink url={url} shareTitle="Join Fiscus" />
          <DialogActions>
            <Button onPress={() => close(false)}>Done</Button>
          </DialogActions>
        </div>
      ) : (
        <Form
          validationErrors={err?.fieldErrors()}
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            create.mutate(String(new FormData(e.currentTarget).get('email')));
          }}
        >
          {err?.formError ? <Alert>{err.formError}</Alert> : null}
          <p className="text-sm text-muted">
            They create an account and start their own household. Nothing of yours is shared with
            them; to share a household, invite them from its menu instead.
          </p>
          <TextField
            label="Their email"
            name="email"
            type="email"
            isRequired
            autoFocus
            defaultValue={initialEmail}
            placeholder="friend@example.com"
            description="They create their account with this email."
          />
          <DialogActions>
            <Button variant="secondary" onPress={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" isPending={create.isPending}>
              Create invite link
            </Button>
          </DialogActions>
        </Form>
      )}
    </Dialog>
  );
}

/** Server invites not yet used: who, until when; New link replaces one, Cancel stops it. */
function PendingServerInvites() {
  const queryClient = useQueryClient();
  const invites = useQuery(serverInvitesQuery);
  const [again, setAgain] = useState<ServerInvite | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/v1/admin/invites/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: serverInvitesQuery.queryKey });
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const list = invites.data ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="pending-server-invites" className="mt-4 border-t border-border pt-4">
      <h3 id="pending-server-invites" className="mb-2 text-sm font-medium">
        Waiting to join
      </h3>
      <ul className="divide-y divide-border">
        {list.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{i.email}</span>
              <span className="text-xs text-muted">
                Link expires <DateText value={i.expiresAt} format="date" />
                {i.invitedBy ? ` · invited by ${i.invitedBy}` : ''}
              </span>
            </span>
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onPress={async () => {
                  // The old link stops working; a new one goes in its place.
                  await cancel.mutateAsync(i.id);
                  setAgain(i);
                }}
              >
                New link
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Cancel the invite for ${i.email}`}
                onPress={() => cancel.mutate(i.id, { onSuccess: () => toast('Invite cancelled.') })}
              >
                Cancel
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {again ? (
        <ServerInviteDialog
          key={again.id}
          isOpen
          onOpenChange={(open) => !open && setAgain(null)}
          initialEmail={again.email}
        />
      ) : null}
    </section>
  );
}

/** The server (instance admins): who may make an account here. */
export function ServerPage() {
  const me = useSuspenseQuery(meQuery).data;
  const status = useQuery(authStatusQuery);
  const [open, setOpen] = useState(false);
  if (!me.isInstanceAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 md:px-8 md:py-10">
        <BackHome />
        <h1 className="text-2xl font-semibold">Server</h1>
        <Alert>Only the server’s admin can manage it.</Alert>
      </div>
    );
  }
  const mode = status.data?.signupMode;
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-10">
      <div>
        <BackHome />
        <h1 className="mt-2 text-2xl font-semibold">Server</h1>
        <p className="text-sm text-muted">Who can make an account on this Fiscus server.</p>
      </div>
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="mr-auto font-semibold">Invites</h2>
          <Button size="sm" onPress={() => setOpen(true)} isDisabled={mode === 'closed'}>
            <UserPlus aria-hidden className="size-4" /> Invite someone
          </Button>
        </div>
        <p className="text-sm text-muted">
          {mode === 'open'
            ? 'Anyone who can reach this server can sign up. An invite link still saves them a step.'
            : mode === 'closed'
              ? 'New accounts are turned off (FISCUS_SIGNUP_MODE=closed), so invite links won’t work. Set it to invite_only to invite people.'
              : 'Only people you invite can make an account. They start their own household; to share yours, invite them from the household menu.'}
        </p>
        <PendingServerInvites />
      </Card>
      <ServerInviteDialog isOpen={open} onOpenChange={setOpen} />
    </div>
  );
}
