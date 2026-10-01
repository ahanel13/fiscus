# ADR 0008: Plaid credentials (instance default + household override) and optional webhooks

- Status: Accepted
- Date: 2026-10-01
- Extends: ADR 0004 (pluggable providers), ADR 0005 (encryption)

## Context
Plaid has two kinds of credential:

- **API keys** (`client_id` + `secret`) identify a Plaid developer account, which is billed per connected Item.
- An **access token** exists per Item, i.e. per linked bank login.

By default the instance operator's account serves every household. Some households will
want to use their own Plaid account, to carry their own cost and avoid depending on the
operator's account.

Plaid can push **webhooks** (new transactions, login required, etc.), but that requires a
publicly reachable HTTPS endpoint. Many installs sit behind home NAT with nothing exposed.

## Decision

### Credentials
1. **Instance default**: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (env or `_FILE`
   secrets). If they are absent, Plaid is unavailable unless a household supplies its own keys.
2. **Household override**: a household owner can enter their own Plaid keys in household
   settings. These are stored in `aggregation_credentials(household_id, provider, client_id,
   secret_enc, env)`, encrypted with the **household data key** (ADR 0005). The secret is
   write-only in the UI and never shown again.
3. The admin controls this with the instance setting `plaid.allowHouseholdKeys` (default `true`),
   and can also disable Plaid per household.
4. Each **Item records the credential set that created it**. A Plaid Item belongs to one Plaid
   developer account and can't move between them, so **switching credentials means re-linking**
   existing banks. The UI explains this and offers a guided re-link.
5. Own keys move *cost and dependency*, not *trust*: tokens still live on the operator's
   server (ADR 0005 trust model). The settings page says so.

### Sync: polling always, webhooks optional
1. **Polling is the baseline and always runs.** The worker calls `/transactions/sync` per Item
   on a schedule (default every 4 h, admin-configurable), plus on-demand "refresh now".
2. **Webhooks are off by default** and enabled by the **instance admin** by setting a public
   base URL (`PLAID_WEBHOOK_URL`, or the admin console). When enabled:
   - New Items are created with the webhook URL.
   - Existing Items are migrated via `/item/webhook/update`, including household-key Items.
   - The endpoint is `POST /api/v1/webhooks/plaid`. It is the **only** path that needs public
     exposure, and the deploy docs show a reverse-proxy or Cloudflare Tunnel rule for that path alone.
   - Every request's `Plaid-Verification` JWT is **verified** against the verification key for
     the Item's credential set (looked up by `item_id`). Unverified requests are rejected and logged.
   - Handlers only **enqueue** a sync or flag an Item. No data is trusted from the webhook body itself.
   - While webhooks are healthy, the polling interval relaxes (default 12 h) as a safety net.
3. The admin console shows webhook health: last received, verification failures, and Items without a webhook.

## Consequences
- Works out of the box behind NAT with no inbound exposure. Admins who expose one path get near-real-time updates and faster "login required" alerts.
- Supporting several credential sets means credential lookup is per Item everywhere: sync,
  webhook verification, and update mode.
- Switching a household between instance and own keys is a re-link event, not a toggle.
