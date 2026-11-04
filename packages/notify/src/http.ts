// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from 'node:crypto';
import type { WebhookPayload } from '@fiscus/shared';
import { ChannelError, type NotificationChannel, type OutgoingMessage } from './channel.js';

// ntfy, Gotify and webhooks (D16, #126): each member's own server address and topic or token,
// stored encrypted. The worker posts to them. Redirects aren't followed, and only a status code
// comes back from the other end, never its body.

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpChannelOptions {
  fetch?: Fetch;
  timeoutMs?: number;
}

const USER_AGENT = 'Fiscus';

/** Retried: the server may be back later. Anything else in 4xx needs someone to change something. */
const RETRIED = new Set([408, 425, 429]);

async function post(
  options: HttpChannelOptions,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<void> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT, ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    const name = (error as { name?: string }).name;
    throw new ChannelError(
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    );
  }
  // The body isn't read: nothing from the other end is kept or shown.
  await response.body?.cancel().catch(() => undefined);
  if (response.ok) return;
  const status = response.status;
  if (status >= 300 && status < 400) throw new ChannelError('redirect', true);
  if (status >= 400 && status < 500 && !RETRIED.has(status)) {
    throw new ChannelError(`http_${status}`, true);
  }
  throw new ChannelError(status >= 100 && status < 600 ? `http_${status}` : 'network');
}

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, '');

export interface NtfyConfig {
  server: string;
  topic: string;
  token?: string | undefined;
}

/**
 * ntfy (ntfy.sh, or your own server): a JSON publish to the server, so titles keep any character.
 * Its Open action is the link (`click`).
 */
export class NtfyChannel implements NotificationChannel<NtfyConfig> {
  readonly kind = 'ntfy' as const;

  constructor(private readonly options: HttpChannelOptions = {}) {}

  async send(message: OutgoingMessage, config: NtfyConfig): Promise<void> {
    if (!config.topic) throw new ChannelError('not_configured', true);
    return post(
      this.options,
      withoutTrailingSlash(config.server),
      {
        'content-type': 'application/json',
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      JSON.stringify({
        topic: config.topic,
        title: message.title,
        message: message.body,
        ...(message.url ? { click: message.url } : {}),
        tags: ['moneybag'],
      }),
    );
  }
}

export interface GotifyConfig {
  server: string;
  token: string;
}

/** Gotify: a message to the application the token belongs to. */
export class GotifyChannel implements NotificationChannel<GotifyConfig> {
  readonly kind = 'gotify' as const;

  constructor(private readonly options: HttpChannelOptions = {}) {}

  async send(message: OutgoingMessage, config: GotifyConfig): Promise<void> {
    if (!config.token) throw new ChannelError('not_configured', true);
    return post(
      this.options,
      `${withoutTrailingSlash(config.server)}/message`,
      { 'content-type': 'application/json', 'x-gotify-key': config.token },
      JSON.stringify({
        title: message.title,
        message: message.body,
        priority: 5,
        ...(message.url
          ? { extras: { 'client::notification': { click: { url: message.url } } } }
          : {}),
      }),
    );
  }
}

export interface WebhookConfig {
  url: string;
  secret?: string | undefined;
}

/** The JSON a webhook receives (docs/design/notifications.md). */
export function webhookPayload(message: OutgoingMessage): WebhookPayload {
  return {
    type: 'notification',
    id: message.id,
    kind: message.kind,
    detail: message.detail,
    title: message.title,
    body: message.body,
    url: message.url,
    createdAt: message.createdAt.toISOString(),
  };
}

/** `sha256=` and the HMAC-SHA256 of the timestamp, a dot, and the body, in hex. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * A webhook: the notification as JSON, for your own server or home automation. With a secret,
 * each request is signed (X-Fiscus-Signature over X-Fiscus-Timestamp and the body), so the other
 * end can tell it came from Fiscus.
 */
export class WebhookChannel implements NotificationChannel<WebhookConfig> {
  readonly kind = 'webhook' as const;

  constructor(private readonly options: HttpChannelOptions & { now?: () => Date } = {}) {}

  async send(message: OutgoingMessage, config: WebhookConfig): Promise<void> {
    if (!config.url) throw new ChannelError('not_configured', true);
    const body = JSON.stringify(webhookPayload(message));
    const timestamp = String(Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000));
    return post(
      this.options,
      config.url,
      {
        'content-type': 'application/json',
        'x-fiscus-event': 'notification',
        'x-fiscus-delivery': message.id,
        ...(config.secret
          ? {
              'x-fiscus-timestamp': timestamp,
              'x-fiscus-signature': webhookSignature(config.secret, timestamp, body),
            }
          : {}),
      },
      body,
    );
  }
}
