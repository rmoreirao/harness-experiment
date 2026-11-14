# MVP Architecture

## Purpose and Scope

Implement the scope in `MVP_PRODUCT.md` as a local, modular TypeScript application with an interactive terminal UI.

The central architectural decision is:

**One reusable Runner per terminal process, one stable Agent definition initially, one exclusively owned durable application session, and one active logical top-level run per session.**

OpenAI Agents SDK owns the model/tool loop. The application owns the terminal experience, durable identity, session ownership, execution policy, resource controls, and safe recovery.

This document records the proposed implementation architecture. It does not expand the MVP product scope or imply that the application has been implemented.

## Technology Decisions

| Area | Decision | Rationale |
|---|---|---|
| Language and runtime | TypeScript, Node.js LTS, ESM | Typed application contracts and access to the model, agent, and MCP ecosystems. Pin a supported runtime baseline when implementation starts. |
| Terminal UI | React and Ink, subject to the suitability gate below | Component-based terminal rendering, kept independent of execution and storage. |
| Agent runtime | `@openai/agents` | Reuse the SDK's execution loop, streaming, tool integration, approval interruptions, and supported resume mechanisms. |
| Model access | SDK OpenAI Responses provider initially; configurable model | One provider implementation behind the SDK adapter. No additional model gateway or agent framework. |
| Persistence | SQLite through `better-sqlite3`, SQL migrations, WAL mode | Local transactional storage shared by independent terminal instances, without a database service. |
| Validation | Zod for application contracts; JSON Schema validation for discovered tool arguments | Validate configuration, commands, results, and tools at runtime as well as at compile time. |
| Internal communication | Typed commands and async events in-process | Decouple Ink from the runtime without introducing IPC or a message broker. |
| Session ownership | OS-backed exclusive lock per session, with SQLite ownership metadata | Enforce a single owning process independently of database transaction locks. |
| MCP | Client-side stdio and Streamable HTTP | Keep invocation admission, policy, approvals, and journaling under application control. |
| Distribution | One npm-distributed CLI package initially | Avoid service installation and keep application modules in one deployable unit. |

Pin dependencies and commit the package lockfile during implementation. SDK upgrades require checkpoint compatibility checks; saved execution state must not depend on an unrecorded SDK version.

## Process and Deployment Model

- Each terminal starts one foreground application process and owns one session.
- Multiple processes may run different sessions concurrently against the same local SQLite database.
- No central daemon, hosted API, distributed worker, or background scheduler is required.
- Tool subprocesses, including configured stdio MCP servers, are subordinate resources, not additional agent sessions.
- Closing the application does not promise continued execution. Clean shutdown cancels foreground work, persists recoverable state, and releases ownership.
- Session identity survives restarts; Runner, Agent, database connection, and UI instances do not.

The database, lock files, and session-managed output files belong in an application data directory on local disk, outside the user's working directory. Credentials must not be stored in that directory as part of session snapshots.

## Runtime Objects and Lifetimes

| Object | Role | Lifetime |
|---|---|---|
| `@openai/agents` | Installed library providing execution primitives and provider integration. It is not a daemon or a model. | Dependency version |
| `Runner` | Configured executor for the SDK model/tool loop, provider settings, and tracing behavior. | Reused for the terminal process |
| `Agent` | Stable instructions, model configuration, tool set, guardrails, and output contract. It is not conversation memory or a worker process. | Recreated from compatible configuration at startup |
| Model | Provider-backed inference implementation and configured model identity. | Used for individual model requests |
| Application session | Durable conversation identity, workspace, configuration revision, history, task state, approvals, artifacts, and execution records. | Across terminal processes |
| SDK `Session` | SQLite-backed conversation-history adapter passed to SDK execution. | Bound to an application session ID |
| Logical run | Execution of a user request, including approval or clarification continuations. | Until completion, failure, cancellation, or explicit interruption recovery |
| `RunState` | SDK execution snapshot at a supported resumable boundary. Not a complete process snapshot. | Persisted as needed, subject to compatibility |

A paused logical run may require multiple `runner.run(...)` calls. An approval pause does not permit a second independent top-level run in the same session.

Reusing a Runner does not retain history, reduce context usage, enforce session ownership, or serialize execution by itself. A new Runner with the same durable Session adapter can load persisted history; a reused Runner without that adapter does not automatically remember earlier requests.

One Agent can use many tools and handle many sequential requests. Additional Agents are not needed for each task or tool. Future specialist Agents could share a Runner; additional Runners are justified only by genuinely different execution configuration or lifecycle requirements.

## Application Modules

These are module boundaries inside one application, not independently deployed services.

| Module | Responsibility |
|---|---|
| CLI bootstrap | Parse startup arguments, validate configuration, resolve credentials, open storage, and acquire session ownership. |
| Terminal UI | Prompt editing, transcript, progress, approvals, clarification, status, result presentation, and cancellation controls. No direct SQL or tool execution. |
| Session controller | Headless application API; session/run state machine; coordination of submission, approval, clarification, cancellation, recovery, and shutdown. |
| Agents SDK adapter | Create the Agent and Runner, configure the provider, invoke or resume SDK execution, translate events, and serialize supported checkpoints. |
| Tool gateway | Common validation, authorization, approval integration, execution journaling, timeout, cancellation, and result handling for built-in and client-side MCP tools. |
| Context and resource services | Prepare model context, preserve task state, compact history, account for usage, and enforce admission and execution limits. |
| Persistence | SQLite repositories, SDK Session adapter, history transactions, migrations, checkpoints, and references to session-managed files. |
| Process supervisor | Own the lifecycle of launched tool/MCP subprocesses and perform bounded shutdown and supported process-tree cleanup. |
| Observability and evaluation | Redacted local diagnostics, correlated traces, lifecycle hooks, validators, and regression execution through the headless API. |

The dependency direction is **CLI/UI -> session controller -> SDK adapter and application services -> storage and external integrations**. SDK-specific types stay behind the adapter where practical.

Basic sequential and conditional workflows use TypeScript composition around the SDK's execution primitives. Parallel steps and function tools are bounded; there is no second custom model/tool loop, workflow platform, subagent system, or handoff topology.

## Commands, Events, and State

The controller exposes a documented local programmatic API for creating, listing, inspecting, opening/resuming, submitting to, and closing sessions, plus approving, rejecting, answering questions, and cancelling runs.

Commands carry explicit session, run, and request identifiers where applicable. Approval and clarification responses must target a current request revision; stale decisions fail without executing work.

The UI consumes typed application events for run state, text deltas, tool activity, approval requests, clarification requests, usage, artifacts, and errors. It does not interpret raw SDK payloads to decide execution policy.

Separate durable lifecycle events from transient display updates:

- Persist critical transitions, tool intent, and decisions before acknowledging them or performing the corresponding side effect.
- Batch streamed text updates for the transcript rather than writing one synchronous transaction per token. Mark incomplete output as partial after interruption.
- Keep database state changes and their associated durable events in the same transaction.
- Reconstruct the UI from persisted state and transcript on resume; do not require replaying every SDK event.

Session state describes ownership and availability, such as open/idle, busy, awaiting approval, awaiting input, or requiring recovery. Run state records running, awaiting approval, awaiting input, completed, failed, cancelled, or interrupted. Returning to idle must not erase the last run's outcome.

## Persistence Design

### Storage responsibilities

| Record group | Stored information |
|---|---|
| Sessions and configuration revisions | Session ID, workspace identity and writable scope, configuration/schema revision, timestamps, and owner diagnostics. Secrets are referenced, not copied. |
| Conversation history | Ordered SDK input/output items and atomic history-operation identifiers. |
| Runs and checkpoints | Logical run ID, status, timing, configuration identity, checkpoint revision, serialized SDK state, and SDK version. |
| Tool executions | Stable invocation identity, tool/server identity, validated arguments, approval binding, dispatch state, outcome, and uncertainty. |
| Approvals and questions | Exact proposed action or question, request revision, status, and user decision/answer. |
| Tasks and artifacts | Structured progress, completion-validator outcomes, file references, content metadata, and originating run. |
| Transcript, events, and usage | User-visible conversation, ordered lifecycle records, model/tool usage, budget accounting, and trace correlation. |

The working context and user-visible transcript are distinct. Compaction may reduce the model's working history without deleting the original transcript, task state, or execution records.

Large tool outputs and generated files use session-managed storage with SQLite references. Publish file references only after successful file creation; incomplete or missing files must produce explicit errors rather than apparently valid artifacts.

### SQLite operation

- Use WAL, foreign keys, short transactions, and a durability setting appropriate to committed action intent and approvals; start with `synchronous=FULL`.
- Use bounded busy handling and report persistent contention or disk failures explicitly.
- Never hold a transaction while awaiting a model, tool, or human response.
- Avoid long synchronous queries on the UI event loop. Keep reads bounded and batch writes.
- Keep the database on local disk; do not support network-filesystem WAL storage.
- Apply versioned migrations safely under concurrent startup. Reject unsupported newer schemas rather than guessing how to read them.

SQLite still permits only one writer at a time. WAL improves reader/writer concurrency; it does not enforce ownership of an application session.

### SDK Session adapter

Implement the SDK `Session` interface over SQLite: `getSessionId`, `getItems`, `addItems`, `popItem`, and `clearSession`. Internal adapter methods do not imply user-facing rewind or session-clear features.

Use the transaction-aware history contract supported by the pinned SDK version to commit a stable operation ID and history mutation atomically. Duplicate identical operations must not append twice; conflicting reuse must fail.

The adapter is the canonical model-history write path. Transcript and journal recording must not independently append duplicate SDK conversation items.

SDK Session persistence is not the execution journal: streaming input is saved before the run, while generated outputs are persisted on completion. Additional application checkpoints and tool records are required for interruption recovery.

## Session Ownership and Shared Workspaces

Acquire an exclusive OS-backed lock on a stable per-session lock file before opening a session for execution. Hold the handle for the entire ownership lifetime and do not inherit it into tool subprocesses. Do not delete and recreate the lock file while it may be held.

An already-owned session must be rejected clearly. Lock acquisition errors must be distinguished from an active owner. Do not implement ownership through a heartbeat expiry or PID file alone.

The operating system releases the lock after process death. SQLite owner metadata and heartbeat information are diagnostic; stale metadata must not prevent recovery after successfully acquiring the lock. A lost ownership handle is fatal to further execution.

Track active workspace scopes for overlap warnings. Canonicalize paths with Windows case behavior, symlinks, and junctions in mind. Separate session locks do not protect a shared working directory.

Built-in file writers must use expected-content/version checks and coordinate conflicting writes between application instances. Recheck preconditions after approval. Changes invalidate the pending action rather than silently changing what was approved.

These controls detect stale edits and coordinate cooperating processes; they are not a guarantee against every race with arbitrary external editors or a replacement for OS-level isolation.

## Execution and Approval Flow

1. Validate configuration, acquire ownership, and load persisted state. Inspect recovery conditions before admitting new execution.
2. Record the user request and logical run identity without duplicating SDK history persistence.
3. Invoke the Runner with streaming, the SQLite Session adapter, deliberately scoped context, bounded execution settings, and a run-level `AbortSignal`.
4. Translate SDK events into application events and persisted transcript/lifecycle records.
5. Route tool calls through the common tool gateway.
6. When the SDK pauses for approval, await SDK completion and persist the compatible `RunState` and exact pending requests before accepting decisions.
7. Persist the user's decision, revalidate policy and action preconditions, apply the decision to the restored/current state, and resume the original Agent with the same backing Session.
8. Await full SDK completion, including persistence and post-processing. Apply completion validators, save the outcome and artifact references, and return the session to idle.

Use per-call approvals initially, bound to tool/server identity, arguments, scope, and request revision. Do not introduce permanent or run-wide sticky grants implicitly. If the proposed action changes, require a new approval.

Clarification is a separate application question/answer mechanism. Implement a controlled tool/controller interaction that can wait for an answer and persist the pending question; do not treat boolean tool approvals as a complete clarification system.

Runner/Agent context must not contain credentials or live database connections that would be serialized into `RunState`. Rebuild process-local services after restart and inject fresh context through supported SDK restoration mechanisms.

## Tool Gateway and Security

All application-controlled tools follow the same execution contract:

**Validate -> authorize -> obtain approval when needed -> revalidate -> persist dispatch intent -> execute -> persist outcome.**

Tool identity includes the configured server identity for MCP tools. Validate arguments and limits locally; model output and MCP tool annotations do not confer permission.

The initial built-in tool set supports scoped file reading/searching and approval-gated file writing, sufficient to read documents and create a reviewable summary. Restrict paths to the configured scope, handle symlink/junction escapes deliberately, limit output sizes, and exclude internal application state and credential locations.

Use SDK client-side MCP support or application-controlled MCP adapters that preserve the gateway contract. Merely attaching `mcpServers` does not implement application authorization or journaling. Avoid provider-hosted MCP execution for the initial shared local pipeline because it has a different execution and approval boundary.

Connect only explicitly configured servers. Launching a stdio server runs installed software with OS privileges: require explicit trust/configuration, minimize inherited environment, and supervise its lifecycle. It is not automatically sandboxed. MCP tools exposing arbitrary code/shell execution remain disabled until an isolation design satisfies the product requirements.

Do not enable arbitrary shell, code execution, or computer use in the initial tool set. If introduced later, filesystem, process, and network isolation must be enforced outside the model. Prompt instructions, path settings, and approval dialogs are not sandboxes.

Treat tool output, retrieved content, and imported files as untrusted data. Sanitize terminal control sequences and redact sensitive fields before display or diagnostic export.

## Recovery and Cancellation

### Recovery rules

| Interrupted situation | Required behavior |
|---|---|
| Waiting for approval | Restore a compatible checkpoint and show the pending request. Apply current policy and preconditions before executing an approved action. |
| Waiting for clarification | Restore the saved question and supported continuation, or explain why explicit recovery is required. Do not silently discard the question. |
| Model generation | Preserve partial output and the last safe boundary. Do not promise exact continuation of an interrupted provider request. |
| Read-only tool | Retry only according to its declared safe retry policy and bounded backoff. |
| Side-effecting tool dispatched without a durable outcome | Mark the outcome unknown. Reconcile external state or use a tool-supported stable idempotency key; otherwise require user resolution. |
| Completed tool with persisted result | Reuse the recorded result when safely reconciling the same invocation; do not dispatch it again merely to rebuild execution state. |
| Incompatible SDK checkpoint or Agent/tool definitions | Keep history readable, reject unsafe continuation, and explain the recovery options. Do not deserialize against guessed definitions. |

Persist tool intent before dispatch and outcome afterward. SQLite cannot atomically commit an external action with its local outcome record. Neither the SDK Session adapter nor serialized `RunState` guarantees exactly-once external effects.

An arbitrary process kill is not necessarily a supported SDK checkpoint. If an exact continuation cannot be established, mark the run interrupted and require a safe, explicit continuation from reconciled history. Block further conflicting side effects until unresolved actions are addressed.

Deserialize only application-owned saved state under appropriate local file permissions. Deserialization is not authentication or authorization. Check SDK version, configuration revision, and Agent/tool compatibility before restoring execution.

### Cancellation and shutdown

Use a run-level cancellation controller for model requests and cooperative tools. Enforce per-tool timeouts and supervise subprocess cleanup using supported platform mechanisms, including Windows process-tree behavior.

Cancellation prevents new work and requests active work to stop; it does not undo completed actions. If a timeout or cancellation leaves external work unresolved, preserve its unknown status.

Do not label a run cancelled and immediately admit another while uncontained local side effects can still execute. Complete supported cleanup or surface a blocked recovery state. Persist state and flush diagnostics before releasing session ownership on clean shutdown.

## Context, Resources, and Results

- Prepare model input through the SDK's `callModelInputFilter` on every model request, not only between user turns. Preserve authoritative instructions, the latest user request, task state, pending requests, and complete tool call/result batches when compacting.
- Trigger compaction before the configured model context limit, reserving room for output and tool definitions. Store summaries as model working context, not as replacements for the transcript.
- Use SDK turn limits and function-tool concurrency settings, supplemented by application token, deadline, and spending checks.
- Maintain budgets across approval/resume invocations of the same logical run; do not reset them on each `runner.run(...)` call or restart.
- Use the smaller of the remaining token budget and context window for active compaction. Conservative UTF-8/JSON reservations can stop a small-budget run before its reported token total reaches the cap; do not weaken that limit to force a successful result.
- Use conservative admission/reservation for in-flight work, reconcile actual usage when available, and document overshoot and unknown-usage cases. Stop rather than silently bypassing an unpriceable configured currency budget.
- Retry only classified transient failures with bounded backoff, coordinating SDK/provider retries to avoid multiplying attempts. Never retry an uncertain side effect automatically.
- Validate structured outputs and application completion criteria. Distinguish completed, partial, and failed results without unbounded automatic repair loops.

## Terminal Experience

Ink renders a keyboard-first prompt, readable conversation/tool transcript, status area, and focused approval/clarification interactions. One terminal shows one session; there are no tabs or session-switching panels.

Support multiline editing, paste without accidental submission, input recall, streaming, scrolling/copying, basic code formatting, resize/redraw, output inspection, and clear interrupt/exit behavior. Provide `/help`, `/status`, and `/exit`, plus CLI commands for listing and resuming saved sessions.

Show session identity, workspace and writable scope, model, permission policy, current action, context/token usage, stop reasons, and output paths. Large tool results remain inspectable beyond their bounded inline preview.

**Ink suitability gate:** verify these behaviors with a fake streaming provider before committing substantial UI work. Include Windows Terminal with PowerShell in the first compatibility exercise and document the supported platform/terminal matrix. If Ink cannot satisfy the MVP, replace the UI adapter without changing controller, persistence, or execution contracts.

## Observability and Verification

Persist redacted local lifecycle/diagnostic records correlated by session, run, and tool invocation. Provide a tracing boundary compatible with OpenTelemetry conventions without requiring an external dashboard.

The SDK's Node.js default exports traces to OpenAI. Replace the default processors with local redacted processing; adding another processor alone does not disable that export. External trace export must be explicitly configured. Traces are not the recovery journal.

Expose documented lifecycle hooks without permitting them to bypass policy, ownership, or durable execution boundaries. Hook failures must be surfaced explicitly.

Use the same headless controller API for regression evaluations. Cover normal tool-backed tasks and the release gates in `MVP_PRODUCT.md`, including independent terminal processes, duplicate ownership, approval/restart, interrupted side effects, stale writes, cancellation, compaction, resource limits, and output validation.

Use deterministic fake model/tool implementations for failure injection, real SQLite for persistence/concurrency exercises, and focused live-provider integration checks. Keep pinned SDK checkpoint round-trip tests as an upgrade gate.

## Requirement Mapping

| Product requirements | Primary architectural responsibility |
|---|---|
| R01 | CLI configuration, Agent definition, SDK/provider adapter |
| R02, R06 | Session controller, SDK Runner, constrained TypeScript composition |
| R03, R09 | Tool gateway, validation, MCP adapters, scoped tools |
| R04, R07 | SQLite Session adapter, ownership locks, execution journal, checkpoints and reconciliation |
| R05 | Context service, working-history compaction, independent task state/transcript |
| R08 | SDK interruptions, durable approvals/questions, controller and UI |
| R10 | Resource service, admission checks, SDK limits and process supervision |
| R11 | Artifact records, result contracts and completion validators |
| R12, R13 | Typed headless API, hooks, versioned configuration, local tracing and regression evaluation |
| T01, T08 | CLI, session discovery, persistence and recovery |
| T02, T03, T12 | Ink input/rendering adapter and terminal suitability gate |
| T04, T05, T09, T10, T11 | Application events, status/transcript projections, usage and artifact presentation |
| T06, T07 | Approval/question interactions, cancellation and shutdown coordination |

## Remaining Implementation Decisions

The architecture is fixed at the component level; the following choices require implementation evidence rather than additional product scope:

- Exact supported Node.js, SDK, Ink, and SQLite driver versions.
- OS-backed locking implementation and native dependency packaging on supported platforms.
- Terminal compatibility matrix and Ink suitability.
- Exact SQL schema, migration layout, checkpoint serialization envelope, and typed API definitions.
- Initial model, configuration format, MCP authentication setup, and tool limits within the selected architecture.

The initial implementation uses versioned JSON configuration, optional
`enabledTools` restrictions, `.env` loading, native OS-backed locks, and no-auth
client-side MCP. Exact pinned versions and current verification evidence are
recorded in `MVP_IMPLEMENTATION_PLAN.md`.

## Primary References

- [OpenAI Agents SDK: Running Agents](https://openai.github.io/openai-agents-js/guides/running-agents/)
- [OpenAI Agents SDK: Agents](https://openai.github.io/openai-agents-js/guides/agents/)
- [OpenAI Agents SDK: Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
- [OpenAI Agents SDK: Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- [OpenAI Agents SDK: Streaming](https://openai.github.io/openai-agents-js/guides/streaming/)
- [OpenAI Agents SDK: MCP](https://openai.github.io/openai-agents-js/guides/mcp/)
- [OpenAI Agents SDK: Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- [SQLite: Write-Ahead Logging](https://sqlite.org/wal.html)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
