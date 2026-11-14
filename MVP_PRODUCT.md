# MVP Product Scope

## Purpose

Build a developer-facing, general-purpose agent harness with an interactive terminal UI. Users must be able to delegate useful tool-backed work, inspect progress, control sensitive actions, and resume saved conversations.

This document combines the **Must-Have: Production Baseline** requirements from `docs\PRODUCT_VIEW.md` with the interactive terminal UI must-haves agreed during product discovery. All requirements below are mandatory for the MVP unless explicitly conditional.

## Session and Execution Model

| Concept | MVP definition |
|---|---|
| **Session** | A locally persisted conversation containing its workspace identity, configuration, messages, task state, approvals, tool outcomes, and result references. |
| **Run** | Execution of a user request within a session. Only one top-level run may be active in a session at a time. |
| **Terminal instance** | One terminal process owns one active session. There is no in-app session switching, tab system, or multi-session dashboard. |
| **Concurrent use** | Multiple terminal instances may run different sessions concurrently. Their histories, approvals, logs, and execution state remain separate. |
| **Resume** | A stopped or interrupted session can be reopened from local storage. Resume does not imply that work continued while the terminal was closed. |
| **Execution lifetime** | Detached execution is out of scope. Clean exit stops foreground execution and saves state; abnormal termination must be recoverable without blindly repeating uncertain actions. |

Use one model provider and one durable local storage backend initially. Keep provider and storage integration boundaries replaceable without requiring multiple implementations in the MVP.

## Must-Have Runtime Capabilities

These requirements retain every capability in the production baseline of `docs\PRODUCT_VIEW.md`.

| ID | Capability | MVP requirement |
|---|---|---|
| R01 | **Agent configuration** | Configure instructions, model settings, tools, permissions, and expected output. Keep model integration behind an adapter. Report invalid configuration and authentication errors explicitly. |
| R02 | **Controlled execution loop** | Manage model calls, tool calls, results, and completion. Expose explicit running, awaiting input, awaiting approval, completed, failed, and cancelled states, with an idle state between runs. |
| R03 | **Tool integration** | Support custom tools and an MCP client. Validate tool arguments against schemas; provide timeouts, structured errors, and explicit authentication. Include a small tool set capable of completing at least one useful end-to-end workflow. |
| R04 | **Sessions and persistent state** | Persist conversation history, task progress, approvals, tool outcomes, and artifact references. Isolate session state and support safe concurrent access by independent terminal processes. |
| R05 | **Context management** | Track context usage and compact, summarize, or offload large results before overflow. Preserve authoritative instructions and structured task state separately from lossy summaries. |
| R06 | **Planning and basic orchestration** | Track tasks and progress. Support sequential steps, conditional branches, and bounded parallel steps with developer-constrained execution paths. Parallel steps within a run do not require subagents or concurrent top-level runs. |
| R07 | **Recovery and failure handling** | Checkpoint progress, resume interrupted runs, and retry transient failures with bounded backoff. Record tool intent and completion so an interrupted side effect can be identified as uncertain rather than silently repeated. |
| R08 | **Human oversight** | Pause for clarification or approval. Show the proposed action and arguments, accept rejection or correction, and resume safely. Support cancellation. Approval decisions must remain scoped to the intended action and applicable permissions. |
| R09 | **Enforced security boundaries** | Enforce least-privilege tool access outside the model. Protect credentials and treat retrieved content as untrusted. If code or shell execution is enabled, enforce filesystem, process, and network isolation outside the model. |
| R10 | **Resource controls** | Bound iterations, tokens, elapsed time, and concurrency. Track spending and enforce configured per-run budget policies, documenting estimation limitations and in-flight overshoot. |
| R11 | **Results and artifacts** | Return text, structured outputs, and files as appropriate, associated with their originating run. Distinguish success, partial completion, and failure. Support application-defined completion validators. |
| R12 | **Observability and auditability** | Stream progress and record model/tool activity, errors, approvals, latency, and usage. Correlate records by session and run, redact sensitive data, and provide inspectable traces. OpenTelemetry-compatible export is preferred. |
| R13 | **Developer integration and regression evaluation** | Provide a documented programmatic API or SDK for starting, inspecting, streaming, resuming, and cancelling runs; lifecycle hooks; versioned configurations; and a way to evaluate changes against representative tasks. A hosted HTTP API or evaluation dashboard is not required. |

## Must-Have Interactive Terminal Experience

| ID | Capability | MVP requirement |
|---|---|---|
| T01 | **Simple startup and session discovery** | Start a new session in a chosen working directory, show its identity, resume an explicit saved session, and list saved sessions through a simple CLI command. Clearly distinguish active sessions from resumable ones. |
| T02 | **Usable prompt editor** | Support multiline input, reliable paste without accidental submission, cursor editing, and previous-input recall. Make submission and newline shortcuts discoverable. |
| T03 | **Readable conversation** | Stream responses and distinguish user messages, assistant responses, and tool activity. Support scrolling, basic code formatting, copying, and terminal resizing. |
| T04 | **Visible execution state** | Show whether the session is idle, working, awaiting approval, awaiting input, failed, or cancelled. Identify the current action or tool instead of relying on an unexplained spinner. Preserve completed run outcomes in the transcript. |
| T05 | **Tool inspection** | Show the tool name, relevant arguments, execution status, and errors. Bound inline output size while retaining access to the full result with sensitive data redacted. Render untrusted output without allowing arbitrary terminal control sequences. |
| T06 | **Approval and clarification interaction** | Present the exact proposed action, its arguments, and scope before approval. Provide explicit approve/reject choices and allow correction or clarification. The UI must not substitute for runtime permission enforcement. |
| T07 | **Interrupt and exit** | Provide a discoverable way to cancel the current run without destroying the session. Stop supported child processes, report uncertain external effects, and leave the conversation usable. Save state and stop execution on clean exit. |
| T08 | **Persistence and recovery feedback** | Save automatically rather than requiring a manual save command. On resume, restore history and task state, surface pending approvals and interrupted actions, and explain what can safely continue. |
| T09 | **Minimal help and status** | Provide `/help`, `/status`, and `/exit`, or clearly documented equivalents. Status must identify the session, workspace, model, active permission policy, and context/token usage. |
| T10 | **Resource visibility** | Show context/token usage and clearly explain any resource limit that stops execution. A continuously updating currency-cost widget is not required, but runtime spending tracking and configured budget enforcement remain in scope. |
| T11 | **Useful outcomes and actionable errors** | Show resulting file paths and structured results where applicable. Explain failures, partial completion, and available recovery actions rather than presenting success-shaped fallbacks. |
| T12 | **Keyboard-first terminal robustness** | Keep the interface operable by keyboard, make important states understandable without color alone, and preserve the prompt and transcript during terminal resize and redraw. Document the supported terminal/platform scope. |

Only one top-level run may execute in a session at a time. Prompt queuing is not required: users may interrupt the current run before submitting a new instruction.

## Concurrent-Terminal Safety

- Each new session has a unique identity and separate persisted state.
- Only one terminal process may write to a particular session at a time. Attempting to resume an already active session must fail clearly without changing its state.
- Abnormal termination must not leave a session permanently unresumable because of stale ownership.
- Logs, approval decisions, usage, and resource limits must not leak between independent sessions.
- The working directory and writable scope must be clearly visible.
- Separate sessions do not isolate shared files. File-editing tools must detect stale content before overwriting it, and the application must warn about detected overlapping writable workspaces.
- Automatic merging, cross-session coordination, and aggregate scheduling or budgeting across terminal processes are not required.

## Scope Clarifications

- **MCP client support remains mandatory.** A dedicated MCP configuration UI, connector catalog, or plugin marketplace is not required.
- **Basic orchestration remains mandatory.** Sequential, conditional, and bounded parallel steps are runtime capabilities; autonomous agent teams and a visual workflow editor are not required.
- **Session persistence is not long-term memory.** Restoring a conversation is required; learning or sharing information across independent sessions is not.
- **Programmatic integration is not a hosted service.** A local API or SDK is sufficient; accounts, multi-tenant hosting, and a web server are not required.
- **Spending controls are not a cost dashboard.** Runtime accounting and configured budget enforcement are required; a rich live currency display is not.
- **Tool extensibility is not a comprehensive built-in tool suite.** The MVP needs a useful tool-backed workflow, not built-in browsing, computer use, and every document format.
- **Checkpointing is not exactly-once execution.** Resume must account for uncertain side effects; cancellation cannot undo actions that have already completed.
- **MCP is not a security boundary.** Tool permissions and execution isolation must be enforced independently of protocol support.

## Outside the MVP

The following are explicitly deferred and must not be treated as release requirements:

- In-app session switching, tabs, or a multi-session dashboard.
- Subagents, autonomous agent teams, and cross-session messaging.
- Detached execution, distributed workers, scheduling, and event-triggered automation.
- Visual workflow authoring, web/desktop/mobile clients, IDE extensions, or messaging-channel clients.
- Long-term cross-session memory, intelligent model routing, and multiple model providers.
- Skills marketplaces, plugin catalogs, and dedicated MCP configuration screens.
- Prompt queuing, fuzzy file-reference autocomplete, and external-editor integration.
- Dedicated plan/todo panels, transcript search/export, and rich side-by-side diff review.
- Session branching, rewind, automatic file merging, or general-purpose action undo.
- Completion notifications, themes, configurable keybindings, and mouse support.
- Hosted multi-tenancy, enterprise administration, and evaluation or observability dashboards.

## MVP Release Gates

The MVP is complete only when the following behaviors are demonstrated:

1. A user can configure the supported provider, start a session, and complete a real tool-backed task with an inspectable result.
2. Two terminal instances can execute different sessions concurrently without mixing history, approvals, logs, or task state.
3. A second process cannot resume and write to an already active session.
4. A session can be exited or interrupted and resumed with its saved history and task state intact. Uncertain actions are surfaced rather than silently repeated.
5. Rejected tool actions do not execute, including MCP tool actions. Pending approvals remain reviewable after restart.
6. Cancellation leaves the conversation usable, stops supported child processes, and explains any effects that may already have occurred.
7. Context compaction preserves authoritative instructions and structured task progress, allowing a long conversation to continue.
8. Configured iteration, token, time, concurrency, and spending limits are enforced according to their documented semantics, with explicit stop reasons and accounting for possible overshoot.
9. File-editing tools reject stale writes rather than overwriting externally changed content, and detected overlapping writable workspaces produce a visible warning.
10. Output validators distinguish valid completion from partial or failed work, and representative regression evaluations can be run against versioned configurations with correlated traces.

Implementation choices such as language, TUI library, model provider, and storage technology are deliberately not prescribed by this scope.
