# Threat model

- Status: Living document. Update it with any change to authentication, permissions, keys, or
  what leaves the server, and when a ticket below lands.
- Covers: what's built, plus what's designed and ticketed (Plaid, MCP and PATs, the assistant,
  receipts), marked as such.
- Related: [ADR 0005](../adr/0005-tenancy-and-trust-model.md) (tenancy and trust),
  [ADR 0006](../adr/0006-shared-finances-yours-mine-ours.md) (visibility),
  [ADR 0009](../adr/0009-ai-assistant-and-mcp.md) (assistant and MCP),
  [ADR 0013](../adr/0013-tamper-evident-activity-history.md) (activity history),
  [ADR 0014](../adr/0014-verifiable-confidentiality.md) (confidentiality),
  [permissions](permissions.md), and the public summary in [security](../security/README.md).

Each threat has a mitigation, the risk that remains, and the test or ticket that holds it in
place. A threat without a test is a gap, and gaps are issues (§5).

## 1. What's worth protecting

| Asset | Why it matters |
|---|---|
| Financial data: transactions, balances, notes, attributions | The point of the app; reveals income, habits, relationships |
| Who sees what inside a household | Private accounts and notes are private from a partner too ([ADR 0006](../adr/0006-shared-finances-yours-mine-ours.md)) |
| The history of changes | Shared money invites disputes; a quiet edit must be detectable ([ADR 0013](../adr/0013-tamper-evident-activity-history.md)) |
| Credentials: passwords, sessions, invite and reset links, (later) PATs and bank tokens | Each one is a way in |
| Keys: the master key, household data keys, the backup private key | With the data, they are the data |
| The code that runs | Whoever ships it can read everything the next time it runs |

## 2. Trust boundaries

```
Browser ──HTTPS (your proxy)──▶ web (nginx) ──▶ api ──▶ Postgres (RLS) ◀── worker
                                                 │          ▲
                                                 ▼          └── migrate, backup, maintenance jobs
                                              Valkey
Planned: worker ⇄ Plaid / SimpleFIN · api ⇄ AI provider · MCP client ──PAT──▶ mcp ──▶ api
```

- **Browser ↔ server:** everything from the browser is untrusted input. Sessions are cookies;
  every unsafe request needs a CSRF token bound to the session.
- **api ↔ database:** the api connects as `fiscus_app`, under row-level security that checks
  the household and member on every statement. The database, not only the api, keeps households
  and private rows apart ([data model §4](data-model.md#4-row-level-security)).
- **The operator:** whoever runs the server is trusted ([ADR 0005](../adr/0005-tenancy-and-trust-model.md)).
  What they do can be made detectable, not impossible.
- **Third parties** (planned): banks and Plaid, email, AI providers. They see what they're sent.

## 3. Threats

Grouped by who's attacking. **S**poofing, **T**ampering, **R**epudiation, **I**nformation
disclosure, **D**enial of service, **E**levation of privilege.

### 3.1 Someone outside, on the internet

| # | Threat | STRIDE | Mitigation | Residual risk | Held by |
|---|---|---|---|---|---|
| T1 | Guessing passwords | S | argon2id (OWASP parameters); 10 failures per account and 30 per IP per 15 minutes; identical answers for an unknown email and a wrong password | Limits are per api process, in memory; a slow, distributed guess still gets through. No second factor yet | `auth.test.ts` (rate limits, identical answers, argon2id); 2FA #27, passkeys #227; shared limits #377 |
| T2 | A stolen session cookie | S, I | `HttpOnly`, `Secure`, `SameSite=Lax`; only its hash is stored; rotated at login; ends after 7 days idle or 30 days; a password reset signs out everywhere; you can list and revoke your sessions; sensitive actions need re-authentication | A cookie taken from an unlocked device works until it expires or is revoked | `auth.test.ts` (rotation, revocation, reset, re-auth, hashes stored, idle and absolute expiry) |
| T3 | Cross-site request forgery | S, T | Signed double-submit token in `X-CSRF-Token`, HMAC-bound to the session; `SameSite=Lax` | None known | `csrf.service.test.ts`, `auth.test.ts` |
| T4 | Cross-site scripting: a merchant name or note that runs as script | E, I | React escapes everything it renders; no `dangerouslySetInnerHTML`; a strict Content-Security-Policy on every response: scripts and styles from this origin only, nothing inline, no `eval`, requests only to this origin (or `API_URL`'s); `Permissions-Policy` off for camera, microphone, location, and payment; `X-Content-Type-Options`, `X-Frame-Options: DENY`, `frame-ancestors 'none'` | Injected markup could still change the page's look (no script, no requests out) | `e2e/headers.spec.ts` (headers on pages, assets, errors, and api responses; an injected script is blocked); every e2e test fails on any CSP violation (`e2e/test.ts`) |
| T5 | SQL injection | T, I, E | Parameterized queries everywhere (Drizzle); row-level security on every household table, failing closed | Injected SQL acts as the api's role: what the session's member can see, nothing more. The worker writes in system context (from #81: ending connections at their provider, deleting their secrets; from #80: every synced transaction, balance and card detail), so a bug or injection there reaches the whole of one household, bounded by SYS-01 (every system-context write is in its job's household); what crosses households is only the claim and the job's finish, which take and return ids and change only scheduling columns | `rls.test.ts`, `system-context.test.ts` (the app role gets nothing from system context, and can't become the worker, claim, or finish a job); `accounts.test.ts`; architecture test keeps the api off system context; `sync.test.ts` (sync links transfers only within the connection owner's reach) |
| T6 | Guessing or replaying an invite, setup, or reset link | S | 32 random bytes, stored only as a hash; single use; expiry; invite tokens travel in the URL fragment and request bodies, never paths (out of logs); a join needs the invited email | Anyone holding a live link can use it once: links are shared by hand until email exists (M4) | `households.test.ts`, `auth.test.ts` (ADM-08, reset) |
| T7 | Taking over a fresh install before its owner | E | First-run setup needs a one-time token printed only in the api's logs; it closes after the first admin | Someone who can read the logs before the owner finishes setup | `auth.test.ts` (setup) |
| T8 | Finding out who has an account | I | Login answers the same for an unknown email and a wrong password; an invite tells only its link's holder whether the invited email has an account | With `SIGNUP_MODE=open` (not the default), signup says an email is taken | Accepted; `auth.test.ts` |
| T9 | Exhausting the server with large imports | D | Request size limit on import routes; parsing in the request, bounded by it | No per-user limit on how often | `imports.test.ts`; #377 |
| T10 | A forged Plaid webhook (planned) | S, T | Off by default; when on, the only public path, with the `Plaid-Verification` JWT checked; it only queues a sync, never trusts the body ([ADR 0008](../adr/0008-plaid-credentials-and-webhooks.md)) | | #84 |

### 3.2 Someone in your household

| # | Threat | STRIDE | Mitigation | Residual risk | Held by |
|---|---|---|---|---|---|
| T11 | Reading a private account, note, or another member's data | I | Row-level security per account and per note, checked against the member on every statement, plus the permissions matrix in the api | | `cross-member.test.ts`, `permissions.test.ts`, `accounts.test.ts`, `ledger.test.ts` (generated per route and role) |
| T12 | Reaching another household with known ids | I, E | RLS checks the member really belongs to the household in context; other households' ids answer like ids that don't exist | | `cross-tenant.test.ts`, `rls.test.ts` (forged contexts) |
| T13 | Quietly changing history: re-attributing a purchase, deleting a bill | T, R | Every household write records activity in the same transaction, or rolls back, sync's included (recorded as `system`, for the connection's owner, and shown as the Bank); the history is a hash chain; members can verify it, and each member's browser checks for itself that it only grew since its last visit, and warns if not ([ADR 0013](../adr/0013-tamper-evident-activity-history.md) §4) | A member with direct database access is the operator (§3.3). A device's first check trusts what it's shown | `activity.test.ts`, `rls.test.ts` (write marking); `activity-proof.test.ts`, `history-witness.test.ts`, the history e2e test |
| T14 | Doing more than a role allows (a viewer editing, a member managing owners) | E | Roles checked per route, and the database re-checks writes (`fiscus_can_manage_owners`, definer functions checking role) | | `permissions.test.ts`, `permissions-coverage.test.ts`, `system-context.test.ts` |
| T15 | A coercive partner during a departure | I, T | Planned: departure protection, packages, and a safety guide | Today, an owner can remove a member | #258, #257, #260 |
| T27 | Reading or using another member's bank connection: its access token or access URL | I, E | Kept in `connection_secrets`, apart from the connection, encrypted with the household key and bound to its connection (associated data); RLS lets only the connection's owner and the worker read it, so other members, household owners included, can't read even the ciphertext; never returned, logged, or in activity; only its owner, or a household owner once they've left, disconnects it (ACC-03) | The worker reads every secret it syncs with, as it must (§3.3, T21) | `connections.test.ts` (who reads and writes secrets, copied ciphertext doesn't decrypt, disconnecting), `cross-member.test.ts`, `permissions.test.ts` (ACC-02, ACC-03), `no-financial-data-in-logs.test.ts` (the secret in no response, log, or activity) |

### 3.3 The operator, or whoever gets the server

| # | Threat | STRIDE | Mitigation | Residual risk | Held by |
|---|---|---|---|---|---|
| T16 | A curious operator reading data | I | Self-hosted: the operator is you. Hosted: confidential VMs, keys released only to attested code | Anyone controlling the running server reads it; disclosed ([ADR 0014](../adr/0014-verifiable-confidentiality.md)) | Hosted: #312, #313 |
| T17 | An operator editing data or history directly | T, R | The hash chain breaks on any edit, insert, or deletion; verification catches it. A rewrite of the whole chain, made consistent, is caught by the browser witness: each member's browser keeps the last head it verified and folds the server's proof from it itself, so the server's own word isn't enough (#264) | The server also serves the web app, so an operator who changes its JavaScript can skip the check (#387). Direct edits to current data that record no activity aren't covered (#388). A device's first check, or one after its storage is cleared, trusts what it's shown | `activity.test.ts` (edits by a superuser), `activity-chain.test.ts` (a consistent rewrite), `activity-proof.test.ts`, `history-witness.test.ts` (tampered proofs), the history e2e test (a consistent rewrite in the database, caught in the browser) |
| T18 | A leaked database dump or backup | I | Backups encrypted to an age public key before they're written; sensitive fields encrypted with per-household keys wrapped by a master key that's never in the database | Unencrypted columns (amounts, descriptions) in an unencrypted dump: set `BACKUP_AGE_RECIPIENTS` | `backup.test.ts`, backup drill in CI |
| T19 | A leaked master key | I | Kept out of the database and image; loaded through a `KeyProvider` that fails closed; rotation re-wraps every household key | A key and a dump together read the encrypted fields | `household-key-store.test.ts`, rotation drill in CI |
| T20 | Logs or error reports leaking data | I | No financial data in logs or errors; nginx logs the path without the query | | `no-financial-data-in-logs.test.ts` (api and worker) |
| T21 | A server taken while running | I | None, by choice: background work needs the data readable | Disclosed ([security](../security/README.md#what-isnt-protected)) | |

### 3.4 Through the code and its dependencies

| # | Threat | STRIDE | Mitigation | Residual risk | Held by |
|---|---|---|---|---|---|
| T22 | A malicious or hijacked dependency | T, E | Exact pins and a frozen lockfile; nothing under 7 days old; install scripts off unless allowed by name; GitHub Actions pinned to SHAs; base images to digests; licenses checked | A dependency compromised for longer than a week, or a maintainer's own release | `renovate.json5`, `pnpm-workspace.yaml`; SBOM per release |
| T23 | A tampered release image | T | Reproducible builds, checked twice in CI and on every release; cosign signatures in a public log | One maintainer signs today | [verifying a release](../security/verify-releases.md); two-person signing #314 |

### 3.5 Through the AI assistant (planned)

| # | Threat | STRIDE | Mitigation | Residual risk | Held by |
|---|---|---|---|---|---|
| T24 | Prompt injection from a merchant name, memo, receipt, or imported file | T, E | Tools run as the member, so they see only what the member sees; every write is a change set the member reviews and applies; no tool sends anything off the server ([ADR 0009](../adr/0009-ai-assistant-and-mcp.md) §5) | A member who approves a diff without reading it | #211 (adversarial suite) |
| T25 | A stolen PAT used through MCP | S, I | Planned: scopes, `read` by default, revocation, only a hash stored | | #26, #208 |
| T26 | Data sent to a cloud model | I | Off until the admin and household enable it; disclosed on enabling; a local model sends nothing | The provider sees what the assistant sends | ADR 0009 |

## 4. What's out of scope
- The security of the machine, OS, Docker, and network the operator runs Fiscus on.
- Banks, Plaid, SimpleFIN, email and AI providers themselves.
- Physical access to an unlocked device that's signed in.

## 5. Gaps
Each is an issue:

| Gap | Issue |
|---|---|
| Rate limits are in memory per process, and not on signup or imports (T1, T9) | #377 |
| No second factor (T1) | #27, #227 |
