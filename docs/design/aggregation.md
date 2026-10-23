# Bank aggregation: the provider interface (M2)

- Status: Accepted
- Issue: #78 (part 1: the interface, a fake provider, and a conformance suite); #81 (the runner); #80 (sync ingest); #79 (connecting through Plaid Link); #82 (the Plaid adapter)
- Builds on: [ADR 0004](../adr/0004-pluggable-providers.md), [ADR 0008](../adr/0008-plaid-credentials-and-webhooks.md), the [bank connections walkthrough](walkthroughs/bank-sync.md) (D1, D2, D4–D6, D8, D10, D14, D17)

Plaid and SimpleFIN sit behind one interface, designed against both from the start (D1), so
sync, ingest and the UI never branch on which provider a connection uses. They branch on what it
can do.

## 1. The interface

`AggregationProvider` and its types live in `@fiscus/domain` (`packages/domain/src/aggregation.ts`),
with no dependencies. Everything crossing it is in Fiscus's terms: minor units in **Fiscus's
sign** (negative = money out, data model §1; a card's balance owed is negative), dates as
`YYYY-MM-DD`. Adapters normalize; nothing past them sees Plaid's sign.

| Member | What it does |
|---|---|
| `id` | Stored on each connection (`plaid`, `simplefin`) |
| `capabilities` | `cursorSync`, `pendingLinks`, `updateModeReauth`, `webhooks`, `liabilities`, `minRefreshMs`, `maxHistoryDays` |
| `listAccounts(secret)` | The accounts behind a connection |
| `sync(secret, { cursor, since })` | One `SyncPage` |
| `refresh?(secret)` | "Refresh now" at the provider (D10) |
| `liabilities?(secret)` | Statement and loan details, when `capabilities.liabilities` |
| `remove(secret)` | Ends the connection at the provider (Plaid's `/item/remove`, D14) |

| | Plaid | SimpleFIN |
|---|---|---|
| `cursorSync`, `pendingLinks`, `updateModeReauth`, `webhooks`, `liabilities` | all true | all false |
| `minRefreshMs` | 15 minutes | 6 hours |
| `maxHistoryDays` | 730 | about 90 |

**Pages come in two modes.**
- `delta`: `added`, `modified` and `removed` are the changes since `cursor`, applied in order.
  `nextCursor` is stored once the page is applied; `hasMore` means another page follows now.
- `window`: "this is everything in `window`". `added` holds every transaction dated in
  `[from, to]` for the accounts in `window.providerAccountIds`; `modified` and `removed` are
  empty. Ingest drops that provider's rows in the window that weren't returned, since SimpleFIN
  never reports removals. An account missing from the list (the bank didn't return it this time)
  keeps its rows.

A posted transaction names the pending one it replaces in `pendingTransactionId` when the
provider can (`pendingLinks`), so edits carry over (D8). `historicalComplete` says the provider's
older history has all arrived.

**Errors** are a `ProviderError` with a `kind` (`login_required`, `consent_expired`,
`rate_limited`, `institution_down`, `invalid_credentials`, `mutation_during_pagination`,
`transient`), the provider's `providerCode`, `retryAfterMs` when the provider says, and
`providerRequestId` (Plaid's `request_id`, safe to log, for its support) when it has one. The
provider's own message is untrusted display text: it is kept out of `message` and out of the
error's JSON, so logging the error can't log it.

**Connecting is per provider**, outside the interface: Plaid Link's public token and a SimpleFIN
setup token share too little. Each provider has a `ProviderConnectFlow` whose `connect` returns
`{ providerItemId, secret, institution, accounts }`.

## 2. `@fiscus/aggregation`

- `ProviderRegistry`: the providers this server has enabled, looked up by a connection's
  `provider` with `forConnection({ provider, credentialSetId, providerEnv, providerClientId })`.
  An adapter that serves every connection alike registers as itself; one whose keys are per
  connection (Plaid, ADR 0008) registers a `ProviderSource`, which picks the adapter for each
  connection or throws `ProviderUnavailableError` with a reason (`not_configured`,
  `household_keys_unavailable`, `credentials_changed`). A household's own keys (#83) resolve
  through the same seam.
- Plaid (#82): `PlaidClient`, a small `fetch` client for the endpoints M2 uses, with zod-checked
  responses and Plaid's errors mapped to `ProviderError` kinds; `plaidEnvVars` and
  `instancePlaidConfig` for the server's keys (all three or none); `resolvePlaidCredentials`,
  which gives a connection its keys (null `credential_set_id` = the server's), and
  `credentialsChanged`, true when a connection's recorded `provider_env` or `provider_client_id`
  no longer matches (a rotated secret isn't a change). The base URL comes from `PLAID_ENV`; a
  test-only override is honored only in sandbox.
- The Plaid adapter (#82, `plaid/provider.ts`): `PlaidProvider`, for one set of keys, and
  `plaidProviderSource(instanceConfig)`, which the worker registers. Each connection gets the keys
  it was made with: the server's when `credential_set_id` is null; a household's own set is
  refused as `household_keys_unavailable` until #83; a recorded `provider_env` or
  `provider_client_id` that no longer matches is `credentials_changed`. One `PlaidProvider` per
  set of keys.
  - `sync` is one `/transactions/sync` page, never `/transactions/get` (Plaid's TXN-001), with
    `count: 500` (TXN-011), `include_original_description` (the bank's own text is the
    description, else Plaid's `name`; TXN-013) and `personal_finance_category_version: 'v2'`
    pinned (TXN-006). The sync loop (§5) buffers pages to `has_more: false` and restarts on
    `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` (TXN-002, TXN-007). `added` and `modified`
    keep `transaction_id`; a posted row's `pending_transaction_id` is its `pendingTransactionId`
    (TXN-004); a pending row has no posted date (Plaid's `date` is when it happened). Amounts are
    reversed, Plaid's positive being money out (TXN-005), into integer minor units by the
    currency's exponent; the currency is `iso_currency_code`, else `unofficial_currency_code`, and
    a row in neither, or in a code Fiscus can't hold, is skipped, as is a removal without its
    `account_id`. The merchant is `merchant_name`, never `name` (TXN-023). Categories and
    `payment_channel` have no place in `ProviderTransaction` yet and aren't read; the legacy
    `category` fields never are. Plaid has no original foreign amount here.
  - The page that ends a sync (`has_more: false`) carries the accounts and balances from
    `/accounts/get`, the authoritative list (TXN-012), at no extra charge. Balances follow the
    api's mapping (`plaid/mapping.ts`, shared): a card's or loan's current balance negated,
    available and limit as they are, `asOf` from `last_updated_datetime` or the time of the sync.
  - `HISTORICAL_UPDATE_COMPLETE` in `transactions_update_status` is `historicalComplete`
    (TXN-008). An empty first sync is normal; Plaid's empty cursor then keeps the one asked with.
  - `liabilities` reads `/accounts/get` and calls `/liabilities/get` only when the Item has a
    card or a loan (LIAB-008). Cards, student loans and mortgages are mapped (Plaid's other loan
    kinds have no place yet); the card's APR is the `purchase_apr` entry, chosen by `apr_type`,
    never by position (LIAB-003); every field is read on its own and left out when null
    (LIAB-002). `NO_LIABILITY_ACCOUNTS`, `PRODUCTS_NOT_SUPPORTED`, `ADDITIONAL_CONSENT_REQUIRED`
    (an Item linked before liabilities were consented) and `INVALID_PRODUCT` give no details
    rather than a failed sync; `PRODUCT_NOT_READY` fails it, to be retried with backoff.
  - `remove` is `/item/remove` (ITEM-005); `ITEM_NOT_FOUND` counts as removed already.
  - No `refresh`: `/transactions/refresh` is a separately billed add-on (TXN-010). Investment
    accounts are listed but nothing reads investments (TXN-022).
  - Errors branch on `error_type` and `error_code` only (ITEM-002): `ITEM_LOGIN_REQUIRED` and the
    other sign-in codes are `login_required`, `PENDING_EXPIRATION` and the consent codes
    `consent_expired`, `INSTITUTION_DOWN` and `INSTITUTION_NOT_RESPONDING` `institution_down`,
    `RATE_LIMIT_EXCEEDED` `rate_limited`, `ITEM_NOT_FOUND` `invalid_credentials` (the Item is
    gone), and `PRODUCT_NOT_READY` and anything unknown `transient`, all retried with the runner's
    capped, jittered backoff (ITEM-004, ITEM-013).
- **The SimpleFIN adapter** (`SimpleFinProvider`, `src/simplefin/`, #91), over `fetch`, protocol
  v2 (`version=2`: `errlist`, `connections`, accounts' `conn_id`):
  - **Tokens.** A setup token is base64 of a claim URL. `decodeSetupToken` checks it, and
    `claimSetupToken` POSTs to it once (a used one answers 403: "Create a new one at the Bridge")
    and returns the access URL, which carries Basic credentials. Both URLs must be https on a host
    in `SIMPLEFIN_BRIDGE_HOSTS` (by default `bridge.simplefin.org`, `beta-bridge.simplefin.org`),
    the access URL on the claim's host, before any request (threat model T28). Requests refuse
    redirects, time out after 15 s and read at most 10 MB; the credentials go in an
    `Authorization` header, never the URL, and never appear in an error or the client's printed
    form. `simpleFinItemId` is a hash of the token's username: stable, and says nothing.
  - **`sync`** is one `window` page: `GET /accounts?start-date=…&pending=1`, from `since` (90 days
    back by default) to today. Dates are the day a transaction happened in the household's time
    zone (`SyncRequest.timeZone`), except a time of exactly 00:00:00Z, which Bridges send for a
    bare date and which is that date in UTC. A pending transaction (`pending`, or `posted` of 0)
    has no posted date; one that posts under a new id replaces it through the window (ingest
    drops what's no longer there). Amounts are decimal strings turned into minor units by their
    digits, never through a float; SimpleFIN's sign is already Fiscus's.
  - **Accounts.** SimpleFIN gives a name, a currency and balances only, so the type, subtype and
    last 4 are guessed from the name (a negative balance with no other hint is a card). An account
    in a custom currency (a URL rather than an ISO code) is left out. The balance, available
    balance and `balance-date` are one snapshot; there's no credit limit.
  - **Errors.** 403 is `login_required` (`SIMPLEFIN_ACCESS_REVOKED`: a new token from the Bridge),
    402 `consent_expired` (`SIMPLEFIN_PAYMENT_REQUIRED`: the Bridge subscription), 429
    `rate_limited`, anything else `transient`. An `errlist` entry naming an account, or its
    connection, leaves that account out of the window (so what it had is kept) and lists it in
    `accountErrors` with the code, never the message. Errors with no accounts at all fail the sync.
  - **`remove`** calls nothing: the Bridge can't end a token's access from here, so its owner
    revokes it at the Bridge (D14) and Fiscus deletes the access URL.
- `@fiscus/aggregation/testing`, for tests only:
  - `FakeAggregationProvider`: scripted and deterministic. Accounts, balances, liabilities, a list
    of **updates** (each the pages one sync returns, made visible with `release()`), `delta` or
    `window` mode, an error on the Nth sync call, a `FakeClock`, and a record of calls.
  - `riveraScenario()`: synthetic data for the Riveras' Harbor Credit Union, as in the
    walkthrough: two pages of first-sync history, a pending coffee that posts, a dinner that gains
    its tip, a foreign purchase, a refund, and a card payment seen from both accounts.
  - `startStubServer(routes)`: a Node `http` server on an ephemeral local port that answers from
    route handlers and records requests, for adapters to talk to instead of Plaid or the Bridge (D17).
  - `startFakePlaid()`: Plaid's endpoints on a stub server, answering the Riveras' scenario in
    Plaid's format and sign, checking keys and tokens, with scripted failures. It sends
    `original_description` only when asked, cards, student loans and mortgages from
    `/liabilities/get`, and `NO_LIABILITY_ACCOUNTS` for an Item without a card or loan, as Plaid
    does.
  - `startFakeSimpleFin()`: the Bridge's claim and accounts endpoints on a stub server, answering
    the same scenario in SimpleFIN's format (decimal strings, bare dates at midnight UTC), checking
    Basic credentials, claiming a token once, with scripted statuses and `errlist` entries.

## 3. The conformance suite

`describeProviderConformance(name, create, { errorKinds, unsupportedFields?, unsupportedAccountFields? })` runs the cases
every adapter must pass. `create` gets the scenario and returns a harness: the provider (usually
the adapter pointed at a stub server answering the scenario in the provider's own format), its
secret, and `release()` for the next update. It checks:

- after each update, applying the pages gives exactly the bank's transactions (delta pages in
  order, windows replacing their range);
- amounts and balances are in Fiscus's sign;
- the same request returns the same page;
- `hasMore` implies a new `nextCursor`, delta pages always have one, and a sync with nothing new
  changes nothing;
- pages follow the mode: `delta` with `cursorSync`, otherwise `window`, every row inside its
  window;
- pending rows have no posted date, and posted ones link their pending row when `pendingLinks`;
- each kind in `errorKinds` arrives as a `ProviderError` of that kind, without the provider's
  message in what gets logged, and retrying the same request returns the page;
- liabilities match when the provider has them, and `remove` resolves.

The fake passes it in both modes, as the reference. The Plaid adapter (#82) passes it against
the fake Plaid server, with every error kind, Plaid's foreign amounts and accounts' `closed` left
out (Plaid reports neither). The SimpleFIN adapter (#91) passes it against the fake Bridge, with
the kinds the Bridge can report (`login_required`, `consent_expired`, `rate_limited`,
`transient`), and merchant names, foreign amounts, accounts' official names, last 4 and `closed`,
and credit limits left out (`unsupportedBalanceFields`).

## 4. The runner

The worker's scheduling loop (#81, `apps/worker/src/runner/`). Scheduling lives in Postgres, on
`connections`, so any number of workers can run.

- **Claiming.** Every few seconds (`SYNC_POLL_SECONDS`, default 5) a pass claims up to its free
  job slots through `fiscus_claim_due_connections(limit, lease)`: `ok` and `error` connections
  whose `next_sync_at` has come, and disconnected ones still owed to their provider; never `setup`
  or `login_required`. Claims are leased (15 minutes, longer than a job may take) with `SKIP
  LOCKED`, so two workers never run one connection at once. The claim returns ids only; the runner
  then reads each connection in its household's system context.
- **Jobs**, by kind, from a handler registry: `sync` for a polled connection, `remove` for a
  disconnected one with `disconnect_requested`. `sync` brings in transactions and balances (§5).
  `remove` calls `provider.remove(secret)`, then, in
  one transaction recorded as activity by the system, deletes the secret and clears
  `disconnect_requested`. If remove fails, or this server has no adapter for the provider, the
  secret stays and the job is retried. A connection whose provider has no adapter here fails as
  `provider_unavailable`, as does a Plaid connection on a server without Plaid keys; one made
  with a household's own Plaid keys fails as `household_keys_unavailable` (#83), and one made
  with another Plaid client id or environment as `credentials_changed` ("reconnect"), without
  calling Plaid. A job running past 10 minutes fails as `timeout`.
- **When it's next due.** After a sync: the interval, `sync.intervalHours` (an instance setting,
  read each pass, default 4 h; `SYNC_INTERVAL_HOURS` overrides it), plus up to 10% at random. After
  a failure: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h for the 1st, 2nd, … failure in a row, never more
  than the interval, also with up to 10% added. `consecutive_failures` counts them,
  `first_failed_at` is when the run began (for "not working" after 3 days), and `last_error_code`
  holds the provider's code or the worker's own; all three clear on success. A provider error
  meaning only its owner can fix it (`login_required`, `consent_expired`) sets `login_required`,
  which isn't polled.
- **Finishing** goes through `fiscus_finish_connection_job(id, outcome, …)`, a definer owned by
  `fiscus_steward` that works only for a session logged in as `fiscus_worker`, only on a leased
  connection, and changes only the timing and status columns. It's bookkeeping rather than a change
  anyone made, so it records no activity.
- **Shutdown.** The runner stops claiming, gives running jobs 30 seconds to finish, then releases
  the leases of any still running, so another worker takes them right away.
- **Readiness.** `/readyz` on the worker's health port fails when no pass has finished in the last
  minute (or three poll intervals), and reports the last pass's time and the running jobs.
- **Logs** carry connection ids, outcomes and codes only, and the provider's request id with a
  failure when it gave one (Plaid's `request_id`, DATA-006); errors are logged with `describeError`.
  `apps/worker/src/no-financial-data-in-logs.test.ts` checks that secrets, account names and
  amounts never appear, even when a provider's message or an error carries them.

## 5. Sync ingest

The `sync` job (#80, `apps/worker/src/sync/`), in the connection's household's system context,
recorded as activity by the system with the connection owner's member id.

- **Before anything:** a connection whose owner has left the household fails as `owner_left`
  (status `error`); only a household owner can disconnect it (D11, ACC-03).
- **Pages.** `provider.sync(secret, { cursor, since })` from the stored `sync_cursor`, where
  `since` is the earliest `sync_from` of the connection's tracked accounts. Every page is fetched
  first, following `nextCursor` while `hasMore`, and held in memory; nothing is written meanwhile.
  Then the pages are merged (each transaction's latest add, change or removal wins) and applied in
  **one** transaction that also stores the last page's `nextCursor` and `historical_complete`. A
  cursor stored part way through would make the next run skip what the remaining pages said, and
  a pending transaction's removal and its posted version can come on different pages; merged,
  they are reconciled together. A failure anywhere writes nothing, and the next run asks again
  from the same cursor. The transaction locks the connection and checks its cursor is still the
  one this run began with: if another run moved it (a lease that ran out), the job fails as
  `sync_conflict`; if the connection was disconnected meanwhile, nothing is written. On
  `mutation_during_pagination` the pages fetched so far are dropped and the run asks again from
  the cursor it began with, up to 3 times. After a re-auth the first sync can be large; it is
  still one transaction. A `window` provider (SimpleFIN) sends a single page.
- **Which accounts.** A transaction's `providerAccountId` maps to the account with that
  `provider_account_id` on this connection; anything else is ignored.
- **New transactions** (upserted by `(account_id, provider_transaction_id)`) arrive as
  `source = provider`, needing review, named from the bank's merchant name or its cleaned-up text.
  Rows dated before the account's `sync_from` (D6), in another currency, or posted for nothing are
  skipped. **Already here (D7):** a posted arrival that is the only one of its kind on its page,
  with exactly one transaction of that kind already in the account that isn't the provider's (same
  amount, currency and reported date), gets nothing new: that transaction takes the provider's id
  and keeps everything a person did to it. Pending arrivals never match. Near or ambiguous matches
  are inserted for now; `holdPossibleDuplicates()` is where #80's holds (`sync_holds`, the Possible
  duplicates review) go next. Then rules run on what arrived with their authors' reach (D9,
  `caller = null`, as on import), and transfers are detected within the **connection owner's**
  reach: both accounts theirs, and only transactions they could see counted as other candidates,
  so sync never links, or is swayed by, what's behind a privacy line they can't cross.
- **Modified** changes only what the bank owns: the amount, dates, pending, the original
  description and the foreign amount, and the name while it's still the one the bank's text gave.
  Never a field a person set (`field_versions`), the date override, or the category. A linked
  transfer whose amount changes is unlinked. A provider row a person deleted stays deleted.
- **Pending → posted** (#88, #47, walkthrough D8; data model §5). A posted transaction naming the
  pending one it replaces promotes that pending transaction in place: it takes the posted id, keeps
  the pending id as `provider_pending_id`, and gets the bank's amount, dates and text, so every
  edit, note, tag, attribution, transfer link and history entry stays with it. Its removal is not
  a removal then. A pending transaction the bank removed in an earlier sync (`provider_removed_at`)
  comes back as the posted one; one a person deleted takes the posted id and stays deleted, so the
  posted version can't arrive on its own. A pending id that already posted is never added again.
  When the posted transaction is already here on its own (`mergePosted()`), the pending one still
  stays: the copy's edits fill in what it lacks, its tags, shared note and history move over, and
  the copy is tombstoned without the bank's id. Without links (`capabilities.pendingLinks` false),
  a pending transaction missing from a window is promoted to the only new posted one on the same
  account with the same amount within 5 days that no other pending one could claim; otherwise it
  is dropped as missing and the posted one stands alone. Rules don't run again on a promotion;
  transfer detection does, since pending transactions are never linked. Each promotion records
  `transaction.posted` with the amount and dates before and after.
- **Removed**, and for a `window` page every provider row in its dates for the accounts it lists
  that it didn't return, is soft-deleted (a transfer it was in is unlinked). A transaction that was
  yours before the bank's id attached to it lets go of the id and stays. The bank's removals set
  `provider_removed_at` with `deleted_at`.
- **Balances** in the page go through `writeProviderBalances()`; card and loan details through
  `writeProviderLiabilities()` once the pages are done, when the provider has them. Touched
  accounts' computed balances are rebuilt.
- **Activity.** `sync.transactions_added` per account per sync (linked to each transaction, #46),
  `sync.transactions_matched` per account per sync for D7 matches, `transaction.provider_updated`
  per changed row (its field changes encrypted), `transaction.posted` per pending transaction that
  posted (its amount and dates before and after, encrypted), `transaction.provider_removed` per
  removal, and one `sync.applied` per sync with its mode, page and restart counts and what it did,
  as counts only (for the owner only). A transaction's history shows these as the Bank.
- **Errors** map as in §4: `login_required` and `consent_expired` set `login_required`; anything
  else is `error` with backoff. The provider's code is stored; its message never is.

## 6. Connecting a bank through Plaid Link

D2, #79: the api in `apps/api/src/connections/`, the connect pages in
`apps/web/src/routes/connect-plaid.tsx`. Plaid's own integration rules (its Build Kit) are
tracked in [PLAID_PLAN.md](../../PLAID_PLAN.md), with what's left for the server's admin to set
up in Plaid's dashboard.

1. **Link token.** `POST /api/v1/households/:id/plaid/link-token`, for owners and members;
   viewers get 403 (ACC-01). The keys are the household's, through `resolvePlaidCredentials`: its
   own set if it has one (#83; until then such a household gets 409 `plaid_unavailable`), else
   the server's, and without either also 409 `plaid_unavailable`. The token asks for
   `products: ['transactions']`, with `additional_consented_products: ['liabilities',
   'investments']` (consented at Link, billed only once called, and hiding no bank: card and
   loan details are #86's, investments aren't read yet), `country_codes: ['US', 'CA']`,
   `transactions.days_requested:
   730` (it can't be raised once the Item exists; D6's 90 days is applied when syncing, #80), and
   `redirect_uri` only when `PLAID_REDIRECT_URI` is set (on every token, update mode's too). It
   must be the server's https origin followed by `/connect/plaid/oauth`, the web app's one
   return page: Plaid matches it exactly, so it can't name a household. Without it, OAuth banks
   sign in in a pop-up, which works except in phone browsers that block them. No webhook until #84. `client_user_id` is
   a hash of the member id: stable, and neither an email nor the id itself.
   With `?connection=<id>` it's update mode, for signing in again (ACC-03, #81): only the
   connection's owner, only once its setup is done, with the Item's own access token and no
   products, and refused (409 `credentials_changed`) when the keys it was made with are gone.
2. **Exchange.** `POST /api/v1/households/:id/plaid/exchange` with `{ publicToken, link? }`,
   `link` being Link's metadata as the browser has it: the session id, the institution, and each
   account's last 4 and subtype. Before the exchange (which is when Plaid starts billing for the
   Item), a bank already connected is refused with 409 `bank_already_connected`, its
   `connectionId` and `status` in the problem: one of the caller's own connections at that
   institution still in `setup`, or a live one tracking an account with the same last 4 (and
   subtype, when both have one). The connect page offers that connection (finish choosing,
   sign in again there, or go to accounts) or "Connect it anyway", which resends with
   `duplicateOk: true` for a separate login at the same bank. Link's word is only used for this
   and kept for support: the session id goes in the `connection.setup_started` activity. The
   token is exchanged once; the api then reads the accounts (`/accounts/get`) and the bank
   (`/institutions/get_by_id`) from Plaid, never from Link's metadata, and upserts the
   institution. The connection is stored in `setup`, owned by the caller, with `provider_env`,
   `provider_client_id` and `provider_item_id`; the access token goes to `connection_secrets`,
   encrypted with the household key, and is never returned. If Plaid fails after the exchange,
   or storing fails, the Item is removed at Plaid so it isn't left behind (and billed). The
   same Item twice is 409 `already_connected`.
3. **Choosing.** The exchange returns the connection id and each account the bank offers (its
   name, official name, type and subtype in Fiscus's terms, last 4, currency, and current balance
   in Fiscus's sign) with a suggestion: `link` to one of the caller's accounts no other connection
   syncs (last 4 and type, then name: `matchAccounts` in `@fiscus/shared`, as OFX import uses),
   `skip` when that match is an account they closed, else `new`, owned by the caller and
   private, whatever the finance style: they choose who else sees each. Confirming a new
   account without a visibility makes it private too, unless it's joint (which follows the
   finance style, ADR 0006 §8). `GET /connections/:id/setup` offers them again,
   from Plaid, while the setup lasts.
4. **Confirm.** `POST /api/v1/households/:id/connections/:id/confirm`, one choice per offered
   account: `link` (an account the caller owns, in the same currency, not synced by another
   connection), `new` (optionally a name, owners including the caller, and visibility), or
   `skip`; at least one tracked. Only the connection's owner, only in `setup` (a second confirm
   is 409 `not_in_setup`). Linked accounts keep their history (D5) and sync from a week before
   their latest transaction, or 90 days back without one; new ones from 90 days back (D6). Then
   the connection is `ok` with `next_sync_at = now()`, so the runner syncs it on its next pass.
   Activity records `connection.added` once per tracked account, seen by whoever sees that
   account, with the provider and whether it was linked: no names, numbers or balances.

**Nothing is seen before confirm (D4).** Row-level security shows a connection in `setup` only to
its owner, and its accounts don't exist (or aren't linked) until confirm, so no one else sees
anything of it, and the runner never claims it. Clearing setups that are never confirmed is left
to #81.

**Link stopping** without connecting is recorded too: `POST …/plaid/link-exit` with the session
id, Link's `status`, the institution, Plaid's error type and code, and its request id (a strict
schema: never Plaid's message), as a `connection.link_exited` activity only its actor sees. It's
what Plaid's support asks for when a connection keeps failing.

**The connect pages** load Link through Plaid's react-plaid-link. The link token is asked for as
the page loads, so Link is ready the moment you continue; a fresh one after Link stops, which
leaves you on the page with Plaid's `display_message` (when it has one) and the button to try
again. Before Link opens, the link token, household and connection are kept in local storage
for four hours at most, so `/connect/plaid/oauth` can resume Link with them and the received
URL (`receivedRedirectUri`) when a bank's own sign-in page sends the browser back; it opens
Link at once, and is cleared once Link finishes or stops. Their Content-Security-Policy is the
only one that allows Plaid: `https://cdn.plaid.com` for scripts and frames, and Plaid's sandbox
and production api hosts for requests (`apps/web/docker/nginx.conf`, threat model T4). Every
other page refuses them, and the connect pages are entered and left with full page loads.

**Plaid's failures** become api problems by kind: 422 `invalid_public_token`, 409
`login_required`, 429 `rate_limited` (with `retry-after`), 503 `institution_down`, 502
`plaid_keys_refused` or `provider_unavailable`, each with Plaid's code as `providerCode` and
never Plaid's message. `no-financial-data-in-logs.test.ts` runs the flow with the fake Plaid
server, including a failure whose message names an account and its balance.
