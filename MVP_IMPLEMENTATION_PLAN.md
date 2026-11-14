# MVP Implementation Plan

## Objective

Implement the complete MVP in one end-to-end assignment, using `MVP_PRODUCT.md` as the product scope and `MVP_ARCHITECTURE.md` as the technical design.

The phases below are an internal execution order, not separate product releases or requests for milestone approval. Continue through implementation, verification, packaging, and documentation unless a genuine blocker requires a user decision. A working skeleton alone does not satisfy this plan.

This document is the implementation plan, not evidence that implementation or validation has already occurred.

## Confirmed Decisions

| Area | Implementation constraint |
|---|---|
| Supported interface | Windows Terminal with PowerShell only. No macOS, Linux, WSL, other shells, or additional UI clients are release targets. |
| Language/runtime | TypeScript, Node.js LTS, ESM. |
| Terminal UI | React and Ink, subject to the architecture's terminal-behavior suitability gate. |
| Execution runtime | OpenAI Agents SDK, one reusable Runner per terminal process and one stable Agent definition initially. |
| Session model | One exclusively owned, locally resumable session per terminal process. Different terminals may run different sessions concurrently. |
| Persistence | SQLite through `better-sqlite3`, with explicit OS-backed session ownership. |
| Model access | User-supplied OpenAI endpoint and API key. Model identity is configurable and must be provided before live verification. |
| MCP | Client-side stdio and Streamable HTTP, without authentication for the MVP. No OAuth, login UI, token management, or credential injection into MCP requests. |
| Reference workflow | Read documents in an allowed folder, generate a summary, and save it. Require approval before reading document contents and separately before saving the summary. |
| Execution safety | Scoped built-in tools; no arbitrary shell, code execution, or computer use. Explicitly configured stdio MCP servers remain trusted executable dependencies, not sandboxes. |
| Trace export | Local, redacted records by default. No automatic external tracing export. |

These explicit user decisions specialize the broader platform and authentication language in the earlier documents. In particular, MCP authentication is deferred, but OpenAI API authentication and tool authorization/approval remain required.

All other MVP must-haves remain in scope. If an SDK limitation or dependency incompatibility prevents a requirement, surface the conflict rather than silently dropping the requirement or changing the selected technology.

## External Inputs and Verification Boundaries

| Input | Needed for | Handling before it is available |
|---|---|---|
| OpenAI endpoint/base URL | Live provider integration | Use a deterministic fake model through the real SDK execution path. |
| OpenAI model identity and supported capabilities | Live streaming, tool calling, output, context, and usage checks | Exercise explicit model capability/configuration contracts with fixtures; do not assume endpoint compatibility from its name. |
| API key | Authenticated provider calls | Resolve it through an environment variable or equivalent secure local mechanism. Never request that it be committed or copied into session records. |
| Explicit live-verification spending ceiling | Paid API smoke tests | Do not make paid calls until authorized. Offline checks must remain runnable without credentials or network access. |
| Pricing and context/output limits for the selected model | Currency budgets and context admission | Use configured values and deterministic test fixtures. Do not silently treat unknown costs as zero. |

Validate that the supplied endpoint actually supports the selected Responses-based SDK integration, including required tool and streaming behavior. An endpoint/API-key pair alone does not prove compatibility. If its API shape or authentication differs, report the exact mismatch before expanding provider scope.

Missing live inputs do not block implementing and testing the offline application. They do block claiming that live-provider acceptance is verified. Record implementation completion and release verification separately.

## Reference Workflow and Acceptance Contract

Use synthetic UTF-8 plain-text and Markdown documents for the initial reference fixtures. This is a bounded initial format choice, not a requirement for a comprehensive document-conversion suite.

| Step | Required behavior |
|---|---|
| Start | Start a new session with an explicitly configured allowed folder. Show session identity, workspace, model configuration, and permission policy. |
| Propose reading | Present the exact files and read scope for the pending tool call without loading their contents first. A configured folder is a scope boundary, not an automatic read grant. |
| Approve or reject reading | Execute the read only after approval. Rejection must produce no document-content read or transmission to the model. |
| Summarize | Generate a nonempty summary from approved inputs, identifying the source paths used. Report unreadable/unsupported inputs explicitly rather than pretending they were processed. |
| Propose saving | Show the destination and generated content to be written. Ask for a separate, exact save approval. |
| Approve or reject saving | Write only after approval and precondition checks. Rejection leaves the destination unchanged. |
| Finish | Show the result, output path when written, source references, usage, and an accurate completed/partial/failed outcome. A denied save must not be reported as a successful save. |
| Resume | Exit while either approval is pending, reopen the saved session, and safely continue the pending decision without repeating completed actions. |

Read approval applies to all document-content access, including previews, hashing, and search results that expose contents. Do not read through another helper, export path, or MCP tool to bypass a rejection. Show that approved contents will be sent to the configured model endpoint when applicable.

Use per-call approvals, not permanent or folder-wide grants. Multiple files may be covered by one bounded read call only when the exact file set is shown. Changed action arguments or invalidated preconditions require a fresh request.

Save inside the allowed writable scope. Default to creating a new output file; never overwrite an existing target unconditionally. Any supported overwrite must use an expected-content/version precondition obtained through authorized access and rechecked immediately before writing.

Reference-workflow success is necessary but not sufficient: the complete MVP also includes MCP, clarification, orchestration, compaction, resource controls, artifacts, tracing, and programmatic integration.

## Implementation Order

| Phase | Prerequisites | Work and exit evidence |
|---|---|---|
| P0: Bootstrap and compatibility gates | None | Establish the package, build/type-check/lint/test commands, and dependency lockfile. Prove Ink behavior, native SQLite installation, OS-backed locking, and SDK approval-state round trips on Windows. Record exact versions and observed results. |
| P1: Contracts and configuration | P0 | Define controller commands/events, state machines, error taxonomy, configuration revisions, permission policies, checkpoint envelope, and provider/tool contracts. Validate configuration and keep credentials out of serializable state. |
| P2: Durable storage and ownership | P1 | Implement migrations, SQLite repositories, SDK Session adapter, idempotent history operations, session discovery, exclusive ownership, and shared-workspace diagnostics. Verify concurrent processes and crash-release behavior. |
| P3: SDK execution and controller | P2 | Integrate the reusable Runner/Agent with streaming, durable run records, approvals, clarification, cancellation, checkpoint restoration, and execution journaling. Use fake models and tools for deterministic failure injection. |
| P4: Native tools and reference workflow | P3 | Implement scoped discovery/read/search/write tools, both approval boundaries, stale-write protection, result/artifact records, and completion validators. Run the full reference workflow through the headless controller. |
| P5: No-auth MCP integration | P3 | Integrate stdio and Streamable HTTP through the same policy/journal pipeline. Exercise tool discovery, validation, approval, rejection, errors, timeouts, and cancellation using controlled local fixtures. |
| P6: Orchestration, context, and budgets | P4, P5 | Complete task tracking, sequential/conditional/bounded-parallel execution, context compaction, usage accounting, and token/time/iteration/concurrency/spending controls. Verify limits across approval/resume and restart. |
| P7: Complete Ink experience | P0, P6 | Connect the real controller to prompt, transcript, status, tool inspection, approval/question interactions, recovery feedback, and help/exit commands. Verify the complete workflow in Windows Terminal, not just component snapshots. |
| P8: Release verification and handoff | P7 | Run all product release gates, package/install smoke checks, representative regression evaluations, and authorized live-provider checks when inputs are available. Finish documentation and requirement-to-evidence reporting. |

Observability, redaction, tests, and directly related documentation accompany each phase; they are not postponed until P8. Reuse P0 integration exercises as regression tests where practical rather than maintaining a separate throwaway application.

## P0: Compatibility Gates

| Gate | Required proof | Failure handling |
|---|---|---|
| Ink input/rendering | Multiline editing, paste without submission, scrolling/copying, streaming, resizing/redraw, keyboard approval, and interrupt behavior work in Windows Terminal with PowerShell. | Investigate within the selected stack. If mandatory behavior cannot be delivered, stop for a technology decision before building substantial UI. |
| Native dependencies | The selected Node.js LTS, SQLite driver, and lock implementation install and operate on the tested Windows architecture. | Report native build/toolchain requirements or incompatibilities. Do not substitute a different runtime or storage backend silently. |
| Session ownership | Two processes cannot own the same session; killing the owner allows a new process to acquire ownership without a heartbeat-expiry takeover race. | Reject PID-file-only, expiring-lease-only, or database-WAL-only ownership designs. |
| SDK continuation | A fake-model run pauses before a tool action, persists compatible state, and resumes after reconstruction and approve/reject decisions. | Confirm the pinned SDK contracts. Do not claim arbitrary-crash recovery from an approval-only demonstration. |

Record Windows, PowerShell, Windows Terminal, Node.js, dependency, and CPU-architecture versions used for verification. The support statement must not claim untested environments.

## Core Implementation Requirements

### Contracts, configuration, and storage

- Keep UI commands and application events independent of raw SDK payloads. Validate external input with runtime schemas and preserve TypeScript type safety.
- Document one configuration precedence order. Support an endpoint/base URL, model, credential reference, allowed scopes, MCP servers, limits, and local data location without adding an interactive setup wizard.
- Validate the model capabilities needed by this application. Persist non-secret configuration identity, schema version, and SDK/checkpoint version for resume compatibility.
- Store sessions, run state, SDK history, pending requests, tool intent/outcomes, task state, artifacts, transcript, and usage under their correct identities.
- Implement transactional, idempotent SDK history mutations; do not duplicate items through independent controller and SDK writes.
- Use WAL, foreign keys, short durable transactions, safe concurrent migrations, bounded busy handling, and bounded reads. Do not hold transactions across network calls, tool execution, or human waits.
- Acquire the stable per-session OS lock before execution; never inherit it into tool processes or delete/recreate its file while held. A second owner is refused without modifying session state.
- Keep state outside the workspace on local disk. Handle disk-full, permission, incompatible-schema, and missing-artifact conditions explicitly.

### SDK execution, approvals, and recovery

- Reuse one Runner and stable Agent definition per terminal process. Recreate objects on restart while preserving durable session identity.
- Permit one logical top-level run per session. A pending question or approval still belongs to that run; prompt queuing and in-app switching remain excluded.
- Journal intent before tool dispatch and outcome afterward. Reuse a known result for the same invocation when safe; never silently redispatch an uncertain side effect.
- Bind approvals and answers to current session/run/request identity, exact action, and request revision. Reject stale or cross-session decisions.
- Reconstruct compatible Agent/tools and fresh non-secret runtime context before restoring SDK state. Fail closed on incompatible checkpoints.
- Implement durable clarification independently of boolean approval prompts and verify it after restart.
- Await SDK completion, including persistence/post-processing, before finalizing a run.
- Preserve partial output after interrupted generation, distinguish unknown tool outcomes, and expose explicit reconciliation/continuation actions.
- Propagate cancellation to cooperative operations and supervise owned process trees on Windows. Do not admit conflicting work while uncontained local effects can still execute.

### Tools and MCP

- Enforce one validation, permission, approval, journaling, timeout, and error-handling contract for native and client-side MCP calls.
- Enforce allowed roots with Windows path, case, symlink, junction, and alternate-path behavior considered. Reject traversal and scope escapes.
- Coordinate file writes between application instances, check stale content, and warn about detected writable-scope overlap. Do not claim that session separation isolates files.
- Use explicitly configured no-auth MCP servers. Do not inherit provider credentials into stdio MCP environments or attach them to HTTP MCP requests.
- Surface HTTP authentication-required responses as unsupported authentication for this MVP; do not invent a successful anonymous fallback or disable TLS verification.
- Require explicit trust/configuration for stdio executable/arguments; supervise startup and shutdown. No-auth does not mean tools or server executables are trusted automatically.
- Disable tools exposing arbitrary code/shell execution until the required isolation exists. Do not use provider-hosted MCP as a shortcut around the local gateway.
- Bound tool outputs while preserving inspectable full results with appropriate redaction. Sanitize terminal control sequences.

### Context, orchestration, resources, and outputs

- Track task state separately from model summaries. Implement sequential and conditional composition and bounded parallel steps without subagents or a second agent loop.
- Compact working history before overflow, reserving room for instructions, tool definitions, output, and safety overhead. Preserve valid tool-call/result relationships and pending decisions.
- Keep the original transcript and authoritative task/instruction state after compaction.
- Enforce iteration, token, elapsed-time, concurrency, and configured spending limits. Document the treatment of human waits, offline time, retries, and in-flight work.
- Preserve run budgets across SDK continuation calls and restart. Include compaction and other model calls in accounting; distinguish reported, estimated, and unknown usage.
- Coordinate retry layers to avoid multiplying attempts. Do not silently price unknown usage at zero or bypass a configured budget when enforcement cannot be established.
- Support structured outputs, completion validators, file artifacts, and explicit partial/failure states. Validation must not be reduced to the presence of a nonempty response.

### Terminal, tracing, and developer access

- Implement prompt editing/history, multiline paste, readable streaming transcript, status, inspectable tools/results, approval and question interactions, and recovery feedback.
- Provide CLI session listing/resume and `/help`, `/status`, `/exit`, or documented equivalents. Show scope, model, permissions, usage, and current action.
- Ensure all important interactions work by keyboard and all important states remain understandable without color.
- Replace default SDK tracing exporters before running the provider. Keep local traces redacted and correlated without using them as the recovery journal.
- Test that credentials are absent from stored snapshots, tool environments, logs, traces, and error output.
- Expose the documented local controller API and lifecycle hooks; use that API for automated regression execution. Hooks cannot bypass policy or ownership.

## Verification Matrix

Every product release gate remains mandatory. The following evidence makes the gates executable rather than relying only on a demonstration of the happy path.

| Product gate | Required verification evidence |
|---|---|
| 1: Real tool-backed task | Deterministic reference workflow plus an opt-in live-provider run against the supplied endpoint/model. Confirm both read and save approvals and inspect the saved output. |
| 2: Concurrent sessions | Two actual processes execute different sessions against the same SQLite database without mixed history, decisions, usage, or logs. |
| 3: Single owner | A second process fails to acquire an active session; forced owner termination releases ownership; stale metadata does not prevent resume. |
| 4: Resume and uncertain actions | Restart at approval/clarification boundaries and inject termination before dispatch, after dispatch, and after the external effect but before outcome persistence. Verify safe continuation or explicit unknown status without duplicate execution. |
| 5: Rejection enforcement | Instrument native and MCP fixtures to prove denied reads do not access contents, denied saves do not modify files, and persisted approvals remain reviewable after restart. |
| 6: Cancellation | Cancel during generation, a cooperative tool, approval wait, and a supervised subprocess. Verify cleanup, usable conversation state, and honest uncertainty where applicable. |
| 7: Compaction | Force a small test context limit and prove instructions/task state survive, call/result pairs remain valid, transcript remains readable, and the next request can continue. |
| 8: Resource controls | Independently trigger iteration, token, elapsed-time, concurrency, and currency limits; cover parallel admission, retries, continuation/restart, and unavailable usage/pricing. |
| 9: Shared-file safety | Attempt stale edits, cross-session writes, Windows scope escapes, and overlapping writable roots. Verify rejection/warnings without claiming automatic merging or general-purpose isolation. |
| 10: Validators and evaluation | Include successful, invalid, partial, and failed outputs in repeatable regression evaluations using versioned configurations and correlated local records. |

Add negative checks for missing/invalid configuration, authentication and endpoint errors, malformed tool arguments, auth-required MCP responses, unsafe terminal output, disk errors, checkpoint incompatibility, and telemetry leakage.

Use synthetic fixtures and a fake SDK-compatible model for routine automation. Controlled local MCP fixture servers must exercise both transports without external services or paid access.

Use real SQLite and real child processes for storage/ownership/recovery checks. UI snapshots alone do not prove terminal input behavior; supplement them with terminal-level automation where feasible and recorded Windows Terminal interaction checks.

Before declaring completion, run the smallest focused checks during development and the full applicable suite at release. Any skipped or manual-only check must be explicitly identified.

## Requirement-to-Evidence Coverage

| Requirement | Main phases | Evidence |
|---|---|---|
| R01: Agent configuration | P1, P3, P8 | Validated provider/model/tool configuration, explicit errors, secret-safe snapshots, live endpoint check when authorized. |
| R02: Execution loop | P3, P7 | Observable state transitions and full SDK run/continuation completion. |
| R03: Tool integration | P4, P5 | Native/custom tools and no-auth MCP over both transports, schema/error/timeout tests. |
| R04: Persistent sessions | P2, P3 | Idempotent SDK history, restart round trips, concurrent-process isolation. |
| R05: Context management | P6 | Forced compaction and preserved authoritative state/transcript. |
| R06: Planning/orchestration | P6 | Task tracking and sequential/conditional/bounded-parallel scenarios. |
| R07: Recovery | P2, P3, P8 | Checkpoint compatibility, classified retries, fault injection, side-effect reconciliation. |
| R08: Human oversight | P3, P4, P5, P7 | Read/save/MCP approvals, rejection, clarification, cancellation, and restart. |
| R09: Security boundaries | P1, P4, P5, P8 | Scope/credential/terminal-output tests, explicit server trust, disabled arbitrary execution. |
| R10: Resource controls | P6 | Admission/accounting and all limit/overshoot/restart scenarios. |
| R11: Results/artifacts | P4, P6 | Inspectable saved outputs, structured results, validators, and partial/failure outcomes. |
| R12: Observability | P1-P8 | Redacted correlated lifecycle/tool/usage records and verified exporter configuration. |
| R13: Developer integration/evaluation | P1, P3, P8 | Documented headless API/hooks, versioned configuration, regression command/results. |
| T01: Startup/discovery | P2, P7 | New session, saved-session listing, explicit resume, active-session rejection. |
| T02: Prompt editor | P0, P7 | Multiline/paste/cursor/input-recall checks in the supported terminal. |
| T03: Conversation display | P0, P7 | Streaming, distinct roles/tools, code formatting, scrolling/copying, resize. |
| T04: Execution state | P3, P7 | Visible state/current action and retained final outcomes. |
| T05: Tool inspection | P4, P5, P7 | Arguments/status/errors, bounded preview, inspectable full output, safe rendering. |
| T06: Approval/clarification UI | P3, P7 | Exact scoped actions, approve/reject/correct, current-request validation. |
| T07: Interrupt/exit | P3, P7 | Cancel without losing conversation, supervised cleanup, clean save/exit. |
| T08: Resume feedback | P2, P3, P7 | Automatic save, pending decisions, partial output, actionable recovery. |
| T09: Help/status | P7 | Help/status/exit commands and required identity/configuration fields. |
| T10: Resource visibility | P6, P7 | Context/token display and explicit limit-stop explanations. |
| T11: Outcomes/errors | P4, P7 | Accurate output paths, structured results, failure/partial/recovery messaging. |
| T12: Terminal robustness | P0, P7, P8 | Keyboard-only flow, non-color status, redraw/resize, tested support statement. |

During implementation, replace planned evidence with concrete test names, commands, observed outcomes, and manual verification records. Map each requirement to evidence; a phase marked finished is not sufficient proof by itself.

## Deliverables and Definition of Done

| Deliverable | Completion condition |
|---|---|
| Application | Installable CLI and documented local programmatic API implementing all mandatory runtime and TUI capabilities. |
| Reproducible project | Package manifest/lockfile, pinned supported versions, build/type-check/lint/test commands, SQL migrations, and Windows-compatible execution instructions. |
| Regression suite | Deterministic model/tool/MCP fixtures, real SQLite/process tests, and explicit mapping to all MVP requirements and release gates. |
| Packaging | Create the npm package artifact and verify installation/startup from an isolated Windows directory, including native dependencies and resume behavior. Publishing to a registry is not required. |
| Documentation | Installation, endpoint/model/key configuration, no-auth MCP setup, permissions/approvals, data location, session recovery, supported terminal versions, limits, API/hooks, and known limitations. |
| Handoff | Requirement/evidence checklist, command results, reference-workflow outcome, live-verification status, and an honest list of any blockers or unverified behavior. |

The assignment is not complete because the app starts or produces a model response. It is complete only when the full mandatory scope is implemented and the applicable release evidence is recorded.

If live inputs or live-test spending authorization are still missing, deliver the working offline-verified implementation and mark live acceptance as blocked. Do not describe the MVP as fully release-verified until that gate passes.

## Scope and Escalation Rules

- Preserve the exclusions in `MVP_PRODUCT.md`: no multi-session UI, agent teams, background scheduling, hosted service, long-term memory, or additional clients.
- Do not add authentication to MCP, additional providers, broad document conversion, or arbitrary shell access as incidental implementation work.
- Do not replace Ink, OpenAI Agents SDK, SQLite, or the ownership model without a user decision if suitability checks fail.
- Escalate only material blockers: endpoint incompatibility, missing live-test authorization, an unsatisfied mandatory requirement, unsafe recovery/isolation, or a required architecture/scope change.
- Choose routine internal details such as file organization, test runner, schema layout, and exact compatible dependency versions without requiring a separate approval round, while documenting the choices.

## Implementation Evidence (updated 2026-11-14)

The MVP implementation is runnable and its automated acceptance paths are
implemented. The user supplied a working endpoint/key/model, corrected the API
base URL, and confirmed native startup. An earlier live `gpt-6-luna` reference
workflow completed separate approved document reading and summary saving.
Final offline verification and remaining native frontend limitations are
recorded below; this is not a claim that every physical clipboard/display
interaction has been observed.

### Verified environment and dependencies

| Component | Observed version |
|---|---|
| Host | Windows 10.0.26300, x64 |
| PowerShell | 7.6.10 |
| Node.js | 22.14.0 |
| OpenAI Agents SDK | 0.21.0 |
| Ink / React | 6.8.0 / 19.3.1 |
| better-sqlite3 / SQLite | 12.4.1 / 3.50.4 |
| Native lock library | fs-native-extensions 1.5.3 |
| MCP TypeScript SDK | 1.32.2 |

The newest SQLite driver initially failed native installation on this host. The
implementation pins a compatible release with a working Windows binary rather
than changing the selected storage technology.

### Executed checks

| Command | Observed result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npm test` | 55 tests across 11 files passed, including environment loading, live-check opt-in/budget gates, active context compaction, and actual OpenAI HTTP/SSE protocol integration |
| `npm run verify:terminal` | Passed in real PowerShell/Windows ConPTY: concurrent independent terminals, duplicate-owner rejection, multiline paste without submission, streaming, resize, approval restart at read and save, Ctrl+C cancellation, subsequent request, scrolling, and clean exit |
| `npm run eval` | Reference workflow, rejected read, and token-limit scenarios all matched their expected completed/partial/failed outcomes, with correlated local records |
| `npm pack` / `npm run verify:package` | Package created; isolated Windows installation verified the CLI, exported API, native SQLite/locks, approval restart, and approved output |

The ConPTY exercise exposed Windows removal of bracketed-paste markers. Input
handling now also treats native multiline input batches as drafts rather than
commands, with a regression test for that behavior.

### Concrete requirement evidence

| Requirements | Implemented evidence |
|---|---|
| R01, T01, T09 | `src\config.ts`, `src\cli.tsx`; configuration and endpoint safety tests in `test\files.test.ts`; installed CLI check in `test\package-check.ts` |
| R02, R08, T04, T06, T08 | `src\controller.ts`; real SDK approval checkpoints, clarification, stale decisions, restart, same-session command exclusion during preparation, cancellation races, and safe shutdown tests in `test\reference.test.ts` and `test\runtime.test.ts` |
| R03, R09 | `src\gateway.ts`, `src\files.ts`, `src\mcp.ts`; both MCP transports, rejection, credential isolation, mandatory custom-read approval, path/format/size limits, and stale-write checks |
| R04, R07 | `src\storage.ts`, `src\ownership.ts`; idempotent history changes, real cross-process locking, killed-owner recovery, newer-schema rejection, interrupted external-effect reconciliation, and incompatible-checkpoint rejection |
| R05 | `src\context.ts` and SDK `callModelInputFilter` compact before every model request against context and remaining token allowance. Long-loop tests preserve the current user goal, authoritative instructions/tasks, exact latest parallel call/result batches with associated reasoning/commentary, and an approval checkpoint across restart without replay. Transcript and full tool results remain inspectable. |
| R06 | Task tools plus `src\workflow.ts`; bounded SDK tool concurrency, dependency/conditional execution, and cycle rejection in `test\controls.test.ts` |
| R10, T10 | `src\budget.ts`; iteration, token, context, elapsed-time, concurrency, currency, unknown-usage, uncooperative-tool timeout, remaining-budget compaction, and configured tool-allowlist scenarios. The TUI displays the latest conservative context estimate. |
| R11, T11 | Approved file artifacts, structured JSON results, validators, explicit partial/failure outcomes, large-result inspection, and reference evaluations |
| R12, R13 | Redacted local trace/span correlation, documented controller API/hooks/custom tools/validators, versioned configuration, and `test\evaluate.ts` |
| T02, T03, T05, T12 | `src\editor.ts`, `src\ui.tsx`; editor regression tests plus the real Ink/PowerShell ConPTY exercise |
| T07 | Model cancellation and owned stdio MCP process-tree termination, including reconnect after reconciliation. Cancelled pending calls are closed in SDK history without executing them, and a real-provider-wire test verifies the next request has no unanswered function calls. |
| Provider transport | `test\provider.test.ts` uses the real OpenAI Responses SDK against a controlled loopback HTTP/SSE server: authenticated requests, tool-call/result mapping, streaming, checkpoint restart, separate approvals, no retries on 401, and fail-closed missing usage |
| `.env` and live-check integration | `test\environment.test.ts` verifies CLI loading/precedence/secret handling; `test\live-check.test.ts` executes the same live verifier against controlled loopback responses with currency and token caps, synthetic clarification, missing-budget rejection, and explicit opt-in. The real private `.env` is never packaged. |

### Live verification and remaining limitations

- **The missing-endpoint blocker is resolved.** A live test using `gpt-6-luna` completed the synthetic reference workflow with separate read/save approvals, a correct launch-date fact and source reference, and three model requests reporting 2,280 input and 250 output tokens. The user corrected the base URL in `.env` and confirmed that the native app runs.
- The final verifier now loads `.env`, uses only synthetic documents/storage and read/write/clarification tools, and requires explicit opt-in plus a currency or token cap. No test uploads workspace documents or sends credentials to MCP servers.
- The user authorized a further 10,000-token/8-request allowance. Bounded follow-up attempts used a combined 3,907 reported tokens and 6 requests; each was stopped rather than exceeding conservative reservations. The last completed the approved read and write actions but stopped before final model confirmation. It is recorded as a **failed budget-limited check**, not a successful full-run result. Currency prices are not configured, so no currency amount is claimed.
- The earlier local Ollama/Qwen attempt did not complete tool calling. Its temporary verification-only profile was removed, preserving the installed base models; no model downloads were performed. Local-model acceptance remains distinct from the working remote endpoint.
- **Actual Windows Terminal clipboard selection/copy, font/display fidelity, and physical key behavior remain blocked/unverified.** The computer-use tool rejected launching Windows Terminal because the application was blocked by the environment's built-in safety policy. That refusal was not bypassed with shell launch or another UI route. PowerShell/ConPTY and decoder checks passed, but are not presented as a substitute for the native frontend check.
- `.github\workflows\ci.yml` defines Windows offline verification, but no hosted workflow run is claimed: the changes were not committed or pushed.
- Initial document support is UTF-8 text and Markdown. Active compaction is extractive working-memory reduction, not a claim of lossless semantic summarization. Irreducible current inputs and the latest exchange are never silently truncated to force admission.
- Native file preconditions coordinate cooperating writers and detect stale content; they are not general-purpose filesystem isolation against arbitrary external processes.
- Known credentials are redacted; arbitrary personal-data recognition and at-rest database encryption are not implemented or claimed.

Installation, configuration, secure key entry, no-auth MCP setup, resource
semantics, API use, recovery, and verification commands are documented in
`README.md`. The implementation remains in the current checkout without
committing, pushing, publishing a package, or starting a persistent service.
