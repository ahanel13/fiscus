# ADR 0009: AI assistant (in-app chat) and MCP server on one shared tool layer

- Status: Accepted
- Date: 2026-10-01
- Builds on: ADR 0004 (`LlmProvider`), ADR 0005 (trust/encryption), ADR 0006 (visibility & lens)

## Context
We want an optional AI assistant that can answer questions about your finances *and act*:
create and test rules, recategorize or split transactions, adjust budgets, explain spending.
It must work with a frontier model (e.g. Claude) or a locally hosted one (Ollama,
llama.cpp, vLLM), and be disable-able. External AI clients should get the same capabilities over MCP.

## Decision

### 1. One tool layer, two front doors
- A `packages/tools` registry defines every capability once: name, description, zod input/output
  schemas, required permission scope, `read` or `write` kind, and a handler that calls domain
  services.
- **MCP server** (`apps/mcp`): exposes the registry to external clients such as Claude Desktop
  or Claude Code, authenticated by a member-bound PAT.
- **In-app assistant** (`api` module + web chat panel): runs the agent loop server-side through
  `LlmProvider` with the same registry, authenticated by the member's session.
- Both execute tools **as the member**, so ADR 0006 visibility and lens rules apply automatically.
  The AI can never see more than the person using it.

### 2. Enable/disable and model choice, in layers
| Level | Who | Controls |
|-------|-----|----------|
| Instance | Admin | Which providers exist (Anthropic key, OpenAI-compatible base URL for Ollama etc.), assistant on/off globally, default model, usage caps |
| Household | Owner | Assistant on/off, which allowed provider/model, whether **write** tools are allowed, data-sharing disclosure acknowledged |
| Member | Each member | Opt out personally, view/delete own conversation history |

Local models must support tool calling, e.g. Qwen 2.5/3 or Llama 3.1+ instruct. The admin UI
runs a capability check (tool-call round trip) before a model can be selected.

### 3. Writes go through change sets
Write tools never mutate data directly. They produce a **change set**: a structured, previewable
diff such as "Recategorize 23 transactions Shopping → Household" or "Create rule: merchant
contains 'COSTCO' → split by receipt".
- The UI renders the diff (counts, sample rows, before → after). The member clicks **Apply**,
  edits it, or rejects it.
- Rules get a **dry run** first: "this rule would have matched 41 past transactions", with the list.
- An applied change set is **one atomic batch** with **one-click undo**, logged in the audit log
  as `via: assistant` with the conversation reference.
- An optional per-household "auto-apply low-risk changes" setting (e.g. a single-transaction
  recategorize) exists, but defaults to off.
- MCP write tools use the same mechanism: the external client gets a change-set ID and must
  call `apply_change_set`, which requires the `write` PAT scope.

### 4. Initial tool set
- **Read:**
  - search/aggregate transactions;
  - accounts and balances;
  - budgets vs actual;
  - bills and upcoming;
  - goals;
  - net worth history;
  - cash-flow / spending reports;
  - settle-up balances;
  - receipts.
- **Write (via change set):**
  - recategorize, rename merchant, tag, note, split, and set attribution on transactions;
  - create, edit, and test rules;
  - adjust budget allocations;
  - create goals or bills;
  - confirm or dismiss recurring series;
  - match receipts.
- **Insight prompts:** monthly review, "where did my money go", anomaly / subscription audit,
  "why am I over budget", rule suggestions from uncategorized or recently corrected transactions.

### 5. Safety and privacy
- **Prompt injection:** merchant names, memos, receipt text, and imported files are untrusted
  data and reach the model inside tool results. Because every write needs explicit human
  approval of a visible diff, and no tool sends anything off-server (no email/webhook tools),
  an injected instruction can at worst propose a change that the member sees and rejects.
  A test suite of adversarial merchant names and receipts guards this.
- **Data minimization:** tools return only the fields needed, and search results are paginated
  and capped. Account numbers and encrypted fields are never returned.
- **Disclosure:** using a cloud model sends the relevant financial data to that provider. The
  household setting requires acknowledging this, and the chat panel shows which model is
  active (cloud or local).
- **Storage:** conversations are stored per member, encrypted with the household key, with a
  retention setting (default 90 days). They are visible only to their member.
- **Cost controls:** per-household token budgets, usage logged per call, and soft and hard limits set by the admin.

## Consequences
- Every feature that wants AI access adds a tool to the registry once, and both the assistant and MCP get it.
- Write UX is slower than "just do it" but safe and reversible. This is the right default for financial data.
- Local models will be noticeably weaker at multi-step tool use. The capability check and the
  change-set review limit the damage. Quality is the household's trade-off to make.
