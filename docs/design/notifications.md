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
  there read-only (§6). Server → Email has a test. With neither, Settings says "Your server can't
  send email yet; ask whoever runs it." and email can't be ticked.
- **The rules** (#127, §4): a bill is due, a bill or paycheck is late, a card statement is due, a
  big transaction, low balance, a budget category nearly spent, transactions to review, and a bank
  connection that needs you; and the weekly recap (#128, §4.3).

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

## 4. The rules

The worker decides what to send (`apps/worker/src/notify/rules/`). Each rule runs for one member
in **their own database context** (`app.member_id`, `app.user_id`, no system context), so
row-level security limits what it can read, and so mention, to what they can see (D15, SYS-02):
Sam's private card's purchases never reach Alex. It writes their notification there too.

| Rule | Who | When | Once per (dedupe key) |
|---|---|---|---|
| A bill is due | whoever looks after it (`seriesLookedAfterBy`, D13) | an unpaid date of a bill or subscription within their days before; a bill paid before its reminder isn't reminded | `bill_due:<series>:<date>` |
| A bill or paycheck is late | a bill: whoever looks after it; a paycheck: whoever it's for (its latest payment's attribution, else the account's owners) | their days after a date with nothing paying it, up to 30 days back | `late:<series>:<date>` |
| A card statement is due | the card's owners (`cardStatementsDue`) | due within their days before, not paid in full | `statement_due:<card>:<due>` |
| A big transaction | everyone who sees the account's transactions | money out over their amount, in the household's currency, written since the last look; not pending, transfers or settle-ups, nor more than a week old | `big_transaction:<transaction>` |
| Low balance | whoever picked the account (and still sees it) | today's balance under their amount, or the lowest it gets in the next 2 weeks with the account's confirmed series due before then (D19) | `low_balance:<account>:<week>` |
| A budget category is nearly spent | members of the household's budget, and the owner of their own | a category's spending reaches their percentage of what it has this month (limit plus rollover); Flex: its fixed categories, and flexible spending as one | `budget_nearly_spent:<budget>:<category>:<month>` |
| Transactions to review | owners and members (not viewers) | once a day from their hour, if any wait in accounts they can review (and possible duplicates) | `review:<date>` |
| A bank connection needs you | whoever linked it | when a sync leaves it needing a sign-in, or 3 days into failures (§1) | `connection_needs_you:<connection>:…` |
| Weekly recap | each member | their day, from their hour (§4.3); a quiet week too | `weekly_recap:<week it covers>` |

"A new subscription, or a price went up" isn't sent yet: detection (#119) doesn't record when a
series first appeared or its amount moved and stayed (D14). It needs that first (#123, #129).

### 4.1 When they run (D20)

Each household runs on its own time zone (`fiscus_notification_households()`). The worker looks
every minute; each household is looked at once per local hour. The daily rules (bills, late,
statements, low balance, budgets) run once a day from 8 in the morning there; transactions to
review from each member's hour; the recap at theirs. Every minute it also asks which households
have new transactions (`fiscus_households_with_new_transactions()`, on the new
`transactions_created` index) and looks for big ones there, so one added by hand or by a sync is
told within a minute or so. After a restart it repeats what it may have done; the keys make
that send nothing twice.

### 4.2 Wording

Full detail names the thing and the amount ("Lakeside Power is due tomorrow", "About $142, from
Joint checking."); summary says only what kind of thing ("A bill is due soon.").

### 4.3 The weekly recap

At each member's day and hour there, the worker builds their recap of the last whole week (as the
household counts weeks) with `buildWeeklyRecap()`, in their own context: it refuses system
context, so it holds only what they can see (D21, SYS-02). One notification a week,
`weekly_recap:<the week's first day>`:
- in Fiscus and on push channels, a short entry ("Your week, Nov 2–8": what was spent, what's
  waiting for review) linking to the dashboard, where the recap card is;
- by email, the whole recap from `renderWeeklyRecapEmail()`, rendered at each detail level and
  stored with the notification (`notifications.email`), so each channel sends the one its detail
  level asks for.

A quiet week still sends, so it's clear nothing broke.

## 5. What a webhook receives

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

## 6. Running it

| Variable | Service | |
|---|---|---|
| `SMTP_URL` | api, worker | `smtp://user:password@host:587` (STARTTLS) or `smtps://…:465`. A secret |
| `MAIL_FROM` | api, worker | `Fiscus <fiscus@example.com>` |
| `PUBLIC_URL` | api, worker | For links in emails and pushes |

Set both mail settings or neither: one without the other stops the api and the worker at
startup, naming what's missing. The worker logs only whether email is on, and for each delivery
its id, channel and a code.

**One mail server for everything Fiscus sends.** The server's mail settings aren't tied to
notifications: the api reads them through `InstanceSettingsService.effectiveMail()`, the worker
through `MailSource`, and `smtpTransport(config)` sends any message to any address. Invites,
password resets and anything else that emails later use the same settings, so an admin sets up
mail once.

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

## 7. Not yet

- "A new subscription, or a price went up" (needs D14's detection first).
- Quiet hours for push (an open question in the walkthrough).
- Old notifications aren't cleaned up yet; the bell shows the latest 50.
