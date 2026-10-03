import type { InviteSummary } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Copy, Monitor } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { householdQuery, meQuery, membersQuery, sessionsQuery } from '../api/queries.js';
import { Alert, Button, Card, Field, Input, Select } from '../components/ui.js';
import { applyTheme, storedTheme, type ThemePreference } from '../lib/theme.js';

const STYLE_LABELS = {
  combined: "It's all ours",
  hybrid: 'Yours, mine, and ours',
  separate: 'Separate, split shared costs',
  roommates: 'Roommates',
};

export function HouseholdSettingsPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const isOwner = household.you.role === 'owner';
  const [link, setLink] = useState<string>();
  const queryClient = useQueryClient();
  const invite = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ data: { invite: InviteSummary; url: string } }>(
        'POST',
        `/api/v1/households/${householdId}/invites`,
        { body },
      ),
    onSuccess: (r) => {
      setLink(r.data.url);
      void queryClient.invalidateQueries({ queryKey: ['households', householdId] });
    },
  });
  const err = invite.error as ApiError | null;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-10">
      <h1 className="text-2xl font-semibold">Household settings</h1>
      <Card>
        <h2 className="mb-3 font-semibold">General</h2>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Name</dt>
          <dd>{household.name}</dd>
          <dt className="text-muted">Currency</dt>
          <dd>{household.baseCurrency}</dd>
          <dt className="text-muted">Time zone</dt>
          <dd>{household.timezone}</dd>
          <dt className="text-muted">Finance style</dt>
          <dd>{STYLE_LABELS[household.financeStyle]}</dd>
          <dt className="text-muted">Your role</dt>
          <dd className="capitalize">{household.you.role}</dd>
        </dl>
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">Members</h2>
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-2 text-sm">
              <span aria-hidden className="size-3 rounded-full" style={{ background: m.color }} />
              <span className="flex-1">
                {m.displayName}
                {m.isYou ? ' (you)' : ''}
                {m.email ? <span className="ml-2 text-muted">{m.email}</span> : null}
              </span>
              <span className="capitalize text-muted">{m.role}</span>
            </li>
          ))}
        </ul>
        {isOwner ? (
          <form
            className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-[1fr_9rem_auto] md:items-end"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              invite.mutate(
                Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>,
              );
            }}
          >
            <Field
              label="Invite by email"
              error={
                err?.fieldError('email') ?? (err && err.errors.length === 0 ? err.title : undefined)
              }
            >
              {(p) => (
                <Input
                  {...p}
                  name="email"
                  type="email"
                  required
                  placeholder="partner@example.com"
                />
              )}
            </Field>
            <Field label="Role">
              {(p) => (
                <Select
                  {...p}
                  name="role"
                  defaultValue={
                    household.financeStyle === 'combined' || household.financeStyle === 'hybrid'
                      ? 'owner'
                      : 'member'
                  }
                >
                  <option value="owner">Co-owner</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </Select>
              )}
            </Field>
            <Button type="submit" busy={invite.isPending}>
              Create invite link
            </Button>
          </form>
        ) : null}
        {link ? (
          <div className="mt-3 space-y-2">
            <Alert tone="success">
              Invite created. Share this link with them; it works once and expires in 7 days.
            </Alert>
            <div className="flex gap-2">
              <Input
                readOnly
                value={link}
                aria-label="Invite link"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="secondary"
                type="button"
                onClick={() => void navigator.clipboard?.writeText(link)}
                aria-label="Copy invite link"
              >
                <Copy aria-hidden className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

export function PersonalSettingsPage() {
  const me = useSuspenseQuery(meQuery).data;
  const sessions = useQuery(sessionsQuery);
  const queryClient = useQueryClient();
  const [theme, setTheme] = useState<ThemePreference>(storedTheme);
  const revoke = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/v1/me/sessions/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] }),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-10">
      <h1 className="text-2xl font-semibold">Personal settings</h1>
      <Card>
        <h2 className="mb-3 font-semibold">Profile</h2>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Name</dt>
          <dd>{me.displayName}</dd>
          <dt className="text-muted">Email</dt>
          <dd>{me.email}</dd>
          {me.isInstanceAdmin ? (
            <>
              <dt className="text-muted">Role</dt>
              <dd>Instance admin</dd>
            </>
          ) : null}
        </dl>
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">Appearance</h2>
        <div role="radiogroup" aria-label="Theme" className="flex gap-2">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <Button
              key={t}
              role="radio"
              aria-checked={theme === t}
              variant={theme === t ? 'primary' : 'secondary'}
              onClick={() => (setTheme(t), applyTheme(t))}
              className="capitalize"
            >
              {t}
            </Button>
          ))}
        </div>
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">Signed-in devices</h2>
        <ul className="divide-y divide-border">
          {(sessions.data ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
              <Monitor aria-hidden className="size-4 text-muted" />
              <span className="flex-1">
                <span className="block truncate">{s.userAgent ?? 'Unknown device'}</span>
                <span className="text-xs text-muted">
                  Last active {new Date(s.lastSeenAt).toLocaleString()}
                  {s.ip ? ` · ${s.ip}` : ''}
                </span>
              </span>
              {s.current ? (
                <span className="text-xs text-muted">This device</span>
              ) : (
                <Button
                  variant="danger"
                  onClick={() => revoke.mutate(s.id)}
                  busy={revoke.isPending && revoke.variables === s.id}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
