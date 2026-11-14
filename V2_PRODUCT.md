# V2 Product Scope

Status: implementation plan, not a shipped feature list.
Date: 2026-11-14.

## Goal

Deliver a general-purpose terminal agent that can **code, research, and operate a browser**, breaking goals into manageable work and returning evidence that the requested outcome was achieved.

The primary user is a developer or technical knowledge worker who wants to delegate work, inspect progress, intervene when needed, and resume later. Success is useful completed work, not the number of tools or agents exposed.

This document defines V2 scope. `V2_ARCHITECTURE.md` defines its design; `V2_IMPLEMENTATION_PLAN.md` defines implementation order and acceptance evidence. The `MVP_*` documents retain the V1 baseline and are not retroactively broadened.

## Fixed Boundaries

- Windows Terminal with PowerShell is the supported user interface.
- Keep TypeScript, Node.js LTS, React/Ink, and the useful existing application shell.
- Use Copilot SDK as the primary runtime, not OpenAI Agents SDK plus another agent loop.
- One active product session and one top-level objective per terminal process. Independent terminals may run independent sessions.
- Start with one general-purpose agent. Agent fleets and multi-agent UI are not V2 requirements.
- Reuse the user-supplied OpenAI-compatible endpoint/model/key through BYOK. No silent fallback to another account, provider, or cloud runtime.
- Keep approval-first as the default. Any broader grant is explicit, scoped, visible, and revocable.
- Local application metadata and evidence use SQLite. Copilot owns its runtime conversation state.
- Preserve historical MVP data; do not pretend its serialized OpenAI execution checkpoints are Copilot checkpoints.

## Must-Have Requirements

| ID | Capability | Required V2 behavior |
|---|---|---|
| V2-01 | Terminal and session continuity | Preserve multiline input, safe paste, streaming, history inspection, cancellation, saved-session discovery, and resume. Enforce exclusive ownership and one admitted top-level objective, including during asynchronous preparation. |
| V2-02 | Copilot runtime and BYOK | Integrate the TypeScript SDK and supported runtime through a clean adapter. Validate endpoint, wire API, model identity, tool availability, and authentication. Restore callbacks/policy on resume and report incompatibility explicitly. |
| V2-03 | Planning and completion | Use runtime planning mechanisms; track the objective, steps, dependencies, expected outcomes, blockers, artifacts, and verification evidence. Bound replanning/retries. A runtime idle/completion event alone is not proof of success. |
| V2-04 | General filesystem and precise edits | Discover directories and files, glob, search source/configuration text, read bounded line ranges, create files, and apply precise patches with stale-content checks. Respect protected paths, binary detection, generated-file limits, and explicit deletion policy. |
| V2-05 | Isolated command execution | Run approved tests, builds, linters, package tools, and scripts with explicit executable/arguments, working scope, environment, filesystem/network boundaries, time/output/concurrency limits, and process-tree cleanup. No unrestricted host shell fallback. |
| V2-06 | Git inspection | Provide status, diff, and log for the selected repository, without implicit commits, branch changes, resets, stashes, or pushes. Prevent repository configuration/helpers from turning inspection into unapproved execution. |
| V2-07 | Web discovery and retrieval | Search through an explicitly configured provider, fetch allowed URLs, extract readable content, and preserve source identity. Enforce query/export policy, address/redirect restrictions, time/body limits, and honest error reporting. |
| V2-08 | Research evidence | Maintain source and claim records, retrieve primary evidence where available, compare independent sources, identify contradictions, and produce citations that resolve to retrieved content. Report uncertainty or unavailable evidence rather than inventing support. |
| V2-09 | Browser work | Navigate, inspect accessibility/DOM state, click, type, wait, capture screenshots, and handle controlled downloads in a session-isolated browser. Require explicit permission for sensitive/external submissions or data transfer. |
| V2-10 | Permissions and trust | Normalize first-party, custom, and MCP actions into application policy. Check exact action/arguments/resources, bind decisions to current requests, and enforce deny-by-default for unsupported capabilities. Repository hooks and installed skills require explicit trust. |
| V2-11 | Durability and recovery | Preserve plans, decisions, evidence, and runtime identity across restart. Record action intent/outcomes. Stop on unknown side effects until reconciled; do not silently repeat them or reuse stale approvals. |
| V2-12 | Context and resource controls | Let the runtime own model context and compaction. Preserve application goals/evidence independently. Bound active time, steps/replans, tool concurrency/output, and configured token/currency spending with explicit enforcement and overshoot semantics. Count auxiliary model calls, not only visible turns. |
| V2-13 | Artifacts and result retrieval | Provide session-scoped artifact/result IDs and bounded pagination for the model and human. Preserve provenance and complete outputs outside prompts. Distinguish completed, partial, failed, cancelled, and recovery-required work. |
| V2-14 | Skills and integrations | Supply a small reviewed local skill set for coding, research, and browser work. Support custom tools and explicitly trusted no-auth MCP servers through the same controls. Load capabilities selectively; do not automatically install marketplace content. |
| V2-15 | UI, API, and auditability | Keep a documented headless API and application-owned events. Show the plan, current action, permission scope, usage, blockers, evidence, and results in the TUI. Keep correlated, redacted local records; external telemetry is opt-in. |
| V2-16 | Migration, packaging, and evaluation | Preserve the MVP baseline, version data/configuration, package the Windows application with its compatible runtime, and evaluate coding/research/browser outcomes plus negative safety/recovery cases before making V2 the default. |

## Capability and Tool Matrix

These are application capability contracts, not promises of identical tool names across models or SDK releases. Prefer suitable runtime tools where their policy and evidence contracts can be enforced. Otherwise provide controlled application tools and disable overlapping uncontrolled tools.

| Capability pack | Minimum operations | Important boundary |
|---|---|---|
| Workspace | List directories; glob; bounded text search; line-range reads; create files; apply precise edits; inspect diffs. | No blanket extension bypass that admits secrets or binaries. A patch deleting a file is destructive and must be identified as such. |
| Execution | Start a bounded process, obtain status/output/exit code, cancel it, and inspect persisted results. | Execute in a proved isolated environment, not the host merely because the user approved a command. |
| Git | Status, diff, and log. | Inspection only in the initial V2 contract. Repository mutation is not implicitly authorized by coding work. |
| Web | Search; fetch; readable extraction; source registration. | Query terms and retrieved text can contain sensitive data. Approved network access is not permission to export workspace contents. |
| Browser | Navigate; snapshot; click; type; wait; screenshot; download inspection. | Clean per-session browser context, no implicit personal cookies, credentials, or unrestricted script execution. |
| Work state | Inspect/update a plan; track steps/evidence; ask clarification; record blockers. | Extend runtime planning with product evidence rather than introducing a second competing planner. |
| Results | Register/read artifacts; retrieve paged prior tool results; inspect provenance. | Revisit recorded results without replaying the action that produced them. |

## Permission Modes

| Mode or grant | Intended behavior |
|---|---|
| Approval-first default | Ask before document/source-content access, edits, commands, and external tool actions according to the existing conservative policy. Metadata listing may remain non-content access. |
| Read-only capability restriction | Disable modifications, commands, and submissions. This restriction does not itself grant automatic reading. |
| Explicit trusted-read grant | Allow bounded reads in selected paths and retrieval from approved public domains for the declared lifetime. The user must deliberately enable the grant; no permanent/global approval is inferred. |
| Exact action approval | Bind approval to the current tool identity, arguments, resource scope, request revision, and relevant preconditions. Changed actions require a new decision. |

Writes, process execution, destructive actions, uploads, and external submissions remain separately controlled even when trusted reads are enabled. Autonomy means continuing authorized work; it does not mean bypassing permission prompts.

A process grant must disclose its effective filesystem/network authority, not merely its executable name. No scope grant makes unsafe repository hooks, downloaded code, or prompt-injected instructions trustworthy.

## Reference Outcomes and Acceptance Scenarios

| ID | Scenario | Required evidence |
|---|---|---|
| A01 | Runtime integration | The selected SDK/runtime works with the configured BYOK endpoint/model on Windows, exposes only approved tools, reports usage, and supports create/stop/resume without credential leakage or silent provider fallback. |
| A02 | Coding | In a disposable repository, reproduce a failing test, inspect relevant source, make a focused patch, run the relevant checks in isolation, and present the diff and exit/test results. Denied execution or edits produce no effect; unrelated user changes are preserved. |
| A03 | Research | Use a deterministic fixture with at least three sources, two independent origins, and a conflicting claim. Retrieve source content, produce a report with resolvable evidence references, flag the conflict, and distinguish retrieval time from publication time. This fixture is not a universal minimum source count for every question. |
| A04 | Browser | Complete a deterministic test-site task using page observations and actions, preserve screenshot/download provenance, and pause before an external or sensitive submission. Denial prevents it, and another session cannot access the first session's browser state. |
| A05 | Planning and recovery | Show steps and verification evidence, handle a blocked step and bounded replanning, quit at a permission request, and resume correctly. Cancellation and process death do not cause duplicate external actions or invalid conversation history. |
| A06 | Permission and isolation failures | Prove boundary enforcement for protected/out-of-scope files, unapproved destinations, malicious page/tool/repository instructions, hooks, and command attempts to read host secrets or escape execution scope. Unknown actions fail closed. |
| A07 | Resource enforcement | Trigger each configured limit and verify explicit stop reasons, preserved accounting across resume, actual concurrency control, auxiliary-call accounting, bounded output retrieval, and no success-shaped fallback on unknown usage. |
| A08 | Product continuity and distribution | Verify two independent terminals, same-session exclusion, TUI input/approval/result inspection, legacy-history preservation, a clean package install, no secret files in the package, and clear native-terminal verification records. |

Each acceptance scenario must include negative cases, not only a successful model demonstration. Synthetic/offline fixtures cover routine regression; real model/search/browser integrations are separately recorded and explicitly authorized where credentials, network access, or costs are involved.

## Deferred Scope

- Agent fleets, cross-session delegation, and multi-session dashboards.
- Scheduling, detached workers, cloud-hosted sessions, and additional UI clients.
- Automatic model/provider fallback, broad multi-provider routing, and account-pool selection.
- Personal browser profiles, credential capture, OAuth/service-account administration, and broad enterprise connectors.
- Automatic marketplace installation, unreviewed plugins, and unrestricted repository hook discovery.
- General office-document conversion, arbitrary desktop computer use, and support for every programming toolchain.
- Automatic Git commits/pushes, destructive repository management, and general-purpose action undo.
- A graph editor, LangGraph orchestration layer, vector database, or long-term personalization store without a demonstrated requirement.

Reviewed skills, bounded parallel tool work, and persistent task evidence are in scope; autonomous multi-agent fleets are not needed to make these workflows useful.

## Release Meaning

V2 is implemented when all mandatory requirements have code and evidence, not when a generic chat or one file edit works. All A01-A08 scenarios must have recorded outcomes. Missing credentials, unsupported environments, failed checks, and manual-only observations remain explicit; they are not replaced with assumptions.
