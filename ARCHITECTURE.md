# Architecture

The sole implementation uses **Copilot SDK as its execution runtime** with a
Windows Terminal/PowerShell React/Ink client. Product scope is in
[PRODUCT.md](PRODUCT.md); operational contracts are in the [guide](docs/GUIDE.md).
The runtime decision is recorded in [the ADR](docs/decisions/agent-runtime.md).

## Ownership and layout

| Layer | Owner | Implementation |
|---|---|---|
| Terminal/headless experience | Application | `src\cli.tsx`, `src\ui.tsx`, shared input editor |
| Configuration and public contracts | Application | `src\config.ts`, `src\contracts.ts`, root `src\index.ts` |
| Objectives, plans and completion | Application | `src\controller.ts` |
| Model/tool loop, conversation and compaction | Copilot runtime | `src\runtime.ts` adapter and owned SDK child |
| Exact approvals and action journal | Application | `src\policy.ts` |
| Usage and optional budget admission | Application | `src\resources.ts` and controlled model transport |
| Source/Git operations | Application | `src\workspace.ts` |
| Isolated execution | Docker Desktop provider | `src\execution.ts`, filtered session-owned workspace mirrors |
| Research and browser | Application-controlled providers | `src\network.ts`, `src\research.ts`, `src\browser.ts` |
| Skills and integrations | Application | `src\skills.ts`, `src\mcp.ts` |
| Product evidence, results and diagnostics | SQLite/application | `src\store.ts`, shared error/redaction/ownership utilities |

There is no second agent loop, alternate fake-model backend, application history
rewriter, graph scheduler or legacy-history reader. Synthetic model responses
are test fixtures, not a selectable product implementation.

## Process and persistence

One terminal owns one product session and one SDK client/runtime lifecycle.
Independent terminals may own different sessions. OS-backed locks prevent two
processes from executing the same session. Ownership is released only after
owned work stops; closing one terminal does not stop another session's runtime.

SQLite stores objectives, steps, decisions, action intent/outcomes, source/claim
links, immutable result metadata, model usage and redacted events. Copilot
retains its own canonical conversation and execution journal in a private
session-specific runtime configuration directory. SQLite is not a second
conversation owner.

The existing `%LOCALAPPDATA%\harness-experiment\v2` default, `product-v2.db`,
database schema version 2, configuration formats 2/3 and `v2-session:` lock
identities are preserved for saved-session compatibility. Persisted resource
names and extraction-version markers are also retained where meaningful.
No database relocation, renumbering or conversion accompanies promotion.
Original MVP databases and private local configuration are not modified.

Resume checks stored configuration integrity and pinned SDK/runtime versions.
It restores the same runtime identity with fresh services, provider settings,
capability filters and callbacks. Interrupted requests require reconciliation
and fresh decisions; reconnecting is not approval.

## Runtime and model boundary

The pinned SDK owns planning mechanisms, execution and compaction. Application
records retain the original goal, steps, evidence and verified completion state.
Idle alone is not success. Stop validation waits for background compaction
summarization to settle, without waiting indefinitely for summary application,
which the SDK may perform on a later turn.

The application-owned request handler fixes the explicit BYOK endpoint,
canonical/wire model identities and Responses HTTP/SSE transport. Keys stay in
host adapters; the runtime receives a noncredential placeholder and scrubbed
environment. WebSocket model traffic, provider fallback, ambient configuration,
native tools, plugins, extensions and subagents are disabled.

Configuration format 3 omits prompt/output overrides and cumulative spending
budgets by default. Deliberate overrides and token/currency policies remain
supported. Historical format-2 defaults remain frozen. Model metadata is labeled
runtime-reported/explicit/unavailable, never assumed provider-verified capacity.
Auxiliary requests are included in usage. Explicit budgets fail admission if
a finite output bound or separately charged tool price cannot be established.

## Capability and permission boundary

Actions follow **validate -> authorize -> decide -> revalidate -> persist intent
-> execute -> persist outcome -> verify**. Decisions bind the session, objective,
tool, arguments, request revision and relevant file/page preconditions. Changed
arguments, stale content and restored requests require fresh decisions.

Approval-first remains the default. Read-only restriction is not a read grant.
Trusted reads are explicitly scoped, bounded and revocable. `/approve_all`
changes session tool approval but cannot enable disabled providers, escape
path/network policy or settle unknown effects. Questions still require answers.

Source operations reject protected paths, links, binaries and generated trees.
Git inspection uses fixed arguments with unsafe helpers/configuration disabled.
Execution uses a preinstalled immutable Linux image, a filtered writable mirror,
nonroot identity, no network/host secrets/engine socket, and bounded resources.
Publication rechecks host baselines and requires separate approval. No host
shell, automatic Git mutation or image download is a fallback.

Network retrieval validates public destinations and DNS, pins admitted
addresses, limits bodies/redirects and requires separate cross-origin approval.
Explicit loopback fixture scopes remain distinct. Research stores exact quotes
and claim/source/result links; structural verification is not universal truth.
The browser uses a clean reviewed Chromium instance, protected transport and
fresh observations. JavaScript, personal profiles and uploads stay disabled.

Workspace skill Markdown is loaded into an application-owned snapshot and
retrieved through controlled tools. It cannot grant permissions or execute hooks.
Explicitly trusted no-auth HTTP MCP calls use the same broker and network policy.

## Recovery, privacy and limitations

Unknown external effects or unresolved model work block further admission until
explicit reconciliation. Neither SQLite nor runtime journaling establishes
exactly-once effects. Cancellation does not undo completed actions.

Provider/search secrets are redacted from diagnostics and terminal controls are
sanitized. Telemetry is disabled and checked at startup. Local storage relies on
account/filesystem permissions, not at-rest encryption or automatic sensitive
document detection.

Native Windows execution isolation/egress, browser SPAs/authentication/uploads,
exhaustive failure injection and physical clipboard/font acceptance remain
outside current evidence. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
for the acceptance map; a sole runtime is not proof of complete release readiness.
