# Notifications

How Fiscus tells people things (#125, #126, #130): the channels, how a notification is
delivered, and what a webhook receives. What each person sees, and the rules and their defaults,
are in the [bills walkthrough](walkthroughs/bills.md) §7 (D15–D20). The tables are in the
[data model](data-model.md) §3.8.

## 1. What's built

- **Settings → Notifications**, in household settings: yours only, whatever your role (D15,
  HH-10). *Where to send them*: In Fiscus (always on), email, ntfy, Gotify and a webhook, each
  with its detail level and a test. *What to send*: a row per kind of notification (D18), with
  when it's sent and a tick for each channel. On a phone, each row opens its own settings.
- **The bell**, at the top of every page, with the unread count: recent notifications, newest
  first. Opening one marks it read and goes to what it's about; "Mark all read" clears the count.
- **Email**, set up once for the server: by an instance admin on Server → Email (mail server,
  port, security, username, password, From), or by `SMTP_URL` and `MAIL_FROM`, which win and show
  there read-only (§5). Server → Email has a test. With neither, Settings says "Your server can't
  send email yet; ask whoever runs it." and email can't be ticked.
- **One rule so far:** "A bank connection needs you", for whoever linked it: at once when it needs
  them to sign in again, and after 3 days of failures otherwise, as Accounts shows it (bank sync
  walkthrough D10). The others (#127) and the weekly recap (#128) use the same pipeline.

## 2. Channels

| Channel | Set up by | Settings | Secret (encrypted) |
|---|---|---|---|
| In Fiscus | always on | — | — |
| Email | the server's admin | detail | — (the member's sign-in address) |
| ntfy | each person | server (ntfy.sh by default), detail | topic, access token |
| Gotify | each person | server, detail | application token |
| Webhook | each person | detail | address, signing secret |

Secrets are write-only: encrypted with the household key, bound to their row, and shown back only
as a hint ("topic rivera-alex-…", a webhook's host). A change that leaves a secret out keeps the
one saved. An ntfy topic is a secret because anyone who knows a topic on a public server can read
it.

**Detail levels** (D17), per channel: *full* sends the notification as written ("Sign in to
Harbor Credit Union again"); *summary* sends a version without amounts, names or places ("A bank
connection needs you to sign in again"); *minimal* sends only "You have new activity in Fiscus".
In Fiscus is always full.

The channels are in `@fiscus/notify`: a `NotificationChannel` takes a message, already rendered
at the channel's detail level, and the member's settings for it, and sends it or throws a
`ChannelError` with a code (`http_401`, `smtp_550`, `timeout`, `network`), never the other end's
words, which can quote a secret.

## 3. Delivery

Sending happens in the worker, never in a request.

1. **Writing.** Whatever has something to say (the api, or a worker job) writes a row into
   `notifications` with `enqueueNotification` (`@fiscus/db`): the recipient, its kind, its text
   at full and summary detail, a link, and a **dedupe key**. The key is unique per recipient, so
   writing the same occurrence and rule twice, even after a restart, does nothing (D20). The
   writer makes sure it only mentions what the recipient can see (SYS-02).
2. **Routing.** Each pass, the worker takes notifications not yet routed
   (`fiscus_unrouted_notifications`), reads the recipient's preference for that kind (or D18's
   defaults) and their channels, and writes one `notification_deliveries` row per channel that's
   ticked and available: email only when the server can send it, push channels only once set
   up. In Fiscus sets `in_app`, which puts it in the bell. A recipient who has left gets nothing.
3. **Sending.** The worker claims due deliveries (`fiscus_claim_notification_deliveries`,
   leased for 2 minutes, `SKIP LOCKED`, so two workers never send the same one), sends each, and
   records how it went. A failure is retried after 1 and 5 minutes, half an hour, 2 and 6 hours,
   then given up; one the other end refused (a 4xx other than 408, 425 or 429, a redirect, a 5xx
   from the mail server, a channel that isn't set up) is given up at once.

A sent delivery is never sent again. The one gap is a worker stopped between sending and
recording: that delivery is sent again once its lease runs out (at least once, not exactly once).

**Tests.** "Send a test" writes a notification of kind `test` for one channel. It's routed to that
channel only, set up or not, so a failure says what's wrong, and it isn't shown in the bell.
Settings asks how it went every second for up to 30 seconds. The admin's test email on Server →
Email is the exception: it's sent from the api, so the admin sees at once whether the mail
settings work.

**Adding a rule** (#127, #128): pick a kind from `NOTIFICATION_KINDS` (its settings and defaults
are in `@fiscus/shared`), read each member's settings with `ruleSettings`, decide who should hear
about what in the household's timezone, and call `enqueueNotification` with a dedupe key naming
the occurrence: `bill_due:<series>:<date>`. Routing, channels, retries and the bell need nothing
more.

## 4. What a webhook receives

A `POST` with `Content-Type: application/json`:

```json
{
  "type": "notification",
  "id": "0190f3c2-7c1e-7d4a-9b8e-2f6a1c3d5e7f",
  "kind": "connection_needs_you",
  "detail": "full",
  "title": "Sign in to Harbor Credit Union again",
  "body": "Fiscus can't sync Harbor Credit Union until you sign in to it again. Your other banks keep syncing.",
  "url": "https://fiscus.example.com/h/…/accounts",
  "createdAt": "2026-11-12T15:00:00.000Z"
}
```

- `kind` is one of the rules (`bill_due`, `late`, `statement_due`, `big_transaction`,
  `low_balance`, `budget_nearly_spent`, `subscription_change`, `connection_needs_you`, `review`,
  `weekly_recap`), or `test`.
- `title` and `body` are at the channel's detail level: `detail` says which. At `minimal`, `url`
  is the server's address only. `url` is null when the server's `PUBLIC_URL` isn't set for the
  worker.
- `id` is the notification's: a retry of the same one has the same id, so it can be ignored.

Headers: `X-Fiscus-Event: notification`, `X-Fiscus-Delivery: <id>`, and with a signing secret,
`X-Fiscus-Timestamp` (Unix seconds) and `X-Fiscus-Signature: sha256=<hex>`, the HMAC-SHA256 of
`<timestamp>.<body>` with the secret. To check one:

```js
const expected =
  'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
// Compare with timingSafeEqual, and refuse a timestamp more than a few minutes old.
```

Any 2xx is success. Redirects aren't followed. A 408, 425, 429 or 5xx is retried; any other
answer is given up. The response body is never read.

ntfy gets a JSON publish to its server (`topic`, `title`, `message`, `click`), with the access
token as a bearer token. Gotify gets `POST /message` with the token in `X-Gotify-Key`, and the
link as its click action.

## 5. Running it

| Variable | Service | |
|---|---|---|
| `SMTP_URL` | api, worker | `smtp://user:password@host:587` (STARTTLS) or `smtps://…:465`. A secret |
| `MAIL_FROM` | api, worker | `Fiscus <fiscus@example.com>` |
| `PUBLIC_URL` | api, worker | For links in emails and pushes |

Set both mail settings or neither: one without the other stops the api and the worker at
startup, naming what's missing. The worker logs only whether email is on, and for each delivery
its id, channel and a code.

**Or set the mail server on Server → Email.** An instance admin enters the host, port, security
(TLS, STARTTLS or none), username, password and From address, and can send a test, change or
remove them (with a recent sign-in). They're kept in instance settings under `mail.smtp`, outside
the registry of plain settings: the password encrypted with the instance key and bound to that
setting, never returned (the page says only that one is saved; leave it blank to keep it), and
never in the activity, which says which fields changed. `SMTP_URL` and `MAIL_FROM` win when set:
the page then shows their host, port and From read-only, and can't change them. The api and the
worker read the settings in use every 30 and 60 seconds, so a change takes effect without a
restart. After a master key rotation removes the key the password was saved under, the page asks
for it again.

**Addresses on your own network** (a Gotify server or Home Assistant on the LAN) are allowed,
since that's what webhooks are for. This means any member can make the worker post to an address
it can reach (threat model T31). An instance that must not allow that needs egress rules on the
worker for now.

## 6. Not yet

- The rules that decide when to notify (#127) and the weekly recap (#128).
- Quiet hours for push (an open question in the walkthrough).
- Old notifications aren't cleaned up yet; the bell shows the latest 50.
