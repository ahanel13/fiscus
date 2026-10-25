# Permissions matrix

- Status: Proposed
- Issue: #3
- Builds on: [data model](data-model.md), [ADR 0012](../adr/0012-member-lifecycle.md), [ADR 0005](../adr/0005-tenancy-and-trust-model.md), [ADR 0006](../adr/0006-shared-finances-yours-mine-ours.md), [ADR 0009](../adr/0009-ai-assistant-and-mcp.md)

This is the security specification for M0–M1. It defines who can see and do what. Every row has
an ID, and **each (row, actor) cell is a test case**, named `<row-id>/<actor>`, e.g.
`TXN-04/VIEW`. These tests form the cross-tenant and cross-member leakage suites.

## 1. How a permission is decided

```
allowed = role permits the action
        ∧ the row is visible to the member         (RLS, data model §4)
        ∧ the token's scope permits it              (session = full; PAT read/write)
        ∧ the feature is enabled                    (instance + household settings)
        ∧ the action-specific rule holds            (§4, e.g. only owners of the paying account set attribution)
```

- **Deny by default.** Anything not granted here is forbidden.
- **Not visible ⇒ 404, not 403.** A member asking for a resource they can't see gets `404 Not Found`, so the API never confirms that something exists.
- **Visible but not allowed ⇒ 403** with a stable error code (see API conventions, #4).

## 2. Actors

| ID | Actor | Notes |
|---|---|---|
| ANON | Unauthenticated | Signup (if enabled), login, invite acceptance, health checks |
| IADM | Instance admin, in **admin context** (`/api/v1/admin/*`) | Session only, never PAT. Recent re-authentication required for destructive actions. **No household data access from this role** |
| OWN | Household member with role `owner` | Manages the household. **Cannot override other members' visibility** |
| MEM | Household member with role `member` | |
| VIEW | Household member with role `viewer` | Read-only. **Cannot own accounts** |
| PAT-R / PAT-W | Personal access token, scope `read` / `write` | Acts as the issuing member. **Never exceeds** that member's role; a viewer's PAT is read-only regardless of scope |
| SYS | Worker in system context (`app.system = on`, honored only for the `fiscus_worker` login, #376) | Household-scoped. Anything it surfaces to people is filtered for the recipient |
| AI | Assistant acting as a member | Same as that member. Writes only via change sets, and only if the household allows AI write tools (ADR 0009) |

An instance admin who is also a household member has **two separate identities**: the admin
context (metadata only) and their membership (normal member rules). Audit events record which one acted.

**Column legend** used in the tables:
- ✅ allowed
- ❌ denied
- **own**: only rows the actor owns or authored
- **vis**: only rows visible to the actor (RLS)
- **acct-own**: only if the actor owns the related account
- **acct-full**: the actor owns the account or has `full` visibility of it

Unless noted, PAT-R = the member's read rights only, PAT-W = the member's rights, and AI = the member's rights (writes via change set).

## 3. Visibility levels (recap and exact effect)

The access level (`fiscus_account_access()`) for (member, account):

| Data | `owner` | `full` | `view_only` | `balance_only` | none (private, not owner) |
|---|---|---|---|---|---|
| Account exists / name / type / institution | ✅ | ✅ | ✅ | ✅ | ❌ (404) |
| Balance and balance history | ✅ | ✅ | ✅ | ✅ | ❌ |
| Counted in "net worth (visible to you)" | ✅ | ✅ | ✅ | ✅ | ❌ |
| Transactions on the account | ✅ | ✅ | ✅ | ❌ | ❌ |
| Categorize / review those transactions (TXN-04) | ✅ | ✅ | ❌ | ❌ | ❌ |
| …except transactions **attributed to me** (F1) | ✅ | ✅ | ✅ | ✅ (shown without account) | ✅ (shown without account) |
| Read shared notes on visible transactions | ✅ | ✅ | ✅ | only attributed ones | only attributed ones |
| Account notes | ✅ | ✅ | ✅ | ❌ | ❌ |
| Card and loan details (`account_liabilities`: APR, payments, statement; #86) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Account number (`account_number_enc`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Receipts (M9) | follow their transaction | | | | |

**F1 serialization rule:** when a transaction is visible only because it is attributed to the
caller, the API omits `account_id`, account name, mask, and institution, and returns
`paid_by_member_id` instead. The same applies to the counterpart of a transfer into an account the
caller can't see ("Transfer to Anthony").

## 4. Matrix: household context

### 4.1 Household and membership
| ID | Action | OWN | MEM | VIEW | Notes |
|---|---|---|---|---|---|
| HH-01 | Read household settings (name, currency, timezone, …) | ✅ | ✅ | ✅ | |
| HH-02 | Update household settings | ✅ | ❌ | ❌ | |
| HH-03 | List members (name, color, role) | ✅ | ✅ | ✅ | Emails visible to OWN only |
| HH-04 | Invite member / change role / remove member | ✅ | ❌ | ❌ | Can't remove or demote the **last owner**. Removing a member who owns or co-owns accounts, or is part of shared records, triggers their **departure package** (ADR 0012) instead of simply cutting access |
| HH-05 | Leave household | ✅ | ✅ | ✅ | Last owner must transfer ownership or delete the household first |
| HH-06 | Demote a member who owns accounts to viewer | ❌ | ❌ | ❌ | Their accounts must be transferred first (viewers can't own accounts) |
| HH-07 | Delete household | ✅ | ❌ | ❌ | Re-authentication required. Other members are notified. **7-day grace** before crypto-shred, cancellable by any owner |
| HH-08 | Configure household Plaid keys | ✅ | ❌ | ❌ | Secret is write-only. Read returns `client_id` (masked: last 4) + environment + created date only. Changing or removing them needs recent re-authentication (#83) |
| HH-09 | Configure household AI settings (provider, on/off, write tools) | ✅ | ❌ | ❌ | Members can always opt themselves out (HH-10) |
| HH-10 | Own preferences (range defaults, AI opt-out, notifications) | own | own | own | |
| HH-11 | Read household audit log (household-visible events) | ✅ | ❌ | ❌ | Includes instance-admin actions affecting the household (ADR 0005) |
| HH-12 | Read activity feed (attribution and other shared changes, F6) | vis | vis | vis | Only events whose target the caller can see |
| HH-13 | Export data | vis | vis | vis | An export contains only what the caller can see. The owner gets no special export |
| HH-14 | See household-shared records dated before you joined | extend | own | own | Only records from your `history_from` date (default `joined_at`) unless you're part of them. Owners can **extend** a member's window, never narrow it (ADR 0012) |
| HH-15 | Turn on departure protection | ✅ | ✅ | ❌ | Any adult member. Freezes shared history before the chosen date. Ends when the departing members leave or all affected adults agree |
| HH-16 | Take a departure package (own accounts, read-only snapshot, final settle-up, export) | ✅ | ✅ | ✅ | Needs no approval. Live joint-account transfers still need co-owner approval |
| HH-17 | Claim ownership when owners are unresponsive | ✅ (n/a) | ✅ | ❌ | All owners notified; any owner can reject within 30 days; then the claimant becomes an additional owner (ADR 0012) |
| HH-18 | Change your own name and color in the household | own | own | own | Colors come from the member palette; two current members can't share one |
| HH-19 | Check the activity history (verify, proof), and report a failed check | ✅ | ✅ | ✅ | A proof shows how many events there are, hidden ones included, never what they were (accounts-and-visibility §6). A report is a household-visible event, labelled as a device's claim; a few an hour per member (#264) |

### 4.2 Connections and accounts
| ID | Action | OWN | MEM | VIEW | Notes |
|---|---|---|---|---|---|
| ACC-01 | Link a bank (create connection) | ✅ | ✅ | ❌ | The linking member becomes the connection owner and the default account owner |
| ACC-02 | Read connection status | vis | vis | vis | Visible if the caller can see ≥1 of its accounts |
| ACC-03 | Re-auth / refresh / unlink connection | own | own | ❌ | Connection owner only. If the owner has left, any household OWN may unlink |
| ACC-04 | Create manual account | ✅ | ✅ | ❌ | Creator becomes the sole owner |
| ACC-05 | Read account (§3) | vis | vis | vis | |
| ACC-06 | Rename / edit account settings, account notes | acct-own | acct-own | ❌ | |
| ACC-07 | Change visibility | acct-own | acct-own | ❌ | Any owner of a joint account may change it, and the change is posted to the activity feed. `private` on a joint account in a 2-member household is rejected (F2) |
| ACC-08 | Add owners, change shares | acct-own | acct-own | ❌ | New owners must be OWN/MEM. Shares must sum to 10 000. **Removing an owner: only yourself**, never another co-owner (ADR 0012), and at least one owner must remain |
| ACC-09 | Close / archive / delete account | acct-own | acct-own | ❌ | **Close or archive** (history kept) needs one owner and notifies the others. **Permanent delete** of a joint account needs every co-owner's approval; requests expire after 14 days, leaving archive as the fallback (ADR 0012). Delete requires re-authentication. Blocked under departure protection |
| ACC-10 | Read account number | acct-own | acct-own | ❌ | |
| ACC-11 | Mark account as business | acct-own | acct-own | ❌ | |
| ACC-12 | Arrange your own accounts list (groups, order) | own | own | own | Private to you, like preferences (HH-10). Only accounts you can see; an arrangement never changes anyone's access (#48) |

### 4.3 Transactions
| ID | Action | OWN | MEM | VIEW | Notes |
|---|---|---|---|---|---|
| TXN-01 | Read transactions | vis | vis | vis | §3 including F1 |
| TXN-02 | Create / delete manual transaction | acct-own | acct-own | ❌ | |
| TXN-03 | Edit amount / date / description of a manual transaction | acct-own | acct-own | ❌ | Provider transactions' amounts and dates are read-only |
| TXN-04 | **Categorize**: category, merchant rename, tags, review status | acct-full | acct-full | ❌ | Lets a partner review and categorize on `full` accounts |
| TXN-05 | Exclude from reports / mark business | acct-own | acct-own | ❌ | Affects totals, so owners only |
| TXN-06 | Split / unsplit | acct-own | acct-own | ❌ | Splits change amounts per category and attribution per child |
| TXN-07 | Assign reviewer | acct-full | acct-full | ❌ | The reviewer must be able to see the transaction (else 422) |
| TXN-08 | Link / unlink transfer, mark settlement | acct-own (both legs visible) | acct-own (both legs visible) | ❌ | If the other leg is invisible, the member can only *suggest* the link. The other leg's owner confirms |
| TXN-09 | Import file into account | acct-own | acct-own | ❌ | |
| TXN-10 | Revert an import batch | own | own | ❌ | The member who imported it, or any owner of the account |
| TXN-11 | Read edit history of a transaction | vis | vis | vis | Entries never reveal data the caller can't otherwise see |
| TXN-12 | Move a transaction to another account | acct-own | acct-own | ❌ | Needs ownership of **both** accounts. A split moves with all its parts; same currency only |

### 4.4 Attribution (ADR 0006 §3, F1, F6)
| ID | Action | OWN | MEM | VIEW | Notes |
|---|---|---|---|---|---|
| ATT-01 | Set / change attribution | acct-own | acct-own | ❌ | Owners of the **paying** account only. `full` visibility is not enough |
| ATT-02 | Attribute to a member who can't see the account | acct-own | acct-own | ❌ | Allowed. That member gains visibility of **this transaction only** (F1) |
| ATT-03 | Flag an attribution change | involved | involved | ❌ | "Involved" = attributed before or after the change. The transaction is marked disputed in settle-up |
| ATT-04 | Resolve a flag | acct-own | acct-own | ❌ | |
| ATT-05 | Remove *my own* attribution from a transaction I don't own | ❌ | ❌ | ❌ | Use a flag instead. This prevents silently dodging a shared cost |

### 4.5 Notes
| ID | Action | OWN | MEM | VIEW | Notes |
|---|---|---|---|---|---|
| NOTE-01 | Read shared note | vis | vis | vis | Visible iff the transaction is visible (incl. via attribution) |
| NOTE-02 | Write shared note | acct-full or attributed | acct-full or attributed | ❌ | Owner or `full` on the paying account, or the transaction is attributed to the writer. `view_only` and `balance_only` can't write shared notes. `updated_by_member_id` is recorded |
| NOTE-03 | Read / write private note | own | own | own | Viewers may keep private notes |
| NOTE-04 | Read another member's private note | ❌ | ❌ | ❌ | Including OWN, SYS output, and AI acting as a different member |

### 4.6 Categories, tags, merchants
| ID | Action | OWN | MEM | VIEW | Notes |
|---|---|---|---|---|---|
| CAT-01 | Read categories, groups, tags, merchants | ✅ | ✅ | ✅ | Household-wide taxonomy |
| CAT-02 | Create / edit / reorder | ✅ | ✅ | ❌ | |
| CAT-03 | Delete or archive a category in use | ✅ | ✅ | ❌ | Requires a replacement category. Reassigns rows the deleting member **can't see** too, but reveals nothing (only the count of affected *visible* rows is shown) |
| CAT-04 | Delete system categories (`uncategorized`, `transfer`, `settlement`) | ❌ | ❌ | ❌ | |

### 4.7 Rules
| ID | Action | OWN | MEM | VIEW | Notes |
|---|---|---|---|---|---|
| RULE-01 | Read household-wide rules | ✅ | ✅ | ✅ | |
| RULE-02 | Read member-scoped rules | own | own | own | Only their member, and system context (bank sync). They run on the accounts their member owns, after household-wide rules; on a joint account every owner's run ([imports §3](imports.md)) |
| RULE-03 | Create / edit / delete household-wide rule | ✅ | ✅ | ❌ | See RULE-05 for its reach |
| RULE-04 | Create / edit / delete member-scoped rule | own | own | ❌ | |
| RULE-05 | **Reach of a rule's actions** | — | — | — | Categorize/rename/tag actions apply only to accounts where the **rule's creator** is `owner` or `full`. Attribution, exclude, split, and business actions apply only to accounts the creator **owns**. This is re-evaluated at run time, so a rule can never reach further than its creator could by hand |
| RULE-06 | Dry-run / "apply to existing" preview | vis | vis | ❌ | The preview lists only rows the caller can see |
| RULE-07 | Rules of a member who left | — | — | — | Member-scoped rules are deleted. Household-wide rules they created are **disabled** and flagged for an owner to adopt or delete |

### 4.8 Tokens and sessions
| ID | Action | OWN | MEM | VIEW | Notes |
|---|---|---|---|---|---|
| TOK-01 | Create / list / revoke own PATs | ✅ | ✅ | ✅ (read scope only) | The token value is shown once |
| TOK-02 | List / revoke other members' PATs | ✅ (metadata + revoke) | ❌ | ❌ | Security control. The owner never sees token values |
| TOK-03 | Use a PAT for admin endpoints | ❌ | ❌ | ❌ | |
| TOK-04 | List / revoke own sessions | ✅ | ✅ | ✅ | |

### 4.9 Matrix by actor type (non-role actors)
| ID | Rule | Test focus |
|---|---|---|
| PAT-01 | PAT-R can call every read endpoint its member can, and no write endpoint (403 `token_scope`) | All write routes × PAT-R |
| PAT-02 | PAT-W = member's rights. A viewer's PAT-W behaves as PAT-R | |
| PAT-03 | A PAT stops working immediately when the member leaves, is removed, or the household is disabled (membership is checked on every request, not just at issue time) | |
| SYS-01 | SYS writes are limited to its job's household (`app.household_id` is always set). Cross-household access only via `fiscus_maintenance` allow-listed jobs | |
| SYS-02 | Notifications, digests, and insights are rendered **per recipient** with the recipient's visibility. A digest never includes another member's private-account data | |
| AI-01 | The assistant's tools run with the member's RLS context. It can't read what the member can't | |
| AI-02 | AI writes produce change sets. Applying one requires the member's own permission for every contained operation (re-checked at apply time) | |
| AI-03 | If the household has AI disabled, or the member opted out, all assistant and MCP endpoints return 403 `ai_disabled` | |
| AI-04 | MCP `apply_change_set` requires PAT-W | |

## 5. Matrix: instance-admin context

The instance admin sees **metadata only**. These are the complete lists of what the admin API may return.

| ID | Resource | Admin may see / do | Admin may **never** see |
|---|---|---|---|
| ADM-01 | Users | Email, created, last login, MFA enabled (y/n), OIDC linked (y/n), disabled flag, household memberships (household name + role) | Password hashes, TOTP secrets, sessions' tokens |
| ADM-02 | Users: actions | Disable/enable, force logout, reset MFA, send password reset. Each is audit-logged and visible to affected households | Impersonation ("log in as") **does not exist, with or without consent** (decided in #3 review) |
| ADM-03 | Households | Name, created, status, member count, member emails + roles, account **count**, connections with **institution name**, status (`ok`/`login_required`/`error`), Plaid item ID and error code, storage bytes, last activity date | Account names, balances, transactions, categories, notes, rules, receipts, goals, budgets, plans, AI conversations |
| ADM-04 | Households: actions | Create (with first owner invite), disable, schedule deletion (same 7-day grace and notification as HH-07), disable Plaid or AI for a household, **grant ownership** (only if the instance setting *admin ownership recovery* is on, default off; reason required, all members notified) | Editing any household data |
| ADM-05 | Instance settings | Signup mode, providers (Plaid instance keys, LLM providers, FX/price providers, SMTP), webhook URL + health, polling intervals, usage caps | Household Plaid secrets |
| ADM-06 | Audit | Instance-level events and admin actions | Household-internal events (those belong to HH-11) |
| ADM-07 | Usage | AI token usage and Plaid item counts per household | Prompt or response content |
| ADM-08 | Server invites | Email, inviter, created and expiry dates, whether used or cancelled. Creating one gives a single-use link for that email, valid 7 days, that makes an account even when signup is invite-only (not when closed); the new person then creates their own household | The token (only its hash is stored) |

## 6. Edge cases

| ID | Situation | Required behaviour |
|---|---|---|
| EDGE-01 | Member leaves | Sessions and PATs for that household are revoked immediately. They lose all account access (it's computed from active membership). Their private notes on household transactions are **included in their personal export, then deleted**. Attribution rows stay for history. Settlement balances are finalized (M3) |
| EDGE-02 | Joint account where one owner left | The leaver's ownership share passes to the remaining co-owners **at departure** (ADR 0012), and the leaver keeps a read-only snapshot in their own household. If the leaver had linked the bank connection, it goes with them, and the remaining owners re-link to keep syncing. No consent from the leaver is needed after they've left |
| EDGE-03 | Solely owned account of a leaver | Moves **at departure** to the leaver's personal household (created if needed), with its bank connection. Nothing is orphaned in the old household |
| EDGE-04 | PAT of a removed member | 401 on next use (PAT-03) |
| EDGE-05 | Viewer and private accounts | Same as any non-owner: invisible. Viewers can never be owners |
| EDGE-06 | Last owner leaves or is demoted | Rejected with 409 `last_owner` |
| EDGE-07 | Instance admin is also a member | Household actions are checked as the member. Admin endpoints are checked as admin. Neither grants the other |
| EDGE-08 | Visibility tightened while a partner has it open | The next request returns 404. Caches keyed per member are invalidated by the access-table trigger |
| EDGE-09 | Attribution to a member who has left | Attribution history is kept in the old household. The final settle-up is recorded in both households at departure |
| EDGE-10 | Rule created by someone who later lost access to an account | RULE-05 is evaluated at run time, so the rule stops affecting that account |
| EDGE-11 | Two-member household tries to make a joint account private | 422 `private_joint_disallowed` (F2) |
| EDGE-13 | A member is absent or unresponsive | Owners can remove them (HH-04); their departure package is delivered automatically. Consent requests to them expire after 14 days, and departure protection mode lasts at most 90 days |
| EDGE-12 | Member without login (future, #223) | Can be an owner or be attributed. Can't authenticate, so no sessions or PATs. Their accounts are managed by **designated guardians** (`member_guardians`): one or more login members chosen explicitly. Guardians act with owner rights on the dependent's accounts. Other members, including household OWN, get no override. Guardian changes are audit-logged and visible to the household |

## 7. Test plan mapping

- **Matrix tests** (`apps/api/src/permissions.test.ts`): one test per built (row, actor) cell, named
  `[ROW/ACTOR]`, checking both the allowed and the refused side.
- **Coverage check** (`apps/api/src/permissions-coverage.test.ts`): reads this document and fails
  if a built rule has an actor without a tagged test. Rules not built yet are listed there with
  where they land, and listing a rule that's already tested fails too.

- **Cross-tenant suite** (ADR 0005): every household-scoped endpoint is called with a valid
  session for household A against resource IDs from household B, and must return 404. This is
  generated from the route table, so new routes are covered automatically.
- **Cross-member suite** (ADR 0006): a seeded fixture household with members A (owner), B
  (member), V (viewer) and accounts in every (owner × visibility) combination, including a joint
  account and an attribution-only transaction. Each `<row-id>/<actor>` cell above becomes a test
  asserting the expected status code **and** that the response body contains no forbidden fields
  (`account_id` under F1, private notes, account numbers).
- **Admin suite**: the ADM rows are asserted by schema. Admin response schemas are allow-lists, and a test fails if a new field appears without being added to §5.
- **Aggregate leakage**: totals, net worth, search counts, and exports compared against a
  brute-force computation over only the rows the actor can see.
