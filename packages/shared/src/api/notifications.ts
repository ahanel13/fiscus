// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { formatMoney, minorUnitExponent } from '../money.js';
import { minorUnitsSchema } from './accounts.js';

// Notifications (bills walkthrough §7, D15–D20; #125, #126, #130). Each member chooses their own
// channels and rules (D15, HH-10). What's sent is written for its recipient, about what they can
// see (SYS-02). The rules that decide when to send (#127) and the weekly recap (#128) plug into
// the kinds and settings here.

/** Where a notification can go. In Fiscus (the bell) is always on (D16). */
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'ntfy', 'gotify', 'webhook'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannelKind = z.infer<typeof notificationChannelSchema>;

/** The channels a member sets up themselves, outside Fiscus. */
export const EXTERNAL_CHANNELS = ['email', 'ntfy', 'gotify', 'webhook'] as const;
export const externalChannelSchema = z.enum(EXTERNAL_CHANNELS);
export type ExternalChannelKind = z.infer<typeof externalChannelSchema>;

/** Push channels: off until set up, then on for the rules worth an interruption (D18). */
export const PUSH_CHANNELS = ['ntfy', 'gotify', 'webhook'] as const;
export type PushChannelKind = (typeof PUSH_CHANNELS)[number];

export const CHANNEL_LABELS: Record<NotificationChannelKind, string> = {
  in_app: 'In Fiscus',
  email: 'Email',
  ntfy: 'ntfy',
  gotify: 'Gotify',
  webhook: 'Webhook',
};

/**
 * How much a channel carries (D17, ADR 0014 §5): full ("$412.18 at Costco on Joint card"), a
 * summary without amounts or names, or only that there's something new. Email and push services
 * can read what they carry.
 */
export const DETAIL_LEVELS = ['full', 'summary', 'minimal'] as const;
export const detailLevelSchema = z.enum(DETAIL_LEVELS);
export type DetailLevel = z.infer<typeof detailLevelSchema>;

/** What a minimal notification says, whatever it's about. */
export const MINIMAL_TITLE = 'Fiscus';
export const MINIMAL_BODY = 'You have new activity in Fiscus.';

const hour = z.number().int().min(0).max(23);
export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * Each kind's settings: when it's sent, and about what (D18). `strictObject`, so a setting a kind
 * doesn't have is refused rather than stored.
 */
export const notificationSettingsSchemas = {
  bill_due: z.strictObject({ daysBefore: z.number().int().min(0).max(14) }),
  late: z.strictObject({ daysAfter: z.number().int().min(1).max(14) }),
  statement_due: z.strictObject({ daysBefore: z.number().int().min(0).max(14) }),
  big_transaction: z.strictObject({ overMinor: minorUnitsSchema.min(1) }),
  low_balance: z.strictObject({
    /** The accounts watched; none, and nothing is sent (off until you pick one). */
    accountIds: z.array(z.uuid()).max(20),
    underMinor: minorUnitsSchema.min(0),
  }),
  budget_nearly_spent: z.strictObject({ percent: z.number().int().min(50).max(100) }),
  subscription_change: z.strictObject({}),
  connection_needs_you: z.strictObject({}),
  review: z.strictObject({ hour }),
  weekly_recap: z.strictObject({ day: z.enum(WEEKDAYS), hour }),
} as const;

export type NotificationKind = keyof typeof notificationSettingsSchemas;
export const NOTIFICATION_KINDS = Object.keys(notificationSettingsSchemas) as NotificationKind[];
export const notificationKindSchema = z.enum(
  NOTIFICATION_KINDS as [NotificationKind, ...NotificationKind[]],
);
export type NotificationSettings<K extends NotificationKind = NotificationKind> = z.infer<
  (typeof notificationSettingsSchemas)[K]
>;

interface KindDefinition<K extends NotificationKind> {
  label: string;
  /** Who or what it's about, after its timing: "bills you look after". */
  scope: string | null;
  defaults: NotificationSettings<K>;
  /** In Fiscus and email, as D18 sets them. Email applies once the server can send it. */
  channels: readonly ('in_app' | 'email')[];
  /** On for push channels once one is set up (the prototype's Phone column). */
  push: boolean;
}

/** The rules and their defaults (D18), in the order Settings shows them. */
export const NOTIFICATION_KIND_DEFINITIONS: { [K in NotificationKind]: KindDefinition<K> } = {
  bill_due: {
    label: 'A bill is due',
    scope: 'bills you look after',
    defaults: { daysBefore: 3 },
    channels: ['in_app', 'email'],
    push: true,
  },
  late: {
    label: 'A bill or paycheck is late',
    scope: null,
    defaults: { daysAfter: 2 },
    channels: ['in_app', 'email'],
    push: true,
  },
  statement_due: {
    label: 'A card statement is due',
    scope: 'cards you own',
    defaults: { daysBefore: 5 },
    channels: ['in_app', 'email'],
    push: false,
  },
  big_transaction: {
    label: 'A big transaction',
    scope: 'accounts you see',
    defaults: { overMinor: 50_000 },
    channels: ['in_app'],
    push: true,
  },
  low_balance: {
    label: 'Low balance',
    scope: null,
    defaults: { accountIds: [], underMinor: 100_000 },
    channels: ['in_app', 'email'],
    push: true,
  },
  budget_nearly_spent: {
    label: 'A budget category is nearly spent',
    scope: 'your budgets',
    defaults: { percent: 90 },
    channels: ['in_app'],
    push: false,
  },
  subscription_change: {
    label: 'A new subscription, or a price went up',
    scope: 'found in your transactions',
    defaults: {},
    channels: ['in_app'],
    push: false,
  },
  connection_needs_you: {
    label: 'A bank connection needs you',
    scope: 'connections you linked',
    defaults: {},
    channels: ['in_app', 'email'],
    push: true,
  },
  review: {
    label: 'Transactions to review',
    scope: 'if there are any',
    defaults: { hour: 9 },
    channels: ['in_app'],
    push: false,
  },
  weekly_recap: {
    label: 'Weekly recap',
    scope: null,
    defaults: { day: 'monday', hour: 8 },
    channels: ['in_app', 'email'],
    push: false,
  },
};

/** The kinds a notification row can have: the rules, and a channel's test. */
export const NOTIFICATION_ROW_KINDS = [...NOTIFICATION_KINDS, 'test'] as const;
export type NotificationRowKind = NotificationKind | 'test';

/**
 * The channels a rule goes to: what the member ticked, or D18's defaults with any push channel
 * they've set up. In Fiscus, email and push are filtered later by what's available.
 */
export function ruleChannels(
  kind: NotificationKind,
  stored: readonly NotificationChannelKind[] | null | undefined,
  configured: readonly ExternalChannelKind[],
): NotificationChannelKind[] {
  if (stored) return NOTIFICATION_CHANNELS.filter((c) => stored.includes(c));
  const def = NOTIFICATION_KIND_DEFINITIONS[kind];
  return NOTIFICATION_CHANNELS.filter(
    (c) =>
      (def.channels as readonly string[]).includes(c) ||
      (def.push &&
        (PUSH_CHANNELS as readonly string[]).includes(c) &&
        (configured as readonly string[]).includes(c)),
  );
}

/** A rule's settings: the stored ones over its defaults, ignoring any that no longer parse. */
export function ruleSettings<K extends NotificationKind>(
  kind: K,
  stored: unknown,
): NotificationSettings<K> {
  const defaults = NOTIFICATION_KIND_DEFINITIONS[kind].defaults as NotificationSettings<K>;
  const merged = { ...defaults, ...(stored && typeof stored === 'object' ? stored : {}) };
  const parsed = notificationSettingsSchemas[kind].safeParse(merged);
  return parsed.success ? (parsed.data as NotificationSettings<K>) : defaults;
}

const formatHour = (h: number) =>
  h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`;
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * A rule's timing, in words, for Settings: "3 days before", "Mondays at 8 am". Amounts are in
 * the household's currency, whole when they're whole.
 */
export function describeRuleTiming(
  kind: NotificationKind,
  settings: NotificationSettings,
  {
    currency = 'USD',
    accountNames = (ids) => `${ids.length} account${ids.length === 1 ? '' : 's'}`,
  }: { currency?: string; accountNames?: (ids: readonly string[]) => string } = {},
): string {
  const money = (minor: number) =>
    formatMoney(minor, currency, { whole: minor % 10 ** minorUnitExponent(currency) === 0 });
  const s = settings as Record<string, unknown>;
  switch (kind) {
    case 'bill_due':
    case 'statement_due':
      return s.daysBefore === 0 ? 'On the day' : `${days(s.daysBefore as number)} before`;
    case 'late':
      return `${days(s.daysAfter as number)} after it was expected`;
    case 'big_transaction':
      return `Over ${money(s.overMinor as number)}`;
    case 'low_balance': {
      const ids = s.accountIds as string[];
      if (ids.length === 0) return 'Off until you pick an account';
      return `${accountNames(ids)} under ${money(s.underMinor as number)}, now or in the next 2 weeks`;
    }
    case 'budget_nearly_spent':
      return `At ${s.percent as number}%`;
    case 'subscription_change':
      return 'Found in your transactions';
    case 'connection_needs_you':
      return 'When one needs you to sign in, or stops working';
    case 'review':
      return `Once a day at ${formatHour(s.hour as number)}`;
    case 'weekly_recap': {
      const day = s.day as string;
      return `${day[0]!.toUpperCase()}${day.slice(1)}s at ${formatHour(s.hour as number)}`;
    }
  }
}

// Channel configuration. Secrets (an ntfy topic and token, a Gotify token, a webhook's address
// and signing secret) are write-only: stored encrypted with the household key, and shown back
// only as a hint.

const httpUrl = z
  .url({ protocol: /^https?$/, error: 'Enter an http:// or https:// address' })
  .max(500);
/** A server's address, without a password in it: the token goes in its own field. */
const serverUrl = httpUrl.refine((u) => {
  const url = new URL(u);
  return !url.username && !url.password && !url.search && !url.hash;
}, 'Enter the server’s address only, without a password, query or #');
const token = z.string().trim().min(1).max(500);

export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

export const setChannelSchemas = {
  email: z.strictObject({ detail: detailLevelSchema }),
  ntfy: z.strictObject({
    detail: detailLevelSchema,
    server: serverUrl,
    /** Anyone who knows a topic on a public server can read it: it's kept as a secret. */
    topic: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Letters, numbers, - and _ only')
      .optional(),
    /** An access token, for a server or topic that needs one. Empty clears it. */
    token: z.string().trim().max(500).optional(),
  }),
  gotify: z.strictObject({
    detail: detailLevelSchema,
    server: serverUrl,
    /** The application token. Left out on a change: the one saved stays. */
    token: token.optional(),
  }),
  webhook: z.strictObject({
    detail: detailLevelSchema,
    /** Left out on a change: the one saved stays. It may carry credentials, so it's a secret. */
    url: httpUrl.optional(),
    /** Signs each request (X-Fiscus-Signature). Empty clears it. */
    secret: z.string().trim().max(200).optional(),
  }),
} as const;
export type SetChannel<K extends ExternalChannelKind = ExternalChannelKind> = z.infer<
  (typeof setChannelSchemas)[K]
>;

/** A channel as Settings shows it: never its secrets. */
export interface NotificationChannelView {
  kind: ExternalChannelKind;
  /** Set up (email: the server can send it, and you have an address). */
  configured: boolean;
  detail: DetailLevel;
  /** ntfy and Gotify: the server's address. */
  server: string | null;
  /** What it sends to, shortened: an email address, "topic rivera-alex-…", a webhook's host. */
  hint: string | null;
  /** A webhook signs its requests. */
  signed: boolean;
}

export interface NotificationRuleView {
  kind: NotificationKind;
  channels: NotificationChannelKind[];
  settings: NotificationSettings;
  /** Never changed: D18's defaults apply. */
  isDefault: boolean;
}

export interface NotificationSettingsView {
  /** The server has mail settings (SMTP_URL and MAIL_FROM, D16). */
  emailAvailable: boolean;
  channels: NotificationChannelView[];
  rules: NotificationRuleView[];
}

export const setRuleSchema = z.strictObject({
  channels: z.array(notificationChannelSchema).max(NOTIFICATION_CHANNELS.length),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type SetRule = z.infer<typeof setRuleSchema>;

/** One notification in the bell (#130). */
export interface Notification {
  id: string;
  kind: NotificationRowKind;
  title: string;
  body: string;
  /** Where it's about, in the app: `/h/…/accounts`. */
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationList {
  notifications: Notification[];
  unread: number;
}

/** How a test send went: the worker sends it (D16), so it's pending at first. */
export interface ChannelTestStatus {
  status: 'pending' | 'sent' | 'failed';
  /** Why it failed, as a code: `http_401`, `smtp_550`, `timeout`. */
  code: string | null;
}

/** Server → Email (D16): whether the server can send it. The SMTP URL is never shown. */
export interface MailStatus {
  configured: boolean;
  from: string | null;
}

/** What a webhook receives (docs/design/notifications.md). */
export interface WebhookPayload {
  type: 'notification';
  id: string;
  kind: NotificationRowKind;
  detail: DetailLevel;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
}

/** A failure code for a channel, from the worker: never a message, which may hold a secret. */
export const CHANNEL_ERROR_MESSAGES: Record<string, string> = {
  timeout: 'The server didn’t answer in time.',
  network: 'Couldn’t reach the server.',
  redirect: 'The server answered with a redirect, which isn’t followed.',
  email_unavailable: 'This server can’t send email.',
  no_address: 'There’s no email address to send to.',
  not_configured: 'It isn’t set up.',
  secret_unreadable: 'Its saved settings couldn’t be read. Set it up again.',
};

/** A failure code in words, for Settings. */
export function describeChannelError(code: string | null): string {
  if (!code) return 'It didn’t go through.';
  const known = CHANNEL_ERROR_MESSAGES[code];
  if (known) return known;
  const http = code.match(/^http_(\d{3})$/);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403)
      return `The server refused it (${status}): check the token.`;
    if (status === 404) return 'The server said not found (404): check the address.';
    return `The server answered ${status}.`;
  }
  const smtp = code.match(/^smtp_(\d{3})$/);
  if (smtp) return `The mail server refused it (${smtp[1]}).`;
  return `It didn’t go through (${code}).`;
}
