// SPDX-License-Identifier: AGPL-3.0-or-later
import { type HouseholdMember, MEMBER_COLORS } from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { SourceLinks } from '../components/About.js';
import { CategoriesSettings } from './categories-settings.js';
import { HouseholdGeneral } from './household-general.js';
import { InviteButton, InviteDialog, PendingInvites } from './invites.js';
import { MakeJointOffer } from './make-joint.js';
import { householdQuery, meQuery, membersQuery, sessionsQuery } from '../api/queries.js';
import {
  Avatar,
  Badge,
  Button,
  Card,
  DateText,
  Form,
  Radio,
  RadioGroup,
  SegmentedControl,
  TextField,
  toast,
} from '../components/ui.js';
import { BackHome } from './server.js';
import { applyDensity, type Density, storedDensity } from '../lib/density.js';
import { describeDevice } from '../lib/device.js';
import { applyTheme, storedTheme, type ThemePreference } from '../lib/theme.js';

const ROLE_LABELS = { owner: 'Owner', member: 'Member', viewer: 'Viewer' };

const COLOR_NAMES: Record<string, string> = {
  '#2f6fdb': 'Blue',
  '#c2410c': 'Orange',
  '#7c4dcc': 'Violet',
  '#be3d86': 'Magenta',
  '#0e7490': 'Cyan',
  '#6b7d1f': 'Olive',
  '#9a5b34': 'Brown',
  '#5d6f8a': 'Slate',
};

/**
 * How you appear in this household (#51, HH-18): your name and color, shown on everything you
 * pay for or that's for you. Each member has their own color.
 */
function YouInHousehold({
  householdId,
  members,
}: {
  householdId: string;
  members: HouseholdMember[];
}) {
  const me = members.find((m) => m.isYou)!;
  const [name, setName] = useState(me.displayName);
  const [color, setColor] = useState(me.color);
  const queryClient = useQueryClient();
  const changes = {
    ...(name.trim() !== me.displayName ? { displayName: name.trim() } : {}),
    ...(color !== me.color ? { color } : {}),
  };
  const save = useMutation({
    mutationFn: () => api('PATCH', `/api/v1/households/${householdId}/me`, { body: changes }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId] });
      toast('Saved.');
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const takenBy = new Map(members.filter((m) => !m.isYou).map((m) => [m.color, m.displayName]));
  return (
    <Card>
      <h2 className="mb-1 font-semibold">How you appear here</h2>
      <p className="mb-4 text-sm text-muted">
        Your name and color in this household, on what you pay for and what’s for you.
      </p>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex items-end gap-3">
          <Avatar name={name || me.displayName} color={color} />
          <TextField
            label="Your name here"
            value={name}
            onChange={setName}
            isRequired
            maxLength={80}
            className="flex-1"
          />
        </div>
        <RadioGroup
          label="Your color"
          value={color}
          onChange={setColor}
          orientation="horizontal"
          className="flex-row flex-wrap gap-x-4"
        >
          {MEMBER_COLORS.map((c) => (
            <Radio key={c} value={c} isDisabled={takenBy.has(c)}>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="size-4 rounded-full" style={{ background: c }} />
                {COLOR_NAMES[c] ?? c}
                {takenBy.has(c) ? <span className="text-muted">({takenBy.get(c)})</span> : null}
              </span>
            </Radio>
          ))}
        </RadioGroup>
        <div className="flex justify-end">
          <Button
            type="submit"
            isPending={save.isPending}
            isDisabled={Object.keys(changes).length === 0 || !name.trim()}
          >
            Save
          </Button>
        </div>
      </Form>
    </Card>
  );
}

export function HouseholdSettingsPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const isOwner = household.you.role === 'owner';
  const search = useSearch({ strict: false }) as { invite?: string };
  const navigate = useNavigate();
  // "Invite someone" in the household menu opens this page with ?invite=1.
  const inviteOpen = search.invite === '1' && isOwner;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-10">
      <h1 className="text-2xl font-semibold">Household settings</h1>
      <HouseholdGeneral
        key={household.version}
        household={household}
        memberCount={members.length}
      />
      <p className="-mt-3 px-1 text-sm text-muted">Your role: {ROLE_LABELS[household.you.role]}</p>
      <MakeJointOffer householdId={householdId} />
      {members.some((m) => m.isYou) ? (
        <YouInHousehold
          key={members.map((m) => `${m.id}:${m.displayName}:${m.color}`).join()}
          householdId={householdId}
          members={members}
        />
      ) : null}
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto font-semibold">Members</h2>
          {isOwner ? (
            <>
              <InviteButton household={household} />
              {/* From "Invite someone" in the household menu. */}
              <InviteDialog
                household={household}
                isOpen={inviteOpen}
                onOpenChange={(open) => {
                  if (!open) void navigate({ to: '.', search: {}, replace: true });
                }}
              />
            </>
          ) : null}
        </div>
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
        {isOwner ? <PendingInvites household={household} /> : null}
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
      <div>
        <BackHome />
        <h1 className="mt-2 text-2xl font-semibold">Personal settings</h1>
      </div>
      <Card>
        <h2 className="mb-3 font-semibold">Profile</h2>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-muted">Name</dt>
          <dd>{me.displayName}</dd>
          <dt className="text-muted">Email</dt>
          <dd className="break-all">{me.email}</dd>
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
              {/(Android|iOS)$/.test(describeDevice(s.userAgent)) ? (
                <Smartphone aria-hidden className="size-4 shrink-0 text-muted" />
              ) : (
                <Monitor aria-hidden className="size-4 shrink-0 text-muted" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={s.userAgent ?? undefined}>
                  {describeDevice(s.userAgent)}
                </span>
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
