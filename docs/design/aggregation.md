# Bank aggregation: the provider interface (M2)

- Status: Accepted
- Issue: #78 (part 1: the interface, a fake provider, and a conformance suite); #81 (the runner); #80 (sync ingest); #79 (connecting through Plaid Link)
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
`transient`), the provider's `providerCode`, and `retryAfterMs` when the provider says. The
provider's own message is untrusted display text: it is kept out of `message` and out of the
error's JSON, so logging the error can't log it.

**Connecting is per provider**, outside the interface: Plaid Link's public token and a SimpleFIN
setup token share too little. Each provider has a `ProviderConnectFlow` whose `connect` returns
`{ providerItemId, secret, institution, accounts }`.

## 2. `@fiscus/aggregation`

- `ProviderRegistry`: the providers this server has enabled, looked up by a connection's
  `provider`. Per-connection credentials (ADR 0008) build on it in #83.
- Plaid (#82): `PlaidClient`, a small `fetch` client for the endpoints M2 uses, with zod-checked
  responses and Plaid's errors mapped to `ProviderError` kinds; `plaidEnvVars` and
  `instancePlaidConfig` for the server's keys (all three or none); `resolvePlaidCredentials`,
  which gives a connection its keys (null `credential_set_id` = the server's), and
  `credentialsChanged`, true when a connection's recorded `provider_env` or `provider_client_id`
  no longer matches (a rotated secret isn't a change). The base URL comes from `PLAID_ENV`; a
  test-only override is honored only in sandbox.
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
    Plaid's format and sign, checking keys and tokens, with scripted failures.

## 3. The conformance suite

`describeProviderConformance(name, create, { errorKinds, unsupportedFields? })` runs the cases
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

The fake passes it in both modes, as the reference. The Plaid (#79) and SimpleFIN (#91) adapters
run it against stub servers.

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
  `provider_unavailable`; a job running past 10 minutes fails as `timeout`.
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
- **Logs** carry connection ids, outcomes and codes only; errors are logged with `describeError`.
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

The api's side of D2 (#79, `apps/api/src/connections/`). The connect screens, Link's loader and
the connect page's Content-Security-Policy come in a later part of #79.

1. **Link token.** `POST /api/v1/households/:id/plaid/link-token`, for owners and members;
   viewers get 403 (ACC-01). The keys are the household's, through `resolvePlaidCredentials`: its
   own set if it has one (#83; until then such a household gets 409 `plaid_unavailable`), else
   the server's, and without either also 409 `plaid_unavailable`. The token asks for
   `products: ['transactions']`, `country_codes: ['US', 'CA']`, `transactions.days_requested:
   730` (it can't be raised once the Item exists; D6's 90 days is applied when syncing, #80), and
   `redirect_uri` only when `PLAID_REDIRECT_URI` is set. No webhook until #84. `client_user_id` is
   a hash of the member id: stable, and neither an email nor the id itself.
   With `?connection=<id>` it's update mode, for signing in again (ACC-03, #81): only the
   connection's owner, only once its setup is done, with the Item's own access token and no
   products, and refused (409 `credentials_changed`) when the keys it was made with are gone.
2. **Exchange.** `POST /api/v1/households/:id/plaid/exchange` with `{ publicToken }`. The token
   is exchanged once; the api then reads the accounts (`/accounts/get`) and the bank
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
   `skip` when that match is an account they closed, else `new`, owned by the caller with the
   finance style's visibility (ADR 0006 §8). `GET /connections/:id/setup` offers them again,
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

**Plaid's failures** become api problems by kind: 422 `invalid_public_token`, 409
`login_required`, 429 `rate_limited` (with `retry-after`), 503 `institution_down`, 502
`plaid_keys_refused` or `provider_unavailable`, each with Plaid's code as `providerCode` and
never Plaid's message. `no-financial-data-in-logs.test.ts` runs the flow with the fake Plaid
server, including a failure whose message names an account and its balance.
