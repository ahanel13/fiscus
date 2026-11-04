// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DetailLevel,
  type ExternalChannelKind,
  MINIMAL_BODY,
  MINIMAL_TITLE,
  type NotificationRowKind,
} from '@fiscus/shared';

// What every way of sending a notification has in common (#125): a channel takes a message,
// written for its recipient at the detail they chose (D17), and the recipient's settings for that
// channel, and sends it or throws a ChannelError with a code. The worker does the sending, never
// the request path; it records the outcome, and retries what can be retried.

/** A notification as the worker reads it from the outbox. */
export interface StoredNotification {
  id: string;
  kind: NotificationRowKind;
  title: string;
  body: string;
  summary: string;
  /** An app path, `/h/…/accounts`. */
  link: string | null;
  /** Its own email at each detail level (the weekly recap's), in place of the usual one. */
  email?: Partial<Record<DetailLevel, PreparedEmail>> | null;
  createdAt: Date;
}

/** An email already written: subject, plain text and HTML. */
export interface PreparedEmail {
  subject: string;
  text: string;
  html: string;
}

/** What a channel sends: the notification at one detail level, with absolute links. */
export interface OutgoingMessage {
  id: string;
  kind: NotificationRowKind;
  detail: DetailLevel;
  title: string;
  body: string;
  /** Where it's about, absolute; null at minimal detail, or without the server's address. */
  url: string | null;
  /** The recipient's notification settings, absolute (for email's footer). */
  settingsUrl: string | null;
  /** Its own email at this detail level, when it has one. */
  email: PreparedEmail | null;
  createdAt: Date;
}

/**
 * The notification at a detail level (D17): full as written; summary as its summary, which has
 * no amounts, names or places; minimal says only that there's something new. Links are made
 * absolute with the server's public address; minimal carries none, since a path can name a page.
 */
export function renderMessage(
  n: StoredNotification,
  detail: DetailLevel,
  publicUrl: string | null,
  settingsPath: string | null,
): OutgoingMessage {
  const absolute = (path: string | null) =>
    path && publicUrl ? new URL(path, publicUrl).toString() : null;
  const text =
    detail === 'full'
      ? { title: n.title, body: n.body }
      : detail === 'summary'
        ? { title: MINIMAL_TITLE, body: n.summary }
        : { title: MINIMAL_TITLE, body: MINIMAL_BODY };
  return {
    id: n.id,
    kind: n.kind,
    detail,
    ...text,
    url: detail === 'minimal' ? absolute(publicUrl ? '/' : null) : absolute(n.link),
    settingsUrl: absolute(settingsPath),
    email: n.email?.[detail] ?? null,
    createdAt: n.createdAt,
  };
}

/**
 * A send that failed. `code` is stored and logged, so it's never a message from the other end
 * (which can echo a secret): `http_401`, `smtp_550`, `timeout`, `network`. `permanent` failures
 * aren't retried: trying again won't help until someone changes something.
 */
export class ChannelError extends Error {
  constructor(
    readonly code: string,
    readonly permanent = false,
  ) {
    super(code);
    this.name = 'ChannelError';
  }
}

/** One way of sending a notification, with its recipient's settings for it. */
export interface NotificationChannel<Config> {
  readonly kind: ExternalChannelKind;
  send(message: OutgoingMessage, config: Config): Promise<void>;
}
