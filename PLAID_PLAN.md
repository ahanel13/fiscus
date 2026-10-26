# Plaid integration plan

The durable state of Fiscus's Plaid integration, kept with Plaid's Build Kit (the Plaid MCP
server). The design itself is in [docs/design/aggregation.md](docs/design/aggregation.md) and
[the bank connections walkthrough](docs/design/walkthroughs/bank-sync.md) (D1–D17); this file
records Plaid's rules as they apply to it, what's done, and what's left for a person to do in
Plaid's Dashboard.

## Goal

Fiscus, a self-hosted personal finance app: households connect their banks through Plaid Link to
sync transactions, balances, and credit card/loan liabilities. (workflow_id: wf_bb8c5a7fa450cded)

## Scope

- Products:
  - **transactions**, in Link's `products`: bank and card activity, with each account's balance
    from `/accounts/get` at no extra charge (SELECT-001, SELECT-005).
  - **liabilities**, in `additional_consented_products`: card and loan APRs, minimum payments and
    due dates (#86). Consented at Link, billed on the first `/liabilities/get` (LIAB-007).
  - **investments**, in `additional_consented_products`: consent only, so holdings can come later
    without asking every connection to re-consent (CONV-011, INV-015). Fiscus doesn't call it yet.
- Rejected, with why:
  - liabilities or investments in `products`: every entry there hides banks that don't support it
    and bills at creation (PITFALL-001, CONV-001).
  - Balance (`/accounts/balance/get`): billed per call, slow, 30 an hour per Item. Only for an
    explicit "check now" action, never on a schedule (BAL-001/002). Not planned.
  - Recurring Transactions: the add-later candidate for bills and subscriptions (TXN-016). The
    team is entitled to it in production. `days_requested` is already 730, so it needs no relink
    (TXN-017).
  - Auth, Identity, Identity Verification, Signal, Transfer: Fiscus moves no money and verifies no
    one (the user confirmed: read-only, no verification).
- Countries: US first; CA is in `country_codes` too (ADR 0008), and the team has production access
  in both. Liabilities coverage in Canada is limited (LIAB-001).
- Platform: web (React + TypeScript), NestJS api, Node worker. No Plaid SDK: a small `fetch` client
  with zod schemas of the fields Fiscus reads (`packages/aggregation/src/plaid`), pinned to the
  API version Plaid's docs describe (GUIDE-005, ITEM-009).
- Environment: sandbox until acceptance passes. `PLAID_ENV` alone picks the base URL and the keys'
  environment (GUIDE-004, WEB-005).

## Human tasks

States per TASK-001. Read from Plaid's Dashboard on 2026-10-22 (sandbox and production
authorized; production products for US and CA include transactions, liabilities, investments,
recurring_transactions; no redirect URIs; no webhooks; Link customization `default` only).

| Task | Why it matters | Where | State |
|------|----------------|-------|-------|
| Production access for transactions, liabilities, investments (US, CA) | Without it `/link/token/create` fails with INVALID_PRODUCT | Dashboard → Settings → Team → Products (https://dashboard.plaid.com) | verified |
| Complete the company profile and the data-security questionnaire | Gates OAuth banks: Chase silently disappears from Link without it (OAUTH-008, TASK-006) | Dashboard → Settings → Company profile (https://dashboard.plaid.com) | cannot_verify |
| Accept the latest Plaid MSA | PNC requires it (OAUTH-008) | Dashboard → Settings (https://dashboard.plaid.com) | cannot_verify |
| Finish Data Transparency Messaging / the Link use case for production | INVALID_LINK_CUSTOMIZATION at `/link/token/create` otherwise (PITFALL-002) | Dashboard → Link → Data Transparency Messaging (https://dashboard.plaid.com) | cannot_verify |
| Register the redirect URI, for an instance served over HTTPS | OAuth on mobile browsers that block pop-ups needs it. It must be HTTPS (http://localhost only in sandbox). Desktop OAuth works without one, through Link's pop-up (OAUTH-001, CONV-004) | Dashboard → API → Allowed redirect URIs (https://dashboard.plaid.com); set `PLAID_REDIRECT_URI` to the same value, `https://<host>/connect/plaid/oauth` | needs_human (the user's instance: once it has HTTPS; other instances: optional) |
| A public HTTPS webhook receiver | Plaid's update webhooks need one; a LAN-only instance can't have it, so Fiscus polls (see Decisions) (WEBHOOK-001, WEBHOOK-005) | the instance's reverse proxy, then `PLAID_WEBHOOK_URL` (#84) | needs_human (optional; #84) |
| Put sandbox keys in the env file | The api and worker read `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (GUIDE-021, TASK-010) | `plaid keys write --env sandbox --gitignore`, or copy from https://dashboard.plaid.com/developers/keys | needs_human |
| Sandbox keys as repository secrets | The nightly real-sandbox job (`.github/workflows/plaid-sandbox.yml`, #79) runs only with them, and passes with a notice without them. Sandbox keys only, never production (GUIDE-001) | GitHub → the repository's Settings → Secrets and variables → Actions: `PLAID_SANDBOX_CLIENT_ID`, `PLAID_SANDBOX_SECRET`, from https://dashboard.plaid.com/developers/keys | needs_human |
| Fidelity, once investments are read | Not immediate after production approval (INV-014) | Dashboard → OAuth institutions (https://dashboard.plaid.com) | not_applicable (investments not read yet) |

## Implementation checklist

Link and exchange (api, #79):

- [x] Link token from the api only; keys server-side, never logged (GUIDE-001, GUIDE-003, GUIDE-006)
- [x] `client_user_id` opaque and stable per member
- [x] `transactions.days_requested` 730 at first Link: it can't be raised later (TXN-009)
- [x] `redirect_uri` on every link token, update mode included, when the server has one (OAUTH-002, OAUTH-005)
- [x] Public token exchanged at once; access token encrypted, never returned (GUIDE-013, GUIDE-015, DATA-001, WEB-002)
- [x] Institution from `/institutions/get_by_id` with optional metadata, not Link's metadata (GUIDE-017)
- [x] An Item that can't be recorded is removed at Plaid, so it isn't billed (ITEM-005)
- [x] Update mode: the Item's access token, no products (ITEM-003)
- [x] `additional_consented_products: ['liabilities', 'investments']` (LIAB-007, INV-015)
- [x] Before the exchange, check for a live connection at the same institution, from Link's
      `institution_id` and account masks, and offer it instead (ITEM-011, ITEM-001)
- [x] Keep Link's `link_session_id` and institution with the connection, and record exits and
      their error codes, for support (WEB-003, CONV-014, CONV-015): in the activity history,
      only for the person

Web (#79):

- [x] react-plaid-link's `usePlaidLink`, initialized when the page loads, the button gated on
      `ready` (WEB-001, WEB-020, WEB-021)
- [x] OAuth return, at the fixed path `/connect/plaid/oauth`: the same link token, kept across the redirect, and `receivedRedirectUri`;
      opened at once (OAUTH-003, OAUTH-004, WEB-022)
- [x] onExit: no error is no action; an error shows Plaid's `display_message` when set, and a retry
      (WEB-003, ITEM-002)
- [x] The connect pages' CSP: `https://cdn.plaid.com` in script-src and frame-src, Plaid's API host
      for `PLAID_ENV` in connect-src; nothing inline (WEB-006)
- [x] Copy before Link: "Add a bank account", that Fiscus never sees the bank password, that it
      can be disconnected any time (CONV-008)

Sync (worker, #80, #88):

- [x] The Plaid adapter, registered in the worker: `/transactions/sync` only (TXN-001), `count`
      500 (TXN-011), PFC version pinned (TXN-006) (#419)
- [x] Sync fetches every page to `has_more: false`, then writes the transactions and the cursor in
      one transaction; on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION it starts again from the
      cursor it began with (TXN-002, TXN-007, DATA-007) (#416)
- [x] `removed` handled; pending to posted matched through `pending_transaction_id`, across pages,
      keeping the person's edits (TXN-004, #88, #416)
- [x] Plaid's sign reversed: positive is money out (TXN-005) (#419)
- [x] An empty first sync is normal; "still bringing in older transactions" on Accounts until
      `HISTORICAL_UPDATE_COMPLETE` (TXN-008)
- [x] `/liabilities/get` only on Items with a card or loan account; APRs chosen by type
      (LIAB-008, LIAB-003, LIAB-002) (#419)
- [x] Errors by `error_type` and `error_code`; capped backoff with jitter for INSTITUTION_DOWN,
      PRODUCT_NOT_READY, RATE_LIMIT_EXCEEDED; ITEM_LOGIN_REQUIRED asks the owner to sign in again
      (ITEM-002, ITEM-004, ITEM-013, #81) (#412, #419, #425)
- [ ] ITEM_NOT_FOUND during a sync purges the access token (ITEM-005); today the connection goes to
      `error` with backoff (#419's notes)
- [x] Disconnect calls `/item/remove` (ITEM-005), and so does a setup left unfinished for a day
      (#81), so an Item nobody uses isn't billed
- [x] ITEM_LOGIN_REQUIRED: the owner gets "Sign in again" on Accounts, which opens Link's update
      mode and keeps the same Item (ITEM-003, #81); everyone else who sees its accounts is told
- [x] "Refresh now" re-reads what Plaid has, at most every 15 minutes; `/transactions/refresh`
      (billed per call; the team has it in production) stays off until an admin switch exists
      (TXN-010, GUIDE-016)
- [x] Plaid's `request_id` kept with failures, never a token (DATA-006) (#419)
- [ ] Synced transactions near one already here wait for a person (D7, #80, #429), so a linked
      account's overlap isn't counted twice

Webhooks (#84, #85), only for instances Plaid can reach:

- [ ] `webhook` on the link token when `PLAID_WEBHOOK_URL` is set (WEBHOOK-002)
- [ ] Verified by its ES256 JWT, body hash, and age (WEBHOOK-003, WEBHOOK-004)
- [ ] Triggers, not data: SYNC_UPDATES_AVAILABLE, LIABILITIES DEFAULT_UPDATE, and the ITEM
      webhooks (WEBHOOK-005, WEBHOOK-006, TXN-003, LIAB-004)

## Acceptance

- Round 0 (2026-10-22, #417): FAIL. Passed 001–005, 009–011, 013; 006 not applicable (no
  webhook receiver yet). Failed: 007 (no redirect URI registered: the instance has no HTTPS yet),
  008 (only a fake Plaid and a stubbed Link so far, no real sandbox run), 012 (the first sync
  fails until the worker's Plaid adapter lands; "sign in again" from the app is #81), 014
  (polling not yet accepted; since accepted by the user), 015 (no transactions arrive until the
  adapter lands; second persona not run).
- Round 1 (2026-10-25, "still bringing in older transactions"): FAIL. Passed 001–005, 010–014;
  006 not applicable (no webhook receiver). Failed: 007 (no redirect URI: the instance is still
  plain HTTP), 008 and 015 (no real sandbox run yet: sandbox keys aren't in the env file, so no
  user_good or second persona), 009 (needs_human and cannot_verify tasks remain). The sync
  adapter (#419), sign in again (#425) and polling's acceptance closed round 0's 012 and 014.
- Round 2 (2026-10-26, the real-sandbox job, #79): FAIL, on the same four. Passed 001–005,
  010–014; 006 not applicable. Failed: 007 (no redirect URI: plain HTTP), 008 and 015 (the job
  that makes, syncs, breaks and removes Items for two personas is built, but hasn't run: no
  sandbox keys in the repository's secrets yet), 009 (needs_human and cannot_verify tasks remain).

## Maintenance

This integration is maintained with the Plaid MCP; this file is its durable state. Agents working
in this repository: consult build_guidance before modifying any Plaid-touching code, and re-run
build_check_acceptance before reporting such a change as working. The acceptance above applies only
to the code as it was verified — later changes invalidate it.

## How to test

### Connect a sandbox bank

1. Put sandbox keys in the env file (see Human tasks), with `PLAID_ENV=sandbox`, and start the
   stack.
2. In a household, open Accounts → Add → Connect a bank, then "Add a bank account".
3. In Link, pick First Platypus Bank and sign in as `user_good` / `pass_good`.
4. Choose what each account becomes, then confirm. Within a minute the accounts show their
   balances and transactions.

### The real-sandbox job

`apps/api/src/connections/plaid-sandbox.test.ts` runs nightly, by hand (Actions → Plaid sandbox →
Run workflow), and on pushes to main. Without Link (SANDBOX-003), it:

- Creates the link token Fiscus asks for.
- Makes an Item at First Platypus Bank for `user_good` (with liabilities) and for
  `user_transactions_dynamic` (SANDBOX-009), exchanges it, and lists its accounts.
- Syncs to the end, with a capped growing wait until the history is in.
- Reads liabilities, then forces a login break (SANDBOX-004) and expects `login_required`.
- Removes the Item, and checks that it's gone.

Locally: export `PLAID_SANDBOX_CLIENT_ID` and `PLAID_SANDBOX_SECRET` (sandbox keys), then run
`pnpm --filter @fiscus/api exec vitest run src/connections/plaid-sandbox.test.ts`. Without them,
it's skipped.

### Sign in again

1. On a connected sandbox Item, force a broken login with `/sandbox/item/reset_login`.
2. After the next sync the connection asks its owner to sign in again; doing so keeps the same
   connection, with no duplicate.

## Decisions made

- Route and api surface: the connect page at `/h/:householdId/connect/plaid`, and the api's
  `/api/v1/households/:householdId/plaid/*` endpoints (`link-token`, `exchange`), as designed in the walkthrough (D2) and
  approved by the user.
- Polling instead of webhooks by default: a self-hosted instance is often LAN-only, with no public
  HTTPS receiver, so each connection syncs on a schedule (`next_sync_at`, every 4 hours by default) and webhooks are opt-in (#84). This
  is a stated stopgap, not a silent default (WEBHOOK-005). Accepted by the user on 2026-10-22:
  "schedule now, webhooks opt-in later" (#84).
- No redirect URI by default: many self-hosted instances are reached by plain IP over HTTP, and
  Plaid only allows HTTPS redirect URIs. OAuth banks then sign in through Link's pop-up. An
  instance with HTTPS sets `PLAID_REDIRECT_URI` to `https://<host>/connect/plaid/oauth` and
  registers it (the user's own instance will, once it has HTTPS).
- Investments consented now, not read: confirmed by the user on 2026-10-22.
- No Plaid SDK on the server; react-plaid-link on the web (WEB-020).
- Moving a bank to a household's own keys (#83, D15): an Item can't change Plaid accounts, so it's a
  new Item through the usual link token and exchange, with `replaces` on the exchange naming the old
  connection (the connect page's `?replaces=`). The same bank is checked before the exchange
  (ITEM-011, nothing billed when it isn't), and the old Item gets `/item/remove` with its own keys
  only once the new one's accounts are confirmed (ITEM-005), which also settles a bank that cut the
  older Item off when the new one connected (ITEM-012).

## Open questions

- None open. The user's instance is plain HTTP by IP for now; HTTPS (and its redirect URI) is
  planned.
