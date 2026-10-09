// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Household, InviteSummary, MemberRole } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Share2, UserPlus } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  Alert,
  Badge,
  Button,
  DateText,
  Dialog,
  DialogActions,
  Form,
  Select,
  SelectItem,
  TextField,
  toast,
} from '../components/ui.js';

type Data<T> = { data: T };

const ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Co-owner',
  member: 'Member',
  viewer: 'Viewer',
};

const ROLE_HELP: Record<MemberRole, string> = {
  owner: 'Manages the household with you: settings, members, and invites.',
  member: 'Adds accounts and transactions, and works with what’s shared.',
  viewer: 'Sees what’s shared with the household; changes nothing.',
};

export const invitesQueryKey = (householdId: string) => ['households', householdId, 'invites'];

/**
 * Copies text. The Clipboard API only works on HTTPS or localhost, and a LAN instance on plain
 * HTTP is neither, so this falls back to selecting the text and the older copy command.
 */
export async function copyText(text: string, field?: HTMLInputElement | null): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const input = field ?? Object.assign(document.createElement('textarea'), { value: text });
  if (!field) document.body.append(input);
  input.select();
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  if (!field) input.remove();
  return ok;
}

/** The link an invite makes, with Copy, and Share where the device has a share sheet. */
function InviteLink({ url, householdName }: { url: string; householdName: string }) {
  const field = useRef<HTMLInputElement>(null);
  const canShare = typeof navigator.share === 'function';
  return (
    <div className="space-y-3">
      <Alert tone="success">
        Invite created. Send them this link: it works once, for that email, and expires in 7 days.
      </Alert>
      <TextField
        aria-label="Invite link"
        value={url}
        isReadOnly
        inputRef={field}
        onFocus={(e) => (e.target as HTMLInputElement).select()}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onPress={async () => {
            const ok = await copyText(url, field.current);
            toast(ok ? 'Invite link copied.' : 'Couldn’t copy: select the link and copy it.', {
              ...(ok ? {} : { tone: 'error' as const }),
            });
          }}
        >
          <Copy aria-hidden className="size-4" /> Copy link
        </Button>
        {canShare ? (
          <Button
            variant="secondary"
            onPress={() =>
              void navigator
                .share({ title: `Join ${householdName} on Fiscus`, url })
                .catch(() => undefined)
            }
          >
            <Share2 aria-hidden className="size-4" /> Share
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Invite someone" (HH-04, owners): an email and a role make a one-time link to send them. No
 * email goes out yet (that's M4), so the link is what you share.
 */
export function InviteDialog({
  household,
  isOpen,
  onOpenChange,
  initial,
}: {
  household: Household;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** A new link for someone already invited. */
  initial?: { email: string; role: MemberRole } | undefined;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const [role, setRole] = useState<MemberRole>(
    initial?.role ??
      (household.financeStyle === 'combined' || household.financeStyle === 'hybrid'
        ? 'owner'
        : 'member'),
  );
  const create = useMutation({
    mutationFn: (body: { email: string; role: MemberRole }) =>
      api<Data<{ invite: InviteSummary; url: string }>>(
        'POST',
        `/api/v1/households/${household.id}/invites`,
        { body },
      ),
    onSuccess: async (r) => {
      setUrl(r.data.url);
      await queryClient.invalidateQueries({ queryKey: invitesQueryKey(household.id) });
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
    <Dialog title={`Invite someone to ${household.name}`} isOpen={isOpen} onOpenChange={close}>
      {url ? (
        <div className="space-y-4">
          <InviteLink url={url} householdName={household.name} />
          <DialogActions>
            <Button onPress={() => close(false)}>Done</Button>
          </DialogActions>
        </div>
      ) : (
        <Form
          validationErrors={err?.fieldErrors()}
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            create.mutate({ email: String(new FormData(e.currentTarget).get('email')), role });
          }}
        >
          {err?.formError ? <Alert>{err.formError}</Alert> : null}
          <TextField
            label="Their email"
            name="email"
            type="email"
            isRequired
            autoFocus
            defaultValue={initial?.email}
            placeholder="partner@example.com"
            description="They sign in, or create their account, with this email to join."
          />
          <Select
            label="As"
            value={role}
            onChange={(v) => v && setRole(v as MemberRole)}
            description={ROLE_HELP[role]}
          >
            {(['owner', 'member', 'viewer'] as const).map((r) => (
              <SelectItem key={r} id={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </Select>
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

/** "Invite someone": the button, and its dialog. */
export function InviteButton({
  household,
  variant = 'secondary',
}: {
  household: Household;
  variant?: 'primary' | 'secondary';
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size="sm" onPress={() => setOpen(true)}>
        <UserPlus aria-hidden className="size-4" /> Invite someone
      </Button>
      <InviteDialog household={household} isOpen={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Invites not yet accepted (owners): who, as what, until when. A link can't be shown again once
 * made, so "New link" replaces it, and Cancel stops it working.
 */
export function PendingInvites({ household }: { household: Household }) {
  const queryClient = useQueryClient();
  const invites = useQuery({
    queryKey: invitesQueryKey(household.id),
    queryFn: async () =>
      (await api<Data<InviteSummary[]>>('GET', `/api/v1/households/${household.id}/invites`)).data,
  });
  const [again, setAgain] = useState<InviteSummary | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/v1/households/${household.id}/invites/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: invitesQueryKey(household.id) });
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const list = invites.data ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="pending-invites" className="mt-4 border-t border-border pt-4">
      <h3 id="pending-invites" className="mb-2 text-sm font-medium">
        Waiting to join
      </h3>
      <ul className="divide-y divide-border">
        {list.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{i.email}</span>
              <span className="text-xs text-muted">
                Link expires <DateText value={i.expiresAt} format="date" />
              </span>
            </span>
            <Badge>{ROLE_LABELS[i.role]}</Badge>
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
        <InviteDialog
          key={again.id}
          household={household}
          isOpen
          onOpenChange={(open) => !open && setAgain(null)}
          initial={{ email: again.email, role: again.role }}
        />
      ) : null}
    </section>
  );
}
