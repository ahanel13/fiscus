// SPDX-License-Identifier: AGPL-3.0-or-later
// Sending notifications (#125, #126): the channels, and email's templates. The worker sends;
// the api only uses email for the admin's test of the server's mail settings.
export {
  ChannelError,
  type NotificationChannel,
  type OutgoingMessage,
  type PreparedEmail,
  renderMessage,
  type StoredNotification,
} from './channel.js';
export {
  EmailChannel,
  type EmailConfig,
  type MailConfig,
  mailConfigOrExit,
  type MailEnv,
  mailEnvVars,
  type MailTransport,
  smtpFailure,
  smtpTransport,
} from './email.js';
export {
  type Fetch,
  GotifyChannel,
  type GotifyConfig,
  type HttpChannelOptions,
  NtfyChannel,
  type NtfyConfig,
  WebhookChannel,
  type WebhookConfig,
  webhookPayload,
  webhookSignature,
} from './http.js';
export { renderEmail, type RenderedEmail } from './templates.js';
