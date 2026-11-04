// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OutgoingMessage } from './channel.js';

// Email templates (#125): plain text, and simple HTML that reads the same with images and styles
// off. Short, like the app: what happened, where to look, and why you're getting it.

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const FOOTER = 'You get this because of your notification settings in Fiscus.';
const TEST_FOOTER = 'You get this because you asked Fiscus to send a test.';

export function renderEmail(message: OutgoingMessage): RenderedEmail {
  const footer = message.kind === 'test' ? TEST_FOOTER : FOOTER;
  const text = [
    message.title,
    '',
    message.body,
    ...(message.url ? ['', `Open Fiscus: ${message.url}`] : []),
    '',
    '—',
    footer,
    ...(message.settingsUrl && message.kind !== 'test'
      ? [`Change them: ${message.settingsUrl}`]
      : []),
  ].join('\n');

  const button = message.url
    ? `<p style="margin:24px 0"><a href="${escape(message.url)}" style="background:#0e6b57;color:#ffffff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Open Fiscus</a></p>`
    : '';
  const settings =
    message.settingsUrl && message.kind !== 'test'
      ? ` <a href="${escape(message.settingsUrl)}" style="color:#6b7280">Change them</a>.`
      : '';
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(message.title)}</title>
  </head>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
      <p style="margin:0 0 16px;font-size:13px;color:#6b7280">Fiscus</p>
      <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${escape(message.title)}</h1>
      <p style="margin:0;font-size:15px;line-height:1.5">${escape(message.body)}</p>
      ${button}
      <p style="margin:24px 0 0;font-size:12px;color:#6b7280">${escape(footer)}${settings}</p>
    </div>
  </body>
</html>
`;
  return { subject: message.title, text, html };
}
