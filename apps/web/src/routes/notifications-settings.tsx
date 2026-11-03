// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ChannelTestStatus,
  CHANNEL_LABELS,
  describeChannelError,
  describeRuleTiming,
  type DetailLevel,
  type ExternalChannelKind,
  NOTIFICATION_KIND_DEFINITIONS,
  NTFY_DEFAULT_SERVER,
  type NotificationChannelKind,
  type NotificationChannelView,
  type NotificationKind,
  type NotificationRuleView,
  type NotificationSettingsView,
  WEEKDAYS,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { api, type ApiError } from '../api/client.js';
import { accountsQuery, householdQuery, notificationSettingsQuery } from '../api/queries.js';
import {
  Alert,
  AmountInput,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  Form,
  LoadingRegion,
  Select,
  SelectItem,
  Skeleton,
  TextField,
  toast,
} from '../components/ui.js';
import { MEDIUM, useMediaQuery } from '../lib/media.js';

// Settings → Notifications (bills walkthrough §7, D15–D18; #125, #126, #130): yours only.
// Where to send them: In Fiscus (always on), email (set up by whoever runs the server), and the
// channels you set up yourself. What to send: one row per kind, with when it's sent and a tick for
// each channel. A phone shows the rows as a list, each opening its settings (prototype 14).

type Data<T> = { data: T };

const DETAIL_LABELS: Record<DetailLevel, string> = {
  full: 'Full detail',
  summary: 'Summary',
  minimal: 'Minimal',
};

/** What each channel's row is called, and says before it's set up. */
const CHANNEL_ROWS: Record<ExternalChannelKind, { title: string; about: string }> = {
  email: { title: 'Email', about: 'From the server’s mail settings' },
  ntfy: { title: 'Phone, through ntfy', about: 'ntfy.sh or your own server' },
  gotify: { title: 'Gotify', about: 'Your own Gotify server' },
  webhook: { title: 'Webhook', about: 'For your own server or home automation' },
};

export const EMAIL_UNAVAILABLE = 'Your server can’t send email yet; ask whoever runs it.';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const formatHour = (h: number) =>
  h === 0 ? 'Midnight' : h === 12 ? 'Noon' : h < 12 ? `${h} am` : `${h - 12} pm`;
const DAY_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14];
const PERCENT_CHOICES = [50, 75, 80, 85, 90, 95, 100];

/** The channels a rule can tick: In Fiscus, email, and the push channels you've set up. */
export function ruleColumns(settings: NotificationSettingsView): NotificationChannelKind[] {
  return [
    'in_app',
    'email',
    ...settings.channels.filter((c) => c.kind !== 'email' && c.configured).map((c) => c.kind),
  ];
}

const url = (householdId: string, path = '') =>
  `/api/v1/households/${householdId}/notifications${path}`;

function useSettingsMutation<T>(householdId: string, fn: (vars: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: T) => (await fn(vars)) as Data<NotificationSettingsView>,
    onSuccess: (r) => {
      queryClient.setQueryData(notificationSettingsQuery(householdId).queryKey, r.data);
    },
  });
}

/** The route's page. */
export function NotificationsSettingsPage() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  return <NotificationsSettings householdId={householdId} />;
}

export function NotificationsSettings({ householdId }: { householdId: string }) {
  const settings = useQuery(notificationSettingsQuery(householdId));
  const wide = useMediaQuery(MEDIUM);
  if (settings.isPending) {
    return (
      <LoadingRegion label="Loading notification settings">
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </LoadingRegion>
    );
  }
  if (!settings.data) return <Alert>Notification settings couldn’t be loaded.</Alert>;
  return (
    <>
      <WhereToSend householdId={householdId} settings={settings.data} wide={wide} />
      <WhatToSend householdId={householdId} settings={settings.data} wide={wide} />
    </>
  );
}

// ——— Where to send them ———

function WhereToSend({
  householdId,
  settings,
  wide,
}: {
  householdId: string;
  settings: NotificationSettingsView;
  wide: boolean;
}) {
  const [editing, setEditing] = useState<ExternalChannelKind | null>(null);
  const setDetail = useSettingsMutation(
    householdId,
    (v: { channel: NotificationChannelView; detail: DetailLevel }) =>
      api('PUT', url(householdId, `/channels/${v.channel.kind}`), {
        body: { detail: v.detail, ...(v.channel.server ? { server: v.channel.server } : {}) },
      }),
  );
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Where to send them</h2>
      <p className="mb-4 text-sm text-muted">
        Yours only: everyone in the household chooses their own.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        <li className="flex items-center gap-3 px-3 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium">In Fiscus</span>
            <span className="block text-sm text-muted">The bell, at the top of every page</span>
          </span>
          <Badge tone="positive">Always on</Badge>
        </li>
        {settings.channels.map((c) => {
          // Email needs the server's mail settings, and an address to send to.
          const unavailable = c.kind === 'email' && !c.configured;
          const why = settings.emailAvailable
            ? 'There’s no email address to send to.'
            : EMAIL_UNAVAILABLE;
          const about = unavailable
            ? why
            : !c.configured
              ? CHANNEL_ROWS[c.kind].about
              : c.kind === 'email'
                ? `${c.hint} · from the server’s mail settings`
                : [c.server, c.hint].filter(Boolean).join(' · ');
          if (!wide) {
            // A phone: the row opens the channel's settings.
            return (
              <li key={c.kind}>
                <AriaButton
                  isDisabled={unavailable}
                  onPress={() => setEditing(c.kind)}
                  className="flex w-full items-center gap-3 px-3 py-3 text-left outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{CHANNEL_ROWS[c.kind].title}</span>
                    <span className="block text-sm text-muted">
                      {unavailable
                        ? why
                        : c.configured
                          ? `${c.kind === 'email' ? `${c.hint} · ` : ''}${DETAIL_LABELS[c.detail].toLowerCase()}`
                          : 'Not set up'}
                    </span>
                  </span>
                  {unavailable ? null : <ChevronRight aria-hidden className="size-4 text-muted" />}
                </AriaButton>
              </li>
            );
          }
          return (
            <li key={c.kind} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{CHANNEL_ROWS[c.kind].title}</span>
                <span className="block truncate text-sm text-muted">{about}</span>
              </span>
              {c.configured ? (
                <>
                  <Select
                    aria-label={`${CHANNEL_ROWS[c.kind].title}: detail`}
                    value={c.detail}
                    onChange={(v) =>
                      v &&
                      setDetail.mutate(
                        { channel: c, detail: v as DetailLevel },
                        { onError: (e) => toast((e as ApiError).title, { tone: 'error' }) },
                      )
                    }
                    triggerClassName="w-36"
                  >
                    {Object.entries(DETAIL_LABELS).map(([id, label]) => (
                      <SelectItem key={id} id={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </Select>
                  <TestButton householdId={householdId} channel={c.kind} />
                  {c.kind === 'email' ? null : (
                    <Button variant="ghost" size="sm" onPress={() => setEditing(c.kind)}>
                      Change
                    </Button>
                  )}
                </>
              ) : unavailable ? null : (
                <Button variant="secondary" size="sm" onPress={() => setEditing(c.kind)}>
                  Set up
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-sm text-muted">
        <b>Full detail</b>: “$412.18 at Costco on Joint card”. <b>Summary</b>: “A bank connection
        needs you to sign in again”, without amounts or names. <b>Minimal</b>: “You have new
        activity in Fiscus”. Email and push services can read what they carry.
      </p>
      {editing ? (
        <ChannelDialog
          key={editing}
          householdId={householdId}
          channel={settings.channels.find((c) => c.kind === editing)!}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}

/** Sends a test through a channel and waits for the worker to say how it went. */
export function TestButton({
  householdId,
  channel,
  pollMs = 1_000,
  tries = 30,
}: {
  householdId: string;
  channel: ExternalChannelKind;
  pollMs?: number;
  tries?: number;
}) {
  const label = CHANNEL_ROWS[channel].title;
  const test = useMutation({
    mutationFn: async () => {
      const { data } = await api<Data<{ id: string }>>(
        'POST',
        url(householdId, `/channels/${channel}/test`),
      );
      for (let i = 0; i < tries; i++) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        const status = (
          await api<Data<ChannelTestStatus>>('GET', url(householdId, `/tests/${data.id}`))
        ).data;
        if (status.status !== 'pending') return status;
      }
      return { status: 'pending', code: null } as ChannelTestStatus;
    },
    onSuccess: (s) => {
      if (s.status === 'sent') toast(`Test sent. Check your ${label.toLowerCase()}.`);
      else if (s.status === 'failed') {
        toast(`The test didn’t go through. ${describeChannelError(s.code)}`, { tone: 'error' });
      } else {
        toast('Still sending. If it doesn’t arrive, ask whoever runs Fiscus to check its worker.');
      }
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  return (
    <Button
      variant="secondary"
      size="sm"
      isPending={test.isPending}
      onPress={() => test.mutate()}
      aria-label={`Send a test to ${label}`}
    >
      Send a test
    </Button>
  );
}

/** Setting up, changing or removing a channel. Saved secrets are never shown again. */
function ChannelDialog({
  householdId,
  channel,
  onClose,
}: {
  householdId: string;
  channel: NotificationChannelView;
  onClose: () => void;
}) {
  const kind = channel.kind;
  const [detail, setDetail] = useState<DetailLevel>(channel.detail);
  const [server, setServer] = useState(
    channel.server ?? (kind === 'ntfy' ? NTFY_DEFAULT_SERVER : ''),
  );
  const [topic, setTopic] = useState('');
  const [token, setToken] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [secret, setSecret] = useState('');
  const save = useSettingsMutation(householdId, () =>
    api('PUT', url(householdId, `/channels/${kind}`), {
      body: {
        detail,
        ...(kind === 'ntfy' || kind === 'gotify' ? { server } : {}),
        ...(kind === 'ntfy' && topic ? { topic } : {}),
        ...(kind === 'ntfy' && token ? { token } : {}),
        ...(kind === 'gotify' && token ? { token } : {}),
        ...(kind === 'webhook' && hookUrl ? { url: hookUrl } : {}),
        ...(kind === 'webhook' && secret ? { secret } : {}),
      },
    }),
  );
  const remove = useSettingsMutation(householdId, () =>
    api('DELETE', url(householdId, `/channels/${kind}`)),
  );
  const err = save.error as ApiError | null;
  const saved = channel.configured;
  const keep = saved ? 'Leave empty to keep the one saved.' : undefined;
  return (
    <Dialog
      title={CHANNEL_ROWS[kind].title}
      isOpen
      onOpenChange={(open) => !open && onClose()}
      variant="sheet"
    >
      <Form
        validationErrors={err?.fieldErrors()}
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          save.mutate(undefined, {
            onSuccess: () => {
              toast('Saved.');
              onClose();
            },
          });
        }}
      >
        {err?.formError ? <Alert>{err.formError}</Alert> : null}
        {kind === 'email' ? (
          <p className="text-sm text-muted">
            Sent to {channel.hint}, the address you sign in with, from the server’s mail settings.
          </p>
        ) : null}
        {kind === 'ntfy' ? (
          <>
            <p className="text-sm text-muted">
              Install the ntfy app on your phone and subscribe to a topic only you know. Anyone who
              knows a topic on ntfy.sh can read it, so make it long and hard to guess.
            </p>
            <TextField
              label="Server"
              name="server"
              value={server}
              onChange={setServer}
              isRequired
            />
            <TextField
              label="Topic"
              name="topic"
              value={topic}
              onChange={setTopic}
              isRequired={!saved}
              description={saved ? `Saved: ${channel.hint}. ${keep}` : 'Letters, numbers, - and _.'}
            />
            <TextField
              label="Access token (optional)"
              name="token"
              type="password"
              value={token}
              onChange={setToken}
              description={saved ? keep : 'For a server or topic that needs one.'}
            />
          </>
        ) : null}
        {kind === 'gotify' ? (
          <>
            <TextField
              label="Server"
              name="server"
              value={server}
              onChange={setServer}
              isRequired
            />
            <TextField
              label="Application token"
              name="token"
              type="password"
              value={token}
              onChange={setToken}
              isRequired={!saved}
              description={keep ?? 'Make an application for Fiscus in Gotify, and paste its token.'}
            />
          </>
        ) : null}
        {kind === 'webhook' ? (
          <>
            <TextField
              label="Address to post to"
              name="url"
              type="url"
              value={hookUrl}
              onChange={setHookUrl}
              isRequired={!saved}
              description={
                saved
                  ? `Saved: ${channel.hint}. ${keep}`
                  : 'Fiscus posts each notification as JSON.'
              }
            />
            <TextField
              label="Signing secret (optional)"
              name="secret"
              type="password"
              value={secret}
              onChange={setSecret}
              description={
                saved && channel.signed
                  ? keep
                  : 'Signs each request (X-Fiscus-Signature), so your server can tell it’s from Fiscus.'
              }
            />
          </>
        ) : null}
        <Select label="Detail" value={detail} onChange={(v) => v && setDetail(v as DetailLevel)}>
          {Object.entries(DETAIL_LABELS).map(([id, label]) => (
            <SelectItem key={id} id={id}>
              {label}
            </SelectItem>
          ))}
        </Select>
        <DialogActions>
          {saved && kind !== 'email' ? (
            <Button
              variant="ghost"
              className="mr-auto text-danger"
              isPending={remove.isPending}
              onPress={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast(`${CHANNEL_ROWS[kind].title} is off.`);
                    onClose();
                  },
                  onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
                })
              }
            >
              Turn off
            </Button>
          ) : null}
          {saved ? <TestButton householdId={householdId} channel={kind} /> : null}
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" isPending={save.isPending}>
            Save
          </Button>
        </DialogActions>
      </Form>
    </Dialog>
  );
}

// ——— What to send ———

function WhatToSend({
  householdId,
  settings,
  wide,
}: {
  householdId: string;
  settings: NotificationSettingsView;
  wide: boolean;
}) {
  const household = useQuery(householdQuery(householdId)).data;
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const currency = household?.baseCurrency ?? 'USD';
  const [editing, setEditing] = useState<NotificationKind | null>(null);
  const columns = ruleColumns(settings);
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const timing = (r: NotificationRuleView) =>
    describeRuleTiming(r.kind, r.settings, {
      currency,
      accountNames: (ids) =>
        ids.length === 1 ? (names.get(ids[0]!) ?? '1 account') : `${ids.length} accounts`,
    });
  const scope = (r: NotificationRuleView) => NOTIFICATION_KIND_DEFINITIONS[r.kind].scope;
  const setRule = useSettingsMutation(
    householdId,
    (v: { kind: NotificationKind; channels: NotificationChannelKind[] }) =>
      api('PUT', url(householdId, `/rules/${v.kind}`), { body: { channels: v.channels } }),
  );
  const toggle = (r: NotificationRuleView, c: NotificationChannelKind, on: boolean) =>
    setRule.mutate(
      {
        kind: r.kind,
        channels: on ? [...r.channels, c] : r.channels.filter((x) => x !== c),
      },
      { onError: (e) => toast((e as ApiError).title, { tone: 'error' }) },
    );
  const label = (c: NotificationChannelKind) => (c === 'ntfy' ? 'Phone' : CHANNEL_LABELS[c]);
  const emailOff = (c: NotificationChannelKind) => c === 'email' && !settings.emailAvailable;
  const rule = editing ? settings.rules.find((r) => r.kind === editing)! : null;

  return (
    <Card>
      <h2 className="mb-1 font-semibold">What to send</h2>
      <p className="mb-4 text-sm text-muted">
        {wide
          ? 'Tick where each one goes. Choose a name to change when it’s sent.'
          : 'Tap a row to change when it’s sent, and where.'}
      </p>
      {wide ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="py-2 font-medium">
                <span className="sr-only">Notification</span>
              </th>
              {columns.map((c) => (
                <th key={c} scope="col" className="w-20 py-2 text-center font-medium">
                  {label(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {settings.rules.map((r) => {
              const def = NOTIFICATION_KIND_DEFINITIONS[r.kind];
              return (
                <tr key={r.kind}>
                  <td className="py-2 pr-3">
                    <AriaButton
                      onPress={() => setEditing(r.kind)}
                      className="rounded text-left outline-none hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <span className="block font-medium">{def.label}</span>
                      <span className="block text-muted">
                        {[timing(r), scope(r)].filter(Boolean).join(' · ')}
                      </span>
                    </AriaButton>
                  </td>
                  {columns.map((c) => (
                    <td key={c} className="py-2 text-center">
                      <Checkbox
                        aria-label={`${def.label}: ${label(c)}`}
                        className="inline-flex justify-center"
                        isSelected={r.channels.includes(c) && !emailOff(c)}
                        isDisabled={emailOff(c)}
                        onChange={(on) => toggle(r, c, on)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {settings.rules.map((r) => (
            <li key={r.kind}>
              <AriaButton
                onPress={() => setEditing(r.kind)}
                className="block w-full px-3 py-3 text-left outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{NOTIFICATION_KIND_DEFINITIONS[r.kind].label}</span>
                  <ChevronRight aria-hidden className="size-4 text-muted" />
                </span>
                <span className="block text-sm text-muted">{timing(r)}</span>
                <span className="mt-1.5 flex flex-wrap gap-1">
                  {columns.map((c) => {
                    const on = r.channels.includes(c) && !emailOff(c);
                    return (
                      <Badge key={c} tone={on ? 'positive' : 'neutral'}>
                        {label(c)}
                        <span className="sr-only">{on ? ': on' : ': off'}</span>
                      </Badge>
                    );
                  })}
                </span>
              </AriaButton>
            </li>
          ))}
        </ul>
      )}
      {rule ? (
        <RuleDialog
          key={rule.kind}
          householdId={householdId}
          rule={rule}
          columns={columns}
          channelLabel={label}
          emailAvailable={settings.emailAvailable}
          currency={currency}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}

/** A rule's timing and channels (D18). */
function RuleDialog({
  householdId,
  rule,
  columns,
  channelLabel,
  emailAvailable,
  currency,
  accounts,
  onClose,
}: {
  householdId: string;
  rule: NotificationRuleView;
  columns: NotificationChannelKind[];
  channelLabel: (c: NotificationChannelKind) => string;
  emailAvailable: boolean;
  currency: string;
  accounts: { id: string; name: string }[];
  onClose: () => void;
}) {
  const def = NOTIFICATION_KIND_DEFINITIONS[rule.kind];
  const [channels, setChannels] = useState(rule.channels);
  const [s, setS] = useState(rule.settings as Record<string, unknown>);
  const set = (patch: Record<string, unknown>) => setS((old) => ({ ...old, ...patch }));
  const save = useSettingsMutation(householdId, () =>
    api('PUT', url(householdId, `/rules/${rule.kind}`), {
      body: { channels, settings: s },
    }),
  );
  const err = save.error as ApiError | null;
  const numberSelect = (
    labelText: string,
    key: string,
    choices: number[],
    text: (n: number) => string,
  ) => (
    <Select
      label={labelText}
      value={String(s[key])}
      onChange={(v) => v !== null && set({ [key]: Number(v) })}
    >
      {[...new Set([...choices, s[key] as number])]
        .sort((a, b) => a - b)
        .map((n) => (
          <SelectItem key={n} id={String(n)}>
            {text(n)}
          </SelectItem>
        ))}
    </Select>
  );
  const days = (n: number) => (n === 0 ? 'On the day' : `${n} day${n === 1 ? '' : 's'}`);

  return (
    <Dialog title={def.label} isOpen onOpenChange={(open) => !open && onClose()} variant="sheet">
      <Form
        validationErrors={err?.fieldErrors()}
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          save.mutate(undefined, {
            onSuccess: () => {
              toast('Saved.');
              onClose();
            },
          });
        }}
      >
        {err?.formError ? <Alert>{err.formError}</Alert> : null}
        {def.scope ? <p className="text-sm text-muted">About {def.scope}.</p> : null}
        {rule.kind === 'bill_due' || rule.kind === 'statement_due'
          ? numberSelect('How long before', 'daysBefore', DAY_CHOICES, days)
          : null}
        {rule.kind === 'late'
          ? numberSelect('How long after it was expected', 'daysAfter', DAY_CHOICES.slice(1), days)
          : null}
        {rule.kind === 'big_transaction' ? (
          <AmountInput
            label="Over"
            currency={currency}
            value={s.overMinor as number}
            onChange={(v) => v !== null && set({ overMinor: Math.abs(v) })}
          />
        ) : null}
        {rule.kind === 'low_balance' ? (
          <>
            <fieldset className="space-y-1">
              <legend className="mb-1 text-sm font-medium">Accounts to watch</legend>
              {accounts.length === 0 ? (
                <p className="text-sm text-muted">No accounts yet.</p>
              ) : (
                accounts.map((a) => {
                  const ids = s.accountIds as string[];
                  return (
                    <Checkbox
                      key={a.id}
                      isSelected={ids.includes(a.id)}
                      onChange={(on) =>
                        set({
                          accountIds: on ? [...ids, a.id] : ids.filter((x) => x !== a.id),
                        })
                      }
                    >
                      {a.name}
                    </Checkbox>
                  );
                })
              )}
            </fieldset>
            <AmountInput
              label="Under"
              currency={currency}
              value={s.underMinor as number}
              onChange={(v) => v !== null && set({ underMinor: Math.abs(v) })}
              description="Now, or in the next 2 weeks with the bills and paychecks you’ve confirmed."
            />
          </>
        ) : null}
        {rule.kind === 'budget_nearly_spent'
          ? numberSelect('When a category reaches', 'percent', PERCENT_CHOICES, (n) => `${n}%`)
          : null}
        {rule.kind === 'review' ? numberSelect('Once a day, at', 'hour', HOURS, formatHour) : null}
        {rule.kind === 'weekly_recap' ? (
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Day"
              value={s.day as string}
              onChange={(v) => v && set({ day: String(v) })}
            >
              {WEEKDAYS.map((d) => (
                <SelectItem key={d} id={d}>
                  {d[0]!.toUpperCase() + d.slice(1)}
                </SelectItem>
              ))}
            </Select>
            {numberSelect('Time', 'hour', HOURS, formatHour)}
          </div>
        ) : null}
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">Send it to</legend>
          {columns.map((c) => (
            <Checkbox
              key={c}
              isSelected={channels.includes(c) && (c !== 'email' || emailAvailable)}
              isDisabled={c === 'email' && !emailAvailable}
              onChange={(on) =>
                setChannels((old) => (on ? [...old, c] : old.filter((x) => x !== c)))
              }
            >
              {channelLabel(c)}
              {c === 'email' && !emailAvailable ? (
                <span className="text-muted"> · {EMAIL_UNAVAILABLE}</span>
              ) : null}
            </Checkbox>
          ))}
        </fieldset>
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" isPending={save.isPending}>
            Save
          </Button>
        </DialogActions>
      </Form>
    </Dialog>
  );
}
