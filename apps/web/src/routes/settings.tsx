// SPDX-License-Identifier: AGPL-3.0-or-later
import type { InviteSummary } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Copy, Monitor } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { SourceLinks } from '../components/About.js';
import { CategoriesSettings } from './categories-settings.js';
import { householdQuery, meQuery, membersQuery, sessionsQuery } from '../api/queries.js';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  DateText,
  Form,
  SegmentedControl,
  Select,
  SelectItem,
  TextField,
  toast,
  Tooltip,
} from '../components/ui.js';
import { applyDensity, type Density, storedDensity } from '../lib/density.js';
import { applyTheme, storedTheme, type ThemePreference } from '../lib/theme.js';

const ROLE_LABELS = { owner: 'Owner', member: 'Member', viewer: 'Viewer' };

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
          <dd>{ROLE_LABELS[household.you.role]}</dd>
        </dl>
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">Members</h2>
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-2 text-sm">
              <Avatar name={m.displayName} color={m.color} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {m.displayName}
                  {m.isYou ? ' (you)' : ''}
                </span>
                {m.email ? <span className="block truncate text-muted">{m.email}</span> : null}
              </span>
              <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABELS[m.role]}</Badge>
            </li>
          ))}
        </ul>
        {isOwner ? (
          <Form
            className="mt-4 grid gap-3 space-y-0 border-t border-border pt-4 md:grid-cols-[1fr_9rem_auto] md:items-start"
            validationErrors={err?.fieldErrors()}
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              invite.mutate(
                Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>,
              );
            }}
          >
            <TextField
              label="Invite by email"
              name="email"
              type="email"
              isRequired
              placeholder="partner@example.com"
              {...(err?.formError ? { isInvalid: true, errorMessage: err.formError } : {})}
            />
            <Select
              label="Role"
              name="role"
              defaultValue={
                household.financeStyle === 'combined' || household.financeStyle === 'hybrid'
                  ? 'owner'
                  : 'member'
              }
            >
              <SelectItem id="owner">Co-owner</SelectItem>
              <SelectItem id="member">Member</SelectItem>
              <SelectItem id="viewer">Viewer</SelectItem>
            </Select>
            <Button type="submit" isPending={invite.isPending} className="md:mt-6.5">
              Create invite link
            </Button>
          </Form>
        ) : null}
        {link ? (
          <div className="mt-3 space-y-2">
            <Alert tone="success">
              Invite created. Share this link with them; it works once and expires in 7 days.
            </Alert>
            <div className="flex gap-2">
              <TextField
                aria-label="Invite link"
                value={link}
                isReadOnly
                className="flex-1"
                onFocus={(e) => (e.target as HTMLInputElement).select()}
              />
              <Tooltip content="Copy link">
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Copy invite link"
                  onPress={() =>
                    void navigator.clipboard
                      ?.writeText(link)
                      .then(() => toast('Invite link copied.'))
                  }
                >
                  <Copy aria-hidden className="size-4" />
                </Button>
              </Tooltip>
            </div>
          </div>
        ) : null}
      </Card>
      <CategoriesSettings householdId={householdId} canEdit={household.you.role !== 'viewer'} />
    </div>
  );
}

export function PersonalSettingsPage() {
  const me = useSuspenseQuery(meQuery).data;
  const sessions = useQuery(sessionsQuery);
  const queryClient = useQueryClient();
  const [theme, setTheme] = useState<ThemePreference>(storedTheme);
  const [density, setDensity] = useState<Density>(storedDensity);
  const revoke = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/v1/me/sessions/${id}`),
    onSuccess: () => {
      toast('Signed out that device.');
      void queryClient.invalidateQueries({ queryKey: ['me', 'sessions'] });
    },
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
        <h3 className="mb-2 text-sm font-medium">Theme</h3>
        <SegmentedControl
          aria-label="Theme"
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          value={theme}
          onChange={(t) => (setTheme(t), applyTheme(t))}
        />
        <h3 className="mb-2 mt-5 text-sm font-medium">Density</h3>
        <SegmentedControl
          aria-label="Density"
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
          value={density}
          onChange={(d) => (setDensity(d), applyDensity(d))}
        />
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
                  Last active <DateText value={s.lastSeenAt} format="datetime" />
                  {s.ip ? ` · ${s.ip}` : ''}
                </span>
              </span>
              {s.current ? (
                <Badge>This device</Badge>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  onPress={() => revoke.mutate(s.id)}
                  isPending={revoke.isPending && revoke.variables === s.id}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">About</h2>
        <SourceLinks size="sm" />
      </Card>
    </div>
  );
}
