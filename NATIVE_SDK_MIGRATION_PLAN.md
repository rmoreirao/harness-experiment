# Native SDK hard-cutover plan

Date: 2026-11-19

Status: Native implementation completed and offline validation passed.
Live account/provider, authenticated external MCP and optional Docker/browser
acceptance remain environment-dependent and were not claimed from fixtures.
See `IMPLEMENTATION_PLAN.md` for the evidence and prerequisites.

## 1. Objective and release boundary

Replace the custom-only harness architecture with a native Copilot SDK host that
supports local shell execution, SDK-managed subagents and workspace extensions.
Keep the harness's terminal/headless experience, durable evidence and operational
visibility without rebuilding the SDK's execution engine.

This is a hard cutover, not an additional operating mode:

- Ship one native architecture in one integrated release.
- Do not maintain a restricted legacy mode, migration feature flags,
  compatibility adapters or a custom-only fallback.
- Do not migrate, resume or provide a viewer for historical sessions.
- Leave historical data untouched; use a fresh configuration/storage generation.
- Keep Docker only as an explicitly available tool, not an alternative harness.
- Treat the implementation phases below as internal dependencies, not separately
  supported releases.

The target remains the existing Windows Terminal/PowerShell application and its
headless API. This project does not introduce another agent loop or orchestration
framework.

## 2. Confirmed product decisions

| Area | Final decision |
|---|---|
| Native capabilities | SDK-native coding tools, shell execution and delegation |
| Agents | Runtime-provided specialists and workspace-defined custom agents |
| Permissions | Default to allow-all after explicit session trust confirmation; manual and assisted modes remain selectable |
| Task progression | Interactive by default; plan and autopilot selectable independently of permissions |
| Discovery | Trusted workspace configuration only |
| Developer environment | Normal developer environment and tool profiles; do not automatically inherit known harness-owned API keys |
| Authentication | Support Copilot sign-in and BYOK |
| Provider scope | One provider per session; no Copilot/BYOK mixing within a session |
| Worker models | Inherit the parent model by default; support explicit per-agent models within the selected provider |
| Parallel editing | Shared checkout with coordinated, non-overlapping assignments |
| Docker | Optional explicit tool with its existing isolated mirror/publication semantics |
| Historical compatibility | None; do not modify or delete existing data |

Workspace-only discovery concerns Copilot instructions, skills, agent definitions,
hooks and MCP configuration. It does not prevent Git, npm or other developer tools
from using their normal user configuration, or prevent SDK authentication from
using its supported credential store.

Native execution is unsandboxed. Environment filtering, workspace selection, tool
filters and role instructions are not filesystem or network confinement.

## 3. Target ownership

| Concern | Owner after cutover |
|---|---|
| Agent loop, conversation, context and compaction | Copilot SDK/runtime |
| Native tools, shell processes and delegation | Copilot SDK/runtime |
| Tool permission enforcement and managed-policy constraints | SDK, connected to the harness's decision interface |
| Session trust, provider/model configuration and extension sources | Harness |
| Objective state and evidence-based completion | Harness, using native activity and SDK planning |
| Terminal/headless UI, authentication presentation and activity inspection | Harness |
| Durable activity/evidence projection, usage reporting and recovery coordination | Harness |
| Research evidence and other distinctive domain tools | Retained custom tools using the same SDK permission and activity integration |
| Optional Docker mirrors and exact publication | Docker tool implementation |

Do not create a second canonical conversation or independent subagent scheduler.
The product journal is an operational projection of SDK activity, not a replay
engine that re-executes native actions.

## 4. Implementation phases

### Phase 1: Establish the SDK/runtime contract

Primary areas: `src\runtime.ts`, installed SDK interfaces, dependency pins.

1. Establish supported native tool and built-in agent catalogs on Windows.
2. Establish shell execution, background-command correlation, delegation,
   permission modes, task modes and worker lifecycle behavior.
3. Establish authentication/model discovery for Copilot and BYOK, including
   per-agent model resolution within a single provider.
4. Establish which startup/discovery mechanisms can be limited to workspace
   sources before hooks or MCP processes start.
5. Identify authoritative usage, tool-result, worker, cancellation and pending
   decision interfaces, including failure paths and event correlation.
6. If a required capability is missing or defective, update the SDK/runtime pins
   together. Do not retain obsolete limitations or silently omit required scope.

Exit condition: every required integration has a confirmed SDK path or a concrete
compatibility blocker. Do not begin broad rewiring based on guessed APIs.

### Phase 2: Replace configuration, storage and startup

Depends on Phase 1.

Primary areas: `src\config.ts`, `src\contracts.ts`, `src\store.ts`,
`src\controller.ts`, `src\cli.tsx`.

1. Define one native configuration format with:
   - Provider authentication and model identities.
   - Parent/worker model selection and agent definitions.
   - Permission mode, task mode and startup trust.
   - Workspace configuration sources and developer environment handling.
   - Separate model-request, worker and command concurrency settings where the
     SDK supports enforcement.
   - Explicit optional limits and Docker configuration.
2. Use a fresh storage namespace/schema. Reject old configurations and session
   stores with actionable errors; do not silently reinterpret them.
3. Require explicit session trust before executable workspace configuration is
   activated. Headless callers must supply an explicit trust decision; the host
   must not approve itself.
4. Maintain private SDK session state while giving native commands normal
   developer profile paths and required environment variables.
5. Exclude known harness-owned provider/search credentials from automatic
   subprocess inheritance, and retain secret-safe diagnostic handling.
6. Define typed records for worker identity, invocation relationships, decisions,
   native tool outcomes, output references and provider/model usage. Do not add
   fictional Docker/container fields to native executions.

Exit condition: a fresh native session has an explicit, inspectable configuration
and trust state. Existing data remains untouched and unsupported.

### Phase 3: Implement provider authentication and model routing

Depends on Phases 1 and 2.

Primary areas: provider configuration, `ControlledModelTransport`,
`src\runtime.ts`, `src\resources.ts`, authentication UI/headless handling.

1. Implement Copilot sign-in using SDK-owned authentication and model discovery.
   Surface sign-in, cancellation, expiration and unavailable-account states.
2. Retain the useful BYOK transport controls while removing the assumption that
   every session uses the current single Responses endpoint/model combination.
3. Resolve configured parent and worker models within the selected provider.
   Validate model identities and surface the effective model used.
4. Make unavailable models or unsupported overrides explicit. Do not silently
   fall back to another provider or ignore a required worker-model selection.
5. Record provider/model identity and aggregate usage without counting the same
   request twice through transport observations and SDK usage events.
6. Report provider-appropriate consumption and pricing. Do not equate Copilot
   allowances with BYOK token prices or fabricate missing monetary estimates.
7. Preserve explicitly configured budgets only where admission/accounting can
   actually enforce them. Reject unsupported hard-budget configurations rather
   than presenting advisory reporting as guaranteed enforcement.

Exit condition: both authentication paths work independently; parent and workers
use permitted models from their session's provider with honest usage reporting.

### Phase 4: Replace execution and permission plumbing

Depends on Phases 2 and 3.

Primary areas: `src\runtime.ts`, `src\policy.ts`, contracts, storage and controller.

1. Initialize the SDK with native capabilities and the actual workspace.
2. Preserve the SDK foundation prompt and append concise harness guidance.
   Remove instructions that prohibit shell/delegation or assume Docker-only work.
3. Remove custom-only tool allowlists, blanket built-in exclusions and hook
   rejections. Respect runtime, platform and enforced organizational constraints.
4. Make SDK permission handling authoritative for native and retained custom
   tools. Remove duplicate custom approval flows and inappropriate permission
   bypasses from retained tools.
5. Connect manual, assisted and allow-all modes to the same effective policy.
   Map `/approve_all` and equivalent headless operations to that policy.
6. Journal tool starts, successes, failures, denials, background execution and
   bounded output references using SDK invocation identities.
7. Keep domain validation in retained custom tools, without pretending its
   restrictions constrain unrelated native shell commands.
8. Retain Docker as an explicit tool. Preserve mirror inspection and publication
   semantics only for actions actually executed through that tool.

Exit condition: native shell and coding tools execute through the SDK and appear
correctly in the product journal under the selected permissions.

### Phase 5: Integrate workers, lifecycle and resource supervision

Depends on Phases 3 and 4.

Primary areas: `src\runtime.ts`, `src\controller.ts`, `src\resources.ts`,
contracts and storage.

1. Enable built-in specialists and workspace custom agents. Preserve intended
   specialist tool access rather than forcing every worker to be read-only.
2. Track agent identity, parent/delegation relationships, role, model, status and
   associated native/custom tool activity under the parent objective.
3. Replace the hardcoded single-request model semaphore with configured admission
   control, and account for active parent and worker requests together.
4. Coordinate non-overlapping write assignments in the shared checkout. Surface
   conflicting edits; do not silently overwrite unrelated work. Do not introduce
   automatic worker worktrees or claim assignment discipline is OS isolation.
5. Distinguish parent messages from worker messages. Only appropriate parent
   output updates the objective's final response.
6. Extend cancellation, shutdown and restart reconciliation to workers, commands,
   pending permissions and authentication interactions.
7. Persist SDK correlation identities and recover operational state without
   blindly replaying side effects. Cancellation is not rollback.
8. Reapply required configuration/callbacks when resuming new-format sessions.
   Resume is not permission to replay expired decisions.
9. Do not declare completion while objective-owned workers or commands remain
   active or their effects are unresolved.

Exit condition: parent and shell-capable workers form one observable, cancellable
objective with coherent concurrency, accounting and restart behavior.

### Phase 6: Consolidate workspace extensions and completion evidence

Depends on Phases 4 and 5.

Primary areas: `src\skills.ts`, `src\mcp.ts`, `src\controller.ts`,
runtime configuration and retained domain tools.

1. Use SDK-supported workspace instruction, skill, agent, hook and MCP sources.
   Use explicit roots or a scoped resolver where ambient discovery would load
   personal configuration. Do not broaden discovery to make integration easier.
2. Support configured SDK MCP transports and required authentication callbacks.
   Keep authentication secrets out of ordinary chat, output and stored records.
3. Make `/skills` reflect the effective SDK catalog and supported reload behavior,
   rather than maintaining an unrelated snapshot catalog.
4. Replace Docker-specific coding guidance and custom-tool-name completion rules.
   Accept relevant native command results and reviewable diff evidence.
5. Align SDK planning with the harness's objective/evidence projection. Native
   tools must not need obsolete custom result IDs merely to satisfy the old plan
   representation.
6. Preserve useful research citation/evidence workflows and other distinctive
   domain tools. Native browsing or retrieval does not automatically produce
   citation-verified research evidence.
7. Distinguish verified, incomplete, blocked and unknown outcomes. An unrelated
   command returning zero is not proof of the user's requested outcome.

Exit condition: workspace extensions and native work satisfy accurate product
contracts without personal-config discovery or parallel tool/plan systems.

### Phase 7: Complete the UI, remove superseded code and cut over

Depends on Phases 1 through 6.

Primary areas: `src\ui.tsx`, `src\activity.ts`, `src\trace-view.ts`,
`src\cli.tsx`, public exports, package contents and documentation.

1. Expose provider/model status, permission mode, task mode, trust state, workers,
   native tool output, errors and pending authentication in terminal/headless use.
2. Update command contracts and help for approvals, skills, inspection,
   cancellation, continuation, context clearing and new-format resume.
3. Remove superseded custom coding registrations, the no-auth-only MCP execution
   path, competing skill discovery, compatibility branches and obsolete fixtures.
   Keep helpers only where still required by retained features.
4. Replace old invariants and acceptance cases with native behavior coverage.
   Keep regression coverage for retained functionality and unrelated user edits.
5. Rewrite current architecture/product/guide material and configuration examples
   to describe only the new supported architecture. Resolve conflicting claims in
   previous implementation documents.
6. Keep application telemetry settings and secret handling deliberate; native
   capability adoption does not imply opting into unrelated data collection.
7. Package one native implementation. Do not ship an old-mode switch or silently
   restore the old architecture when a native prerequisite is unavailable.

Exit condition: source, exported API, installed package, documentation and both
interfaces describe and implement the same native product.

## 5. Release acceptance

| Scenario | Required outcome |
|---|---|
| Startup trust | Neither workspace hooks nor MCP processes execute before explicit trust; headless use requires an explicit decision |
| Native development | PowerShell and installed toolchains operate in the real checkout; edits, command output and diffs are inspectable |
| SDK delegation | Built-in and workspace custom agents can perform appropriate work with native tools and return attributable results |
| Provider selection | Copilot sign-in and BYOK work as separate session choices, with no cross-provider fallback |
| Worker models | Effective parent/worker model selections are visible; invalid or unavailable required selections fail explicitly |
| Permissions and task modes | Manual/assisted/allow-all remain distinct from interactive/plan/autopilot; custom and native tools follow the effective policy |
| Discovery scope | Workspace sources load; deliberately present personal instructions, agents, hooks and MCP configuration do not |
| Developer environment | Normal tool configuration works; known harness-owned API keys are not automatically inherited by commands |
| Activity and evidence | Successful and failed native calls are recorded once, worker output does not overwrite the parent answer, and evidence reflects the actual objective |
| Accounting | Parent/worker consumption is aggregated without duplicate counting; unavailable usage/cost and unenforceable caps are explicit |
| Shared edits | Coordinated workers preserve unrelated changes and surface conflicting assignments or resulting edits |
| Cancellation and shutdown | Objective-owned workers and commands are stopped or explicitly reported unresolved; no unsupported clean-stop claim |
| Resume and recovery | New-format sessions restore configuration and activity; interrupted side effects are not blindly repeated |
| Optional Docker | Explicit Docker execution still uses its mirror/publication contract; native execution is never labeled isolated |
| Missing prerequisites | Authentication, model, tool or runtime incompatibility produces an actionable error, not a legacy fallback |
| Hard cutover | Historical configurations/stores are unsupported and untouched; the installed package contains no alternate legacy architecture |

Use focused deterministic SDK/provider fixtures for routine verification, plus
real Windows shell/process exercises. Keep live provider, paid-model,
authenticated MCP and Docker acceptance explicit and opt-in; fixture success is
not evidence that a live provider or local prerequisite worked.

## 6. Explicit exclusions

- Historical data conversion, historical-session resume or a legacy viewer.
- A separately supported restricted/custom-only harness.
- Cross-provider model mixing within one session.
- Fleet orchestration or an application-managed parallel agent scheduler.
- Automatic per-worker worktrees and change-merging infrastructure.
- A new native sandbox or guarantees that unrestricted shell commands obey the
  old custom-tool filesystem/network policy.
- Automatic integration of every external service or every experimental SDK
  feature. Support configured integrations and report actual availability.

## 7. Definition of completion

All phases and applicable release acceptance scenarios are satisfied together.
Native execution, delegation, authentication, permissions, activity, accounting,
completion and recovery operate through one architecture.

There is no partially migrated supported release, compatibility roadmap or
fallback promise. Any remaining material limitation is stated explicitly rather
than hidden behind a successful-looking result.
