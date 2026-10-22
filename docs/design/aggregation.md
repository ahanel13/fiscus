# Bank aggregation: the provider interface (M2)

- Status: Accepted
- Issue: #78 (part 1: the interface, a fake provider, and a conformance suite); #81 (the runner); #80 (sync ingest)
- Builds on: [ADR 0004](../adr/0004-pluggable-providers.md), [ADR 0008](../adr/0008-plaid-credentials-and-webhooks.md), the [bank connections walkthrough](walkthroughs/bank-sync.md) (D1, D6, D8, D10, D14, D17)

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
  `since` is the earliest `sync_from` of the connection's tracked accounts. Each page is applied
  in its own short transaction that also stores the page's `nextCursor` and `historical_complete`,
  so the cursor moves only past pages that committed, and a failure keeps the pages before it.
  The transaction locks the connection and checks its cursor is still the one this run last
  stored: if another run moved it (a lease that ran out), the job fails as `sync_conflict`; if the
  connection was disconnected meanwhile, the sync stops there. On `mutation_during_pagination` the
  run starts again from the cursor it began with, up to 3 times; applying a page again changes
  nothing.
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
- **Removed**, and for a `window` page every provider row in its dates for the accounts it lists
  that it didn't return, is soft-deleted (a transfer it was in is unlinked). A transaction that was
  yours before the bank's id attached to it lets go of the id and stays.
- **Balances** in the page go through `writeProviderBalances()`; card and loan details through
  `writeProviderLiabilities()` once the pages are done, when the provider has them. Touched
  accounts' computed balances are rebuilt.
- **Activity.** `sync.transactions_added` per account per page (linked to each transaction, #46),
  `sync.transactions_matched` per account per page for D7 matches, `transaction.provider_updated`
  per changed row (its field changes encrypted), `transaction.provider_removed` per removal, and a
  `sync.page_applied` per page with its counts (the cursor and balances, for the owner only). A
  transaction's history shows these as the Bank.
- **Errors** map as in §4: `login_required` and `consent_expired` set `login_required`; anything
  else is `error` with backoff. The provider's code is stored; its message never is.
