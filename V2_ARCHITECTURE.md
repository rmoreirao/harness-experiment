# V2 Architecture

Status: planned design; the running implementation is still the MVP.
Date: 2026-11-14.

## Design and Ownership

Implement `V2_PRODUCT.md` using **Copilot SDK as the single execution runtime**. The design decision is recorded in `docs\decisions\agent-runtime.md`. Initial compatibility checks belong to implementation, not a separate approval phase.

Retain the TypeScript/Node.js application and Ink interface. Selectively replace the OpenAI-specific controller, history adapter, checkpoints, and context/model wrappers. Do not retain two active model/tool loops or combine Copilot and LangGraph orchestration by default.

| Layer | Canonical owner | Responsibility |
|---|---|---|
| Terminal experience | Application | Input, streaming, plan/action display, approvals, clarification, inspection, and stop/resume commands. |
| Objective and evidence | Application | User goal, scope, steps/dependencies, expected results, blockers, source/claim links, artifacts, and verification outcomes. |
| Model/tool execution | Copilot runtime | The agent loop, selected model integration, enabled runtime tools, and runtime planning mechanisms. |
| Conversation and compaction | Copilot runtime | Model-facing memory, context compaction, native execution state, and runtime journal/resume. |
| Permissions and capability policy | Application, enforced through adapters/runtime hooks | Admission of exact tool actions, scope/preconditions, grants, trust decisions, and result publication. |
| Command/browser isolation | Dedicated execution providers | Enforced process/filesystem/network boundaries; not a system prompt or approval dialog. |
| Application persistence | SQLite | Product session/runtime mapping, plans, decisions, action ledger, evidence, artifacts, budgets, and audit records. |
| Runtime persistence | Copilot runtime in an application-isolated configuration namespace | Its canonical conversation/execution journal. The application does not rewrite it as a second history owner. |

Use the SDK's planning and stop/verification extension points first. Product task tracking records the user's contract and evidence; it does not recreate the internal agent loop.

## Process Topology

One Windows Terminal/PowerShell client owns one active product session and one SDK client/runtime lifecycle. The normal supported SDK setup uses an owned runtime child process over JSON-RPC. Use the stable transport offered by the pinned release; the experimental in-process runtime is not required.

Independent terminals may own different sessions. No centralized daemon or hosted control plane is needed. Acquire an OS-backed lock before creating/resuming executable session state and hold it until owned work has stopped.

The application may supervise isolated execution workers and a browser. Those are capabilities of the session, not additional agent sessions. No default subagent fleet is enabled.

Use a private V2 runtime configuration directory rather than the user's ambient Copilot configuration. Restore explicit tools, policy, hooks, and provider selection on every cold resume. Disable ambient repository/user hook discovery and unreviewed plugins.

## Application Components

| Component | Contract |
|---|---|
| CLI/configuration | Load `.env` and versioned product configuration, validate workspace/model/capabilities, and resolve credentials without serializing them into task state. |
| Objective controller | Admit one top-level objective, including during preparation; coordinate planning, decisions, cancellation, recovery, and completion checks. |
| Copilot adapter | Create/resume/abort/disconnect runtime sessions; map SDK events and callbacks to application contracts; supervise the owned runtime. |
| Policy and action broker | Normalize first-party/custom/MCP actions, authorize scope, journal intent, bind approvals, enforce limits, and record outcomes. |
| Workspace adapter | Provide bounded discovery/reads, exact patches, stale-content protection, and controlled publication of changes. |
| Execution provider | Run approved processes in an isolated workspace with scrubbed environment, controlled egress, deadlines, output limits, and termination. |
| Research service | Search/fetch/extract, register sources and evidence, manage citations, and retrieve results by bounded page/range. |
| Browser adapter | Operate a dedicated browser context through Playwright or a controlled equivalent and apply navigation/submission/download policy. |
| Result and verification service | Register immutable artifacts/results, validate domain outcomes, and distinguish verified completion from partial or blocked work. |
| Storage and observability | Persist product state, source/action ledgers, usage and redacted events; serve the TUI and headless API. |

Prefer suitable runtime tools when their exact resource, permission, and evidence contracts can be enforced. Otherwise expose controlled application tools and disable the overlapping runtime capability. Tool names can vary by model; policy is based on normalized capability and verified arguments, not name matching alone.

## Runtime Adapter Contract

Expose application operations for create/open, inspect, submit, decide, answer, cancel, resume, inspect results, reconcile, and close. Model-independent events cover objective/step status, text, tool intent/outcome, permission requests, questions, usage, artifacts, sources, errors, and recovery.

Use stable product session, objective, step, action, request, and artifact identifiers. Store the mapped runtime session ID and SDK/runtime versions. Enforce uniqueness so two product IDs cannot accidentally own the same runtime session.

Keep SDK types inside the adapter. An SDK session becoming idle means execution stopped; the application must still evaluate output, tests, source support, and unresolved actions before reporting the objective completed.

## Planning and Verification

For each objective record:

- The original user goal, authorized scope, expected outcome, and acceptance criteria.
- Steps with dependencies, state, inputs, output/result references, blockers, and verification evidence.
- The runtime plan reference/revision and the product evidence associated with it.
- Replan/retry counters, resource usage, pending decisions, and completion rationale.

Map runtime plan changes to product steps rather than maintaining an independent competing plan. Use ordinary TypeScript composition for deterministic checks. No graph framework is required.

Completion validators must be domain-aware: test/exit results and diff review for coding; retrieved support and citation resolution for research; observed page state for browser tasks. If a stop hook requests more work, it remains bounded by the same objective budget.

## Tool Policy and Approval

All action paths follow **normalize -> validate -> authorize -> decide if needed -> revalidate -> persist intent -> execute -> persist outcome -> verify**.

The pre-execution point must run before effects for first-party as well as custom/MCP tools. A post-tool event alone is not an execution journal. First implementation work must prove which callbacks provide this boundary in the selected runtime.

Bind decisions to runtime/product session, objective, action identity, arguments, resource scope, request revision, and relevant content/preconditions. Changed arguments, navigation targets, or stale files require a new decision.

Keep approval-first as default; a read-only restriction and a trusted-read grant are distinct settings. Grants are explicit, bounded, and revocable. Do not inherit permanent permission files from personal sessions or share them between independent sessions accidentally.

Repository instructions and retrieved content are data/context, not permission. Reviewed local skills may guide behavior but cannot authorize shell commands, enable tools, or install dependencies. Keep repository command hooks disabled unless explicitly admitted under a separate trust decision.

## Workspace and Coding Execution

General file tools operate on selected source/configuration text with paging, bounded regex/literal search, ignore/protected-path rules, and binary detection. Exact edits use expected content/version preconditions. Preserve unrelated user edits, and coordinate cooperating writers.

Git inspection uses a fixed operation contract for status/diff/log, not arbitrary model-supplied Git arguments. Disable pagers, external diff/text conversion helpers, unsafe configuration discovery, and unintended hook execution. Do not mutate the user-owned checkout's refs or working tree as a setup shortcut.

**Proposed initial execution provider: Docker Desktop-backed isolation invoked from the Windows application.** This is an implementation choice to prove, not a claim that Docker is already configured or that the SDK supplies a safe sandbox automatically. A container's Linux toolchain is not native Windows build support.

Keep unconfined runtime host-shell tools disabled. Provide an application-controlled execution capability that starts a bounded process in a filtered workspace mirror, without host home directories, credential files, personal `.git` configuration, Docker socket, privileged flags, or host networking.

Only trusted application code controls container mounts/image/startup. Model arguments describe the intended executable/arguments and working scope, not arbitrary container-engine flags. Network access is denied by default and granted through enforced egress policy when needed, such as a package registry.

Provider/search keys stay with host-side credential owners and never enter the execution environment. Treat process approval as a grant to its disclosed sandbox filesystem/network scope; it cannot preserve a fiction of separate per-file approvals inside an unrestricted process.

Record source hashes when creating the filtered mirror. Run tests/builds there, then publish only approved diffs/artifacts back through stale-content checks. Do not overwrite concurrent host edits, auto-commit, stash, or reset the user's checkout.

If a repository requires a Windows-native toolchain, report that requirement and use only a separately proved Windows isolation provider. Do not silently run it on the host. A missing isolation backend disables execution while safe read/research work remains available; required coding acceptance remains incomplete.

## Research and Browser Capabilities

Use an explicitly selected search connector. Hosted search is allowed only if the configured endpoint supports it and its billing/data-flow contracts are understood; otherwise use a separate configured provider. Do not assume Copilot CLI `/research` is an SDK API.

URL retrieval must validate schemes, resolved destinations, redirects, body/time limits, and allowed origins. Prevent unintended access to private/metadata endpoints and DNS/redirect bypasses; explicitly scoped local test sites are a separate exception. Do not forward credentials to a changed origin.

Store sources with canonical/final URL, title, retrieval time, publication time when available, content hash, extraction metadata, and result/artifact references. Store evidence spans/quotes and claim-to-source links. Distinguish search snippets, retrieved evidence, inference, and unresolved claims.

Research output checks can validate structural citation support and known fixture facts; they are not a guarantee of universal factual truth. Record conflicting or unavailable evidence. Browsing more pages is not proof of research quality.

Use a clean session-isolated browser profile, not personal cookies or logins. Enforce approved navigation destinations at the browser/network boundary, including redirects and new tabs. Re-observe page state before actions rather than blindly replaying old selectors.

External submissions, uploads, sensitive typing, and downloads need the declared action/data policy. Approved navigation does not authorize exporting workspace contents. Browser script execution and host-access features are disabled unless separately scoped and enforced.

Download to quarantined session storage; register provenance and inspect type/size before publishing to a workspace. Do not automatically execute downloaded content. Keep screenshots and browser credentials out of unrelated sessions and external telemetry.

## Persistence, Results, and Context

Use a separate V2 application database, for example under the application's `v2` data directory, to avoid incompatible writes by an older running MVP. Store product sessions/runtime mappings, objective/step records, requests/decisions, action intent/outcomes, source/claim records, artifact/result metadata, usage, and audit correlation.

Runtime journals live in a dedicated application-controlled namespace and remain the canonical conversation/execution state. A read-only UI projection/cache must not become a second source that feeds rewritten history back to the runtime.

Store complete large outputs outside prompts with immutable result IDs, hashes, size/type, owner session, provenance, and ranges/pages. Let the model and user inspect bounded portions of those results without re-executing the originating action.

Runtime compaction owns model-facing summaries. Reintroduce small authoritative objective/plan/evidence pointers through supported context mechanisms; do not copy the MVP's manual history rewriter into this backend.

## Recovery and Cancellation

Restore the same runtime identity with fresh services, provider configuration, permission handlers, and explicit capability filters. Reconcile callbacks and persisted product actions with runtime events before admitting further work.

If a pending callback cannot safely survive process restart, reconstruct a current permission request through a supported continuation or mark the objective recovery-required. Do not interpret reconnect as an approval or silently replay the action.

An action committed externally without a durable result is unknown. Use a tool-supported stable idempotency key or reconcile the actual resource; otherwise require user resolution. Neither runtime journaling nor SQLite provides exactly-once external effects.

Cancellation stops admission of new work, aborts the runtime, and terminates owned execution/browser work within documented bounds. Drain late callbacks/results or retain a recovery-required state; do not release ownership while local effects can still execute. Closing one terminal must not stop another terminal's runtime.

## BYOK, Budgets, and Privacy

Keep existing `.env` key names where practical. Map the API base, canonical model identity, deployment/wire identity, and Responses wire API explicitly. Rebuild provider configuration on resume without copying keys into application state.

Token/step/concurrency/currency policy is application policy. Runtime AI Credits soft limits and provider parallel-tool hints do not substitute for it. Include compaction and other auxiliary calls in accounting, reserve for in-flight work, document overshoot, and stop on unknown usage when enforcement cannot be established.

Use supported pre-model admission controls where they meet this contract. For strict BYOK request boundaries that the SDK cannot expose, the implementation may use an application-owned, loopback-only model broker with a short-lived session token, fixed upstream/model allowlist, concurrency/reservation checks, and host-side credentials. It must not be a public proxy or permit runtime/provider fallback around the policy.

Keep provider model traffic distinct from MCP, browser, search, and command traffic. Account for separately priced search/browser services when a currency cap is enabled; never price unknown tool charges as zero.

Redact configured secrets before local diagnostic export, sanitize terminal control sequences, and keep external telemetry disabled unless explicitly enabled. Protect local journals, evidence, and browser profiles using application/account permissions; do not claim at-rest encryption or automatic personal-data detection.

## Transition and Acceptance

Preserve the original `MVP_*` specifications and existing data. Expose old session history through a read-only legacy view; do not deserialize OpenAI `RunState` with Copilot or migrate it by copying JSON fields.

Start new objectives in V2 runtime sessions. Retain the original MVP launch path during development, and switch the default only after A01-A08 evidence is recorded. Do not ship two cooperating agent loops as a permanent migration mechanism.

Pin the published SDK, its compatible runtime artifacts, Node.js, and tool providers. Verify Windows package installation, native dependencies, runtime cleanup, credential exclusion, and historical data preservation. First implementation tasks prove integration details; concrete limitations are surfaced rather than becoming an indefinite separate approval phase.
