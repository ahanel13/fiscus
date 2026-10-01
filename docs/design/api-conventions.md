# API conventions

- Status: Proposed
- Issue: #4
- Builds on: [data model](data-model.md), [permissions](permissions.md), [ADR 0001](../adr/0001-typescript-monorepo.md), [ADR 0006](../adr/0006-shared-finances-yours-mine-ours.md), [ADR 0011](../adr/0011-time-ranges-and-periods.md)

One set of rules for every HTTP endpoint, so the web client, the MCP tools, scripts, and third
parties all see the same API.

## 1. Shape of the API

### 1.1 Base paths
| Path | Purpose |
|---|---|
| `/api/v1/auth/*` | Login, logout, signup, invites, password reset, OIDC callbacks |
| `/api/v1/me` | The current user, their memberships and preferences |
| `/api/v1/households/{householdId}/…` | **All household data.** The household is always explicit in the path |
| `/api/v1/admin/…` | Instance-admin context (permissions §5). Session only |
| `/api/v1/webhooks/plaid` | Inbound provider webhooks (ADR 0008). No session, JWT-verified |
| `/api/v1/events` | Server-sent events stream (§9) |
| `/api/docs`, `/api/openapi.json` | Generated OpenAPI 3.1 and its UI |
| `/healthz`, `/readyz` | Liveness and readiness (ADR 0003) |

The household is in the path, not a header, so URLs are unambiguous, bookmarkable, and loggable.
A user in several households just changes the path segment. A PAT is bound to one member, and
therefore one household; a path naming any other household returns **404**.

### 1.2 Resources and methods
- Plural nouns, **kebab-case** segments: `/category-groups`, `/import-batches`.
- Nest **one level** only, and only for strongly owned children:
  `/transactions/{id}/notes`, `/accounts/{id}/balances`. Everything else is flat with filters
  (`/transactions?accountId=…`, not `/accounts/{id}/transactions`).
- Methods:
  - `GET`: read.
  - `POST`: create.
  - `PATCH`: partial update (JSON Merge Patch semantics: an omitted field is unchanged, `null` clears it).
  - `DELETE`: remove.
  - `PUT`: only for idempotent replacement of singletons (e.g. `/me/preferences/{key}`).
- Non-CRUD **actions** are sub-resources with `POST`: `POST /transactions/{id}/split`,
  `POST /rules/{id}/dry-run`, `POST /import-batches/{id}/revert`.
- **Bulk** operations: `POST /transactions/bulk-update` with `{ ids: [...], patch: {...} }`
  (max 500). The response has a per-item result (§8.3).
- **Long-running** work (imports, "apply rule to existing", exports, re-encryption) returns `202
  Accepted` with `Location: …/jobs/{jobId}`. The job resource reports progress, and an SSE
  event fires on completion.

### 1.3 JSON style
| Thing | Convention | Example |
|---|---|---|
| Field names | **camelCase** (the DB stays snake_case; Drizzle maps) | `postedDate`, `isBusiness` |
| IDs | UUIDv7 strings | `"0192f1c4-…"` |
| Booleans | `is…` / `has…` | `hasSplits` |
| Timestamps | RFC 3339 **UTC** with `Z`, suffix `At` | `"updatedAt": "2026-10-01T15:04:05.123Z"` |
| Calendar dates | ISO `YYYY-MM-DD`, suffix `Date`. Never shifted by timezone | `"postedDate": "2026-09-30"` |
| Enums | snake_case strings | `"visibility": "view_only"` |
| Unknown fields | Clients **must ignore** them (forward compatibility) | |

### 1.4 Envelope
Every successful JSON response is `{ "data": …, "meta": { … } }`.
- `data` is an object (single resource) or an array (list).
- `meta` carries request-level context:
  - `requestId`;
  - the resolved `range` and `lens` (§5);
  - `page` for lists (§3).

## 2. Money, decimals, and currencies (decided in #4 review)

| Kind | JSON type | Example | Why |
|---|---|---|---|
| Money amount | **integer minor units** + currency code | `"amount": -4580, "currency": "USD"` | Exact as an integer up to ±$90 trillion. Easy to sort and sum. Same as Stripe |
| Quantity, price, FX rate, percentage | **decimal string** | `"quantity": "0.1234560000"`, `"fxRate": "1.0912"` | Not representable exactly as floats |
| Shares / splits | integer basis points | `"shareBps": 5000` | |

- **Positive = money in, negative = money out** (data model §1).
- Read-time conversion (data model §3.4) adds a sibling block:
  `"base": { "amount": -4995, "currency": "USD", "fxRate": "1.0906", "fxRateDate": "2026-09-30" }`.
- A provider-converted foreign purchase adds `"foreign": { "amount": -4200, "currency": "EUR" }`.
- Clients format money with the shared `formatMoney()` from `packages/shared`, which knows each
  currency's exponent. Code review rejects hand-rolled `/ 100`.

## 3. Lists: cursor pagination, sorting, filtering

- `?limit=` (default 50, max 200) and `?cursor=`.
- `meta.page = { "nextCursor": "…" | null, "hasMore": true }`.
- Cursors are **opaque** (base64url of the sort key + id). They are stable while syncs insert
  rows, so nothing is skipped or duplicated.
- `?includeTotal=true` adds `meta.page.total`. It is opt-in because counting is expensive.
- **Sorting:** `?sort=-effectiveDate,amount` (`-` = descending). Each endpoint allow-lists its
  sort fields, and every sort gets an implicit final `id` tiebreak.
- **Filtering:** named query params per endpoint, with shared conventions:

| Pattern | Meaning | Example |
|---|---|---|
| `field=a,b` | any of | `accountId=…,…&categoryId=…` |
| `fieldMin` / `fieldMax` | inclusive bounds | `amountMin=-10000&amountMax=0` |
| `q` | text search (names, descriptions; not encrypted notes) | `q=costco` |
| `is…` | boolean filters | `isBusiness=true` |
| `range`, `from`, `to` | time window (§5) | `range=last_30d` |

Unknown query params return **400** (`unknown_parameter`), so typos are caught rather than silently ignored.

## 4. Errors: RFC 9457 problem details

Content type `application/problem+json`:

```json
{
  "type": "/problems/edit_conflict",
  "title": "This transaction was changed by someone else",
  "status": 409,
  "code": "edit_conflict",
  "detail": "Alex changed category 30 seconds ago.",
  "instance": "req_0192f1c4…",
  "errors": [ { "path": "patch.categoryId", "code": "field_conflict", "message": "…" } ]
}
```

- `code` is **stable** and snake_case. Clients branch on `code`, never on `title` or `detail`.
- `instance` = request id (also in the `X-Request-Id` response header).
- `type` resolves to a docs page served by the app.

| Status | When | Example codes |
|---|---|---|
| 400 | Malformed request, unknown param | `bad_request`, `unknown_parameter` |
| 401 | Not authenticated / token revoked | `unauthenticated` |
| 403 | Visible but not allowed (permissions §1) | `forbidden`, `token_scope`, `ai_disabled` |
| 404 | Missing **or invisible** (never reveals existence) | `not_found` |
| 409 | State conflict | `edit_conflict` (§8), `last_owner`, `already_exists` |
| 422 | Validation failed | `validation_failed`, `private_joint_disallowed`, `idempotency_key_reused` |
| 428 | Versioned write without `If-Match` | `precondition_required` |
| 429 | Rate limited | `rate_limited` |
| 503 | A provider or dependency is down | `provider_unavailable` |

## 5. Lens and time ranges

Every read endpoint over financial data accepts:

| Param | Values | Default |
|---|---|---|
| `lens` | `all` · `me` · `shared` · `member:{memberId}` (ADR 0006 §5, F6) | `all` |
| `range` | an ADR 0011 preset (`this_month`, `last_30d`, `ytd`, …) | per endpoint (member preference, else `last_30d`) |
| `from` / `to` | custom range (`YYYY-MM-DD`). Mutually exclusive with `range` | |
| `granularity` | `day` · `week` · `month` · `quarter` · `year` | auto from range length |
| `compare` | `none` · `previous_period` · `same_period_last_year` | `none` |

The response echoes the effective values in `meta`, with the **resolved dates**:

```json
"meta": {
  "lens": "shared",
  "range": { "preset": "last_30d", "from": "2026-09-01", "to": "2026-09-30", "partial": false },
  "granularity": "week"
}
```

The zod schemas for these params live in `packages/shared` and are reused by every endpoint, the
web client, and the AI tools.

## 6. Visibility in responses

- Rows the caller can't see are absent. Counts and totals cover only visible rows (permissions §7).
- **F1 masking:** a transaction visible only through attribution **omits** `accountId` (and any
  account fields), and includes `paidByMemberId`. A transfer counterpart the caller can't see
  is returned as `{ "counterpartMemberId": "…" }` with no account reference.
- Encrypted fields are returned decrypted only to actors allowed to read them. Account numbers are
  only returned by the dedicated `GET /accounts/{id}/number` endpoint (ACC-10), never embedded.

## 7. Authentication and request safety

| Client | Mechanism |
|---|---|
| Web app | `fiscus_session` cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, opaque token (hash stored). **CSRF:** unsafe methods require `X-CSRF-Token` matching the per-session token from `GET /api/v1/auth/csrf` |
| MCP / scripts | `Authorization: Bearer fsc_pat_<random>`. The fixed `fsc_pat_` prefix lets secret scanners detect leaked tokens |
| Plaid webhooks | `Plaid-Verification` JWT (ADR 0008) |

- **CORS:** same-origin only by default. `CORS_ALLOWED_ORIGINS` env for split deployments (ADR 0003).
- **Re-authentication:** destructive actions (delete household or account, reveal account number,
  change MFA) require a session re-authenticated within the last 10 minutes, else 403 `reauth_required`.
- **Idempotency:** `POST` endpoints that create things or move money accept `Idempotency-Key`. It is
  **required** on imports, change-set apply, settlement creation, and the Plaid token exchange.
  Keys are stored for 24 h per (member, key) with a hash of the request. A replay returns the
  original response; the same key with a different body returns 422 `idempotency_key_reused`.

## 8. Concurrent edits: first save wins, the second is told (decided in #4 review)

### 8.1 Versions
- Every user-editable resource (transactions, accounts, rules, budgets, …) has an integer
  `version`, returned in the body and as `ETag: "v{version}"`.
- Editable rows also store `field_versions` (jsonb `{ field → version last changed }`;
  data-model addition in this PR). This lets the server tell *which* fields changed since a given version.

### 8.2 Writes
- `PATCH` **must** send `If-Match: "v{version}"`, the version the client was editing. A missing header gets 428.
- The server compares the fields in the patch with the fields changed since that version:
  - **No overlap** → apply. Saves that touch different fields both succeed (e.g. Alex sets the
    category while you edit the shared note). Returns 200 with the new version.
  - **Overlap** → **409 `edit_conflict`**, nothing is applied. The problem body includes the
    current resource and, per conflicting field: `yourValue`, `currentValue`,
    `changedByMemberId`, `changedAt`.
- The UI shows "Alex changed the category Groceries → Dining 30 seconds ago" with **Keep theirs**
  or **Apply mine**. "Apply mine" re-sends with the new version, which makes it a deliberate,
  audited overwrite rather than a silent one.
- `DELETE` of a versioned resource also requires `If-Match`.

### 8.3 Bulk and AI writes
- Bulk updates check each item independently. The response lists `{ id, status: "updated" |
  "conflict" | "forbidden" | "not_found", version?, conflict? }`, and conflicting items are skipped.
- AI change sets (ADR 0009) record the version of every row they read. At apply time, any row
  changed since then is reported as a conflict for the member to review, so the assistant never overwrites a newer human edit.

## 9. Live updates (server-sent events)

- `GET /api/v1/events` opens one SSE stream per browser session. The server sends events only
  for rows **the recipient can see** (computed per member, like notifications).
- Events are small change notices, not data: `{ type, householdId, id, version, fields,
  byMemberId, at }`. Example types: `transaction.updated`, `transaction.created`,
  `account.updated`, `sync.completed`, `job.completed`, `notification.created`.
- The web client invalidates the matching TanStack Query caches and, if the user has that
  record open for editing, shows **"Alex just edited this"** before they save.
- Reconnect uses `Last-Event-ID` with a short replay buffer (Redis, 5 min). If the stream is
  unavailable (e.g. a proxy buffers SSE), the client falls back to polling, and §8 conflict
  detection still guarantees correctness.

## 10. Rate limits

- A token bucket in Redis, keyed per member (session or PAT), plus per IP for auth endpoints.
- Defaults (admin-configurable): 600 requests/min per member, 10 login attempts/min per IP +
  per account, and AI endpoints limited separately by token budget (ADR 0009).
- Headers on every response: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.
  `429` responses add `Retry-After`.

## 11. Versioning and deprecation

- The major version is in the path (`/api/v1`). **Additive** changes (new endpoints, fields, enum
  values, optional params) ship without a version bump. Clients ignore unknown fields and must
  handle unknown enum values gracefully.
- **Breaking** changes require `/api/v2` for the affected endpoints. v1 is kept for at least two
  minor releases and marked with `Deprecation` and `Sunset` (RFC 8594) headers plus a release-note entry.
- Pre-1.0: the web client and MCP ship in lockstep with the API, so breaking changes are allowed
  in minor releases but are always called out in release notes.

## 12. Schemas and OpenAPI

- **zod is the single source of truth.** Request and response schemas live in
  `packages/shared/src/api/**`. NestJS validates with them (via `nestjs-zod`), and the OpenAPI 3.1
  document is generated from them.
- The generated `openapi.json` is **committed**, and CI fails if it is out of date. API changes
  then show up as a reviewable diff in every PR.
- The web client is generated from the spec (typed fetch client + TanStack Query hooks), and the
  MCP tool schemas reuse the same zod objects (ADR 0009).
- Each endpoint's OpenAPI entry lists its permission rule IDs (e.g. `x-permissions: [TXN-04]`),
  linking the API to the permissions matrix and its tests.

## 13. Decisions from review (#4)
1. **Money:** integer minor units for amounts. Decimal strings for quantities, prices, and rates.
2. **Pagination:** cursor-based.
3. **Concurrent edits:** first save wins. A later save that touches the **same field** gets 409
   with details and a choice. Saves touching different fields merge. Live SSE notices warn before saving.
